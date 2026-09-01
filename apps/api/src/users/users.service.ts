import { Injectable, NotFoundException } from "@nestjs/common";
import { decryptNumber } from "../common/crypto/field-encryption";
import { PrismaService } from "../prisma/prisma.service";
import type { ConsentDto } from "./dto/consent.dto";

export type ProfileResponse = {
  id: string;
  sex: "male" | "female" | "other";
  birth_year: number;
  height_cm: number;
  weight_kg: number;
  body_fat_pct: number | null;
  goal: "diet" | "hypertrophy" | "strength";
  experience_level: "beginner" | "intermediate" | "advanced";
  plan_tier: "free" | "pro";
};

function decodeFeedback(feedback: unknown): unknown {
  if (!feedback || typeof feedback !== "object" || Array.isArray(feedback)) return feedback;
  const record = feedback as Record<string, unknown>;
  return typeof record.pain === "string"
    ? { ...record, pain: decryptNumber(record.pain) }
    : feedback;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private async activeUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { subscription: { select: { tier: true } } },
    });
    if (!user) throw new NotFoundException("사용자를 찾을 수 없다.");
    return user;
  }

  private profile(user: Awaited<ReturnType<UsersService["activeUser"]>>): ProfileResponse {
    return {
      id: user.id,
      sex: user.sex,
      birth_year: user.birthYear,
      height_cm: Number(user.heightCm),
      weight_kg: Number(user.weightKg),
      body_fat_pct: decryptNumber(user.bodyFatPct),
      goal: user.goal,
      experience_level: user.experienceLevel,
      plan_tier: user.subscription?.tier ?? "free",
    };
  }

  async getProfile(userId: string): Promise<ProfileResponse> {
    return this.profile(await this.activeUser(userId));
  }

  async recordConsents(userId: string, consents: ConsentDto[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (!active) throw new NotFoundException("사용자를 찾을 수 없다.");
      if (consents.length) {
        await tx.consent.createMany({
          data: consents.map((consent) => ({
            userId,
            type: consent.type,
            version: consent.version,
            granted: consent.granted,
            grantedAt: new Date(),
          })),
        });
      }
      await tx.accessAudit.create({
        data: { userId, action: "consents_recorded", metadata: { count: consents.length } },
      });
    });
  }

  async exportData(userId: string): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        subscription: { select: { tier: true } },
        consents: { orderBy: { grantedAt: "asc" } },
        programs: {
          include: {
            sessions: { include: { plannedSets: { include: { performedSets: true } } } },
          },
        },
        estimated1rm: true,
        muscleWeeklyLoad: true,
        rirCalibration: true,
        calibrationSets: true,
        accessAudits: { orderBy: { occurredAt: "asc" } },
      },
    });
    if (!user) throw new NotFoundException("사용자를 찾을 수 없다.");

    // 어시스트 audit 는 user 가 아니라 planned row 에 매달려 있어 include 로는 못 따라온다.
    // 사용자의 처방 row 에 연결된 개인정보이므로 `access_audits` 와 같게 열람·이동권 범위에 넣는다.
    const assistanceAudits = await this.prisma.assistanceAudit.findMany({
      where: { plannedSet: { session: { program: { userId } } } },
      orderBy: { occurredAt: "asc" },
    });

    const profile = this.profile(user);
    const sessions = user.programs.flatMap((program) =>
      program.sessions.map((session) => ({
        ...session,
        sessionFeedback: decodeFeedback(session.sessionFeedback),
        plannedSets: session.plannedSets.map((set) => ({
          ...set,
          performedSets: set.performedSets.map((performed) => ({
            ...performed,
            painScore: decryptNumber(performed.painScore),
          })),
        })),
      })),
    );

    return {
      exported_at: new Date().toISOString(),
      profile,
      consents: user.consents.map((consent) => ({
        type: consent.type,
        version: consent.version,
        granted: consent.granted,
        granted_at: consent.grantedAt.toISOString(),
      })),
      data: {
        programs: user.programs.map(({ sessions: _sessions, ...program }) => program),
        sessions,
        estimated_1rm: user.estimated1rm,
        muscle_weekly_load: user.muscleWeeklyLoad,
        rir_calibration: user.rirCalibration,
        calibration_sets: user.calibrationSets,
        access_audits: user.accessAudits,
        assistance_audits: assistanceAudits,
      },
    };
  }

  async requestDeletion(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (!active) throw new NotFoundException("사용자를 찾을 수 없다.");
      const now = new Date();
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.accessAudit.create({
        data: { userId, action: "account_delete_requested", metadata: {} },
      });
      await tx.user.update({ where: { id: userId }, data: { deletedAt: now } });
    });
  }
}
