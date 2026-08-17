import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, type AuthSession } from "@prisma/client";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { encryptNumber } from "../common/crypto/field-encryption";
import { PrismaService } from "../prisma/prisma.service";
import type { ConsentDto } from "../users/dto/consent.dto";
import { usesDevUserAuth } from "./auth-mode";
import type { OwnerProfileDto } from "./dto/owner-auth.dto";

const OWNER_LOGIN_SCOPE = "owner-login";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const ATTEMPT_WINDOW_MS = 1000 * 60 * 15;
const LOCK_DURATION_MS = 1000 * 60 * 30;
const MAX_FAILED_ATTEMPTS = 5;
const INVALID_OWNER_CODE = "소유자 코드 또는 세션이 유효하지 않다.";

export type IssuedSession = {
  sessionToken: string;
  csrfToken: string;
};

export type ActiveSession = Pick<AuthSession, "id" | "userId" | "csrfTokenHash">;

export type AuthResult = {
  csrf_token: string;
  user: { id: string; is_new: boolean };
  session: IssuedSession;
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function nowPlus(milliseconds: number): Date {
  return new Date(Date.now() + milliseconds);
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (!usesDevUserAuth()) this.ownerCode();
  }

  private ownerCode(): string {
    const code = process.env.OWNER_RECOVERY_CODE;
    if (!code || Buffer.byteLength(code, "utf8") < 32) {
      throw new Error(
        "OWNER_RECOVERY_CODE 는 32바이트 이상인 무작위 비밀값이어야 한다(Secret Manager에서만 주입).",
      );
    }
    return code;
  }

  private attemptBucketHash(): string {
    // 프록시 헤더를 신뢰하지 않아도 되는 단일 계정의 전역 버킷이다. 원문 코드·IP는 DB에 남지 않는다.
    return createHmac("sha256", this.ownerCode()).update(OWNER_LOGIN_SCOPE).digest("hex");
  }

  private async assertNotRateLimited(): Promise<void> {
    const attempt = await this.prisma.authAttempt.findUnique({
      where: {
        scope_bucketHash: { scope: OWNER_LOGIN_SCOPE, bucketHash: this.attemptBucketHash() },
      },
    });
    if (attempt?.lockedUntil && attempt.lockedUntil > new Date()) {
      throw new UnauthorizedException(INVALID_OWNER_CODE);
    }
  }

  private async recordFailedAttempt(): Promise<void> {
    const now = new Date();
    const bucketHash = this.attemptBucketHash();
    const attempt = await this.prisma.authAttempt.upsert({
      where: { scope_bucketHash: { scope: OWNER_LOGIN_SCOPE, bucketHash } },
      create: {
        scope: OWNER_LOGIN_SCOPE,
        bucketHash,
        attemptCount: 1,
        windowStartedAt: now,
      },
      update: { attemptCount: { increment: 1 } },
    });

    const expiredWindow = attempt.windowStartedAt.getTime() <= now.getTime() - ATTEMPT_WINDOW_MS;
    const attemptCount = expiredWindow ? 1 : attempt.attemptCount;
    await this.prisma.authAttempt.update({
      where: { id: attempt.id },
      data: {
        attemptCount,
        windowStartedAt: expiredWindow ? now : attempt.windowStartedAt,
        lockedUntil: attemptCount >= MAX_FAILED_ATTEMPTS ? nowPlus(LOCK_DURATION_MS) : null,
      },
    });
  }

  private async validateOwnerCode(candidate: string): Promise<void> {
    await this.assertNotRateLimited();
    if (!constantTimeEquals(this.ownerCode(), candidate)) {
      await this.recordFailedAttempt();
      throw new UnauthorizedException(INVALID_OWNER_CODE);
    }
    await this.prisma.authAttempt.deleteMany({
      where: { scope: OWNER_LOGIN_SCOPE, bucketHash: this.attemptBucketHash() },
    });
  }

  private issuedSession(): IssuedSession {
    return { sessionToken: randomToken(), csrfToken: randomToken() };
  }

  private async createSession(
    tx: Prisma.TransactionClient,
    userId: string,
    issued: IssuedSession,
  ): Promise<void> {
    await tx.authSession.create({
      data: {
        userId,
        sessionTokenHash: tokenHash(issued.sessionToken),
        csrfTokenHash: tokenHash(issued.csrfToken),
        expiresAt: nowPlus(SESSION_TTL_MS),
      },
    });
  }

  async bootstrap(
    profile: OwnerProfileDto,
    consents: ConsentDto[],
    ownerCode: string,
  ): Promise<AuthResult> {
    await this.validateOwnerCode(ownerCode);
    if (!consents.some((consent) => consent.type === "privacy_collection" && consent.granted)) {
      throw new BadRequestException("개인정보 수집·이용 동의가 필요하다.");
    }

    const issued = this.issuedSession();
    const user = await this.prisma.$transaction(async (tx) => {
      const ownerAlreadyExists = await tx.user.findFirst({ where: { role: "admin" } });
      if (ownerAlreadyExists) {
        throw new ConflictException("이미 소유자 계정이 등록되어 있다.");
      }
      const created = await tx.user.create({
        data: {
          role: "admin",
          sex: profile.sex,
          birthYear: profile.birth_year,
          heightCm: profile.height_cm,
          weightKg: profile.weight_kg,
          bodyFatPct: encryptNumber(profile.body_fat_pct ?? null),
          goal: profile.goal,
          experienceLevel: profile.experience_level,
          constraints: {},
          consents: {
            create: consents.map((consent) => ({
              type: consent.type,
              version: consent.version,
              granted: consent.granted,
              grantedAt: new Date(),
            })),
          },
        },
      });
      await this.createSession(tx, created.id, issued);
      await tx.accessAudit.create({
        data: { userId: created.id, action: "owner_bootstrap_succeeded", metadata: {} },
      });
      return created;
    });

    return { csrf_token: issued.csrfToken, user: { id: user.id, is_new: true }, session: issued };
  }

  async login(ownerCode: string): Promise<AuthResult> {
    await this.validateOwnerCode(ownerCode);
    const owner = await this.prisma.user.findFirst({
      where: { role: "admin", deletedAt: null },
      select: { id: true },
    });
    if (!owner) throw new UnauthorizedException(INVALID_OWNER_CODE);

    const issued = this.issuedSession();
    await this.prisma.$transaction(async (tx) => {
      await this.createSession(tx, owner.id, issued);
      await tx.accessAudit.create({
        data: { userId: owner.id, action: "owner_login_succeeded", metadata: {} },
      });
    });
    return { csrf_token: issued.csrfToken, user: { id: owner.id, is_new: false }, session: issued };
  }

  async findActiveSession(sessionToken: string): Promise<ActiveSession | null> {
    return this.prisma.authSession.findFirst({
      where: {
        sessionTokenHash: tokenHash(sessionToken),
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { is: { deletedAt: null } },
      },
      select: { id: true, userId: true, csrfTokenHash: true },
    });
  }

  csrfMatches(expectedHash: string, suppliedToken: string): boolean {
    return constantTimeEquals(expectedHash, tokenHash(suppliedToken));
  }

  async rotateSession(sessionId: string): Promise<string> {
    const sessionToken = randomToken();
    const updated = await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { sessionTokenHash: tokenHash(sessionToken), expiresAt: nowPlus(SESSION_TTL_MS) },
    });
    if (updated.count !== 1) throw new UnauthorizedException(INVALID_OWNER_CODE);
    // CSRF 토큰은 이 세션 수명 동안 유지한다. refresh 204 뒤 클라이언트 토큰을 잃지 않게 한다.
    return sessionToken;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
