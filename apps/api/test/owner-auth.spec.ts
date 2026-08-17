/**
 * 단일 소유자 인증의 HTTP 경계 테스트.
 *
 * 이 spec은 dev-user 모드를 명시적으로 끄고, 실제 cookie/session/CSRF 경로만 검증한다.
 * 소유자 코드는 응답·DB·로그에 나타나면 안 된다.
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { createHash } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { testUserId } from "./support/users";

const OWNER_ID = testUserId("auth");
const OTHER_USER_ID = testUserId("auth-other");
const OWNER_CODE = "test-owner-recovery-code-at-least-thirty-two-characters-long";
const OTHER_SESSION_TOKEN = "test-other-user-session-token-that-is-not-a-secret";
const BOOTSTRAP = {
  owner_code: OWNER_CODE,
  profile: {
    sex: "other",
    birth_year: 1990,
    height_cm: 175,
    weight_kg: 70,
    body_fat_pct: null,
    goal: "hypertrophy",
    experience_level: "intermediate",
  },
  consents: [{ type: "privacy_collection", version: "2026-08-17-draft", granted: true }],
};

function sidCookie(response: request.Response): string {
  const cookies = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = cookies?.find((value) => value.startsWith("sid="));
  if (!cookie) throw new Error("sid cookie was not issued");
  return cookie.split(";", 1)[0];
}

describe("소유자 코드 인증", () => {
  const original = {
    authMode: process.env.AUTH_MODE,
    ownerCode: process.env.OWNER_RECOVERY_CODE,
  };
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerId: string | undefined;

  beforeAll(async () => {
    process.env.AUTH_MODE = "session";
    process.env.OWNER_RECOVERY_CODE = OWNER_CODE;
    app = await createTestApp();
    prisma = app.get(PrismaService);
    // afc_test에 남은 이전 실패의 admin만 정리한다. 일반 dev-user/다른 통합 테스트 사용자는 건드리지 않는다.
    const existingOwners = await prisma.user.findMany({
      where: { role: "admin" },
      select: { id: true },
    });
    const existingOwnerIds = existingOwners.map((owner) => owner.id);
    if (existingOwnerIds.length) {
      await resetUserData(prisma, ...existingOwnerIds);
      await prisma.accessAudit.deleteMany({ where: { userId: { in: existingOwnerIds } } });
      await prisma.authSession.deleteMany({ where: { userId: { in: existingOwnerIds } } });
      await prisma.consent.deleteMany({ where: { userId: { in: existingOwnerIds } } });
      await prisma.user.deleteMany({ where: { id: { in: existingOwnerIds } } });
    }
    await prisma.user.deleteMany({ where: { id: OWNER_ID } });
    await prisma.authSession.deleteMany({ where: { userId: OTHER_USER_ID } });
    await prisma.user.deleteMany({ where: { id: OTHER_USER_ID } });
    await prisma.authAttempt.deleteMany({ where: { scope: "owner-login" } });
  });

  afterAll(async () => {
    if (prisma) {
      if (ownerId) {
        await resetUserData(prisma, ownerId);
        await prisma.accessAudit.deleteMany({ where: { userId: ownerId } });
        await prisma.authSession.deleteMany({ where: { userId: ownerId } });
        await prisma.consent.deleteMany({ where: { userId: ownerId } });
        await prisma.user.deleteMany({ where: { id: ownerId } });
      }
      await resetUserData(prisma, OTHER_USER_ID);
      await prisma.accessAudit.deleteMany({ where: { userId: OTHER_USER_ID } });
      await prisma.authSession.deleteMany({ where: { userId: OTHER_USER_ID } });
      await prisma.consent.deleteMany({ where: { userId: OTHER_USER_ID } });
      await prisma.user.deleteMany({ where: { id: OTHER_USER_ID } });
      await prisma.authAttempt.deleteMany({ where: { scope: "owner-login" } });
    }
    await app?.close();
    if (original.authMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = original.authMode;
    if (original.ownerCode === undefined) delete process.env.OWNER_RECOVERY_CODE;
    else process.env.OWNER_RECOVERY_CODE = original.ownerCode;
  });

  it("최초 등록은 admin·동의·httpOnly 세션을 원자 생성하고 CSRF 없는 변경은 막는다", async () => {
    const bootstrap = await request(app.getHttpServer())
      .post("/v1/auth/owner/bootstrap")
      .send(BOOTSTRAP)
      .expect(201);

    expect(bootstrap.body).toMatchObject({
      csrf_token: expect.any(String),
      user: { is_new: true },
    });
    ownerId = bootstrap.body.user.id as string;
    expect(bootstrap.text).not.toContain(OWNER_CODE);
    const issuedCookie = sidCookie(bootstrap);
    const rawSetCookie = bootstrap.headers["set-cookie"] as unknown as string[];
    expect(issuedCookie).toMatch(/^sid=/);
    expect(rawSetCookie).toEqual(expect.arrayContaining([expect.stringContaining("HttpOnly")]));
    expect(rawSetCookie).toEqual(expect.arrayContaining([expect.stringContaining("SameSite=Lax")]));
    expect(rawSetCookie).toEqual(
      expect.arrayContaining([expect.stringMatching(/^csrf=.*;.*SameSite=Lax/)]),
    );
    expect(
      rawSetCookie.some((cookie) => cookie.startsWith("csrf=") && cookie.includes("HttpOnly")),
    ).toBe(false);
    const sid = sidCookie(bootstrap);
    const csrf = bootstrap.body.csrf_token as string;

    await request(app.getHttpServer()).get("/v1/dashboard").expect(401);
    await request(app.getHttpServer()).get("/v1/dashboard").set("Cookie", sid).expect(200);

    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .set("Cookie", sid)
      .send({
        goal: "hypertrophy",
        days_per_week: 3,
        minutes_per_day: 60,
        experience_level: "intermediate",
      })
      .expect(401);

    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .set("Cookie", sid)
      .set("X-CSRF-Token", csrf)
      .send({
        goal: "hypertrophy",
        days_per_week: 3,
        minutes_per_day: 60,
        experience_level: "intermediate",
      })
      .expect(201);

    if (!ownerId) throw new Error("bootstrap did not return an owner id");
    const foreignProgram = await prisma.program.create({
      data: {
        userId: ownerId,
        goal: "hypertrophy",
        daysPerWeek: 3,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
      },
    });
    const ownerSession = await prisma.workoutSession.create({
      data: {
        programId: foreignProgram.id,
        scheduledDate: new Date("2026-08-17T00:00:00.000Z"),
        focus: "upper",
        status: "scheduled",
      },
    });
    await prisma.user.create({
      data: {
        id: OTHER_USER_ID,
        role: "user",
        sex: "other",
        birthYear: 1991,
        heightCm: 176,
        weightKg: 71,
        goal: "hypertrophy",
        experienceLevel: "intermediate",
        constraints: {},
      },
    });
    await prisma.authSession.create({
      data: {
        userId: OTHER_USER_ID,
        sessionTokenHash: createHash("sha256").update(OTHER_SESSION_TOKEN).digest("hex"),
        csrfTokenHash: createHash("sha256").update("other-csrf").digest("hex"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    await request(app.getHttpServer())
      .get(`/v1/sessions/${ownerSession.id}`)
      .set("Cookie", `sid=${OTHER_SESSION_TOKEN}`)
      .expect(404);

    const owner = await prisma.user.findFirstOrThrow({ where: { role: "admin", deletedAt: null } });
    expect(owner.id).toBe(ownerId);
    await expect(
      prisma.authSession.findFirstOrThrow({ where: { userId: owner.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(prisma.consent.findMany({ where: { userId: owner.id } })).resolves.toEqual([
      expect.objectContaining({ type: "privacy_collection", granted: true }),
    ]);
  });

  it("재로그인·로그아웃은 세션을 교체·무효화하며 실패한 코드는 대입 잠금으로 이어진다", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post("/v1/auth/owner/login")
        .send({ owner_code: "wrong-owner-code-that-is-long-enough-to-pass-shape-validation" })
        .expect(401);
      expect(response.text).not.toContain("wrong-owner-code");
    }
    await request(app.getHttpServer())
      .post("/v1/auth/owner/login")
      .send({ owner_code: OWNER_CODE })
      .expect(401);

    await prisma.authAttempt.deleteMany({ where: { scope: "owner-login" } });
    const login = await request(app.getHttpServer())
      .post("/v1/auth/owner/login")
      .send({ owner_code: OWNER_CODE })
      .expect(200);
    const sid = sidCookie(login);
    const csrf = login.body.csrf_token as string;

    const refreshed = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .set("Cookie", sid)
      .set("X-CSRF-Token", csrf)
      .expect(204);
    const rotatedSid = sidCookie(refreshed);
    expect(rotatedSid).not.toBe(sid);

    await request(app.getHttpServer())
      .post("/v1/auth/logout")
      .set("Cookie", rotatedSid)
      .set("X-CSRF-Token", csrf)
      .expect(204);
    await request(app.getHttpServer()).get("/v1/dashboard").set("Cookie", rotatedSid).expect(401);
  });
});
