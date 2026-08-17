/**
 * 인증 저장소의 최소 불변식.
 *
 * 원문 세션 토큰·CSRF 토큰·소유자 복구 코드는 DB에 절대 저장하지 않는다. 이 테스트는
 * 해시만 유일키로 저장되고, 세션·로그인 시도·감사 이벤트가 소유자와 분리되지 않음을 고정한다.
 */
import type { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp } from "./support/app";
import { testUserId } from "./support/users";

const USER_ID = testUserId("tenancy");

describe("인증 저장소", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.accessAudit.deleteMany({ where: { userId: USER_ID } });
      await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
      await prisma.authAttempt.deleteMany({ where: { scope: "owner-login:test" } });
      await prisma.user.deleteMany({ where: { id: USER_ID } });
    }
    await app?.close();
  });

  it("소유자 역할·해시 세션·로그인 시도·감사 이벤트를 관계로 보존한다", async () => {
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { role: "admin", deletedAt: null },
      create: {
        id: USER_ID,
        role: "admin",
        sex: "other",
        birthYear: 1990,
        heightCm: 175,
        weightKg: 70,
        goal: "hypertrophy",
        experienceLevel: "intermediate",
        constraints: {},
      },
    });

    const session = await prisma.authSession.create({
      data: {
        userId: USER_ID,
        sessionTokenHash: "sha256:test-session-token",
        csrfTokenHash: "sha256:test-csrf-token",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await prisma.authAttempt.create({
      data: {
        scope: "owner-login:test",
        bucketHash: "hmac:test-client-bucket",
        attemptCount: 1,
        windowStartedAt: new Date("2026-08-17T00:00:00.000Z"),
      },
    });
    await prisma.accessAudit.create({
      data: { userId: USER_ID, action: "owner_login_succeeded", metadata: {} },
    });

    await expect(
      prisma.authSession.create({
        data: {
          userId: USER_ID,
          sessionTokenHash: "sha256:test-session-token",
          csrfTokenHash: "sha256:another-csrf-token",
          expiresAt: new Date("2026-09-02T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      prisma.authAttempt.create({
        data: {
          scope: "owner-login:test",
          bucketHash: "hmac:test-client-bucket",
          attemptCount: 2,
          windowStartedAt: new Date("2026-08-17T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: USER_ID },
      include: { authSessions: true, accessAudits: true },
    });
    expect(owner.role).toBe("admin");
    expect(owner.deletedAt).toBeNull();
    expect(owner.authSessions).toHaveLength(1);
    expect(owner.authSessions[0]).toMatchObject({ id: session.id, revokedAt: null });
    expect(owner.accessAudits).toHaveLength(1);
  });
});
