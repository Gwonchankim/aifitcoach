/** PIPA 최소 기능: 내 정보 열람·동의 이력·JSON 내보내기·즉시 접근 차단. */
import type { INestApplication } from "@nestjs/common";
import { createHash } from "node:crypto";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { encryptNumber } from "../src/common/crypto/field-encryption";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();

describe("PIPA 내 정보 API", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetUserData(prisma, USER_ID);
    await prisma.accessAudit.deleteMany({ where: { userId: USER_ID } });
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.consent.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.update({
      where: { id: USER_ID },
      data: { deletedAt: null, bodyFatPct: encryptNumber(21.5) },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await resetUserData(prisma, USER_ID);
      await prisma.accessAudit.deleteMany({ where: { userId: USER_ID } });
      await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
      await prisma.consent.deleteMany({ where: { userId: USER_ID } });
      await prisma.user.update({
        where: { id: USER_ID },
        data: { deletedAt: null, bodyFatPct: null },
      });
    }
    await app?.close();
  });

  it("암호화된 프로필은 평문으로 열람·동의 기록·기계 판독 JSON으로 내보낸다", async () => {
    const profile = await request(app.getHttpServer()).get("/v1/me").expect(200);
    expect(profile.body).toMatchObject({ id: USER_ID, body_fat_pct: 21.5, plan_tier: "free" });
    expect(profile.text).not.toContain("v1:");

    await request(app.getHttpServer())
      .post("/v1/me/consents")
      .send([{ type: "privacy_collection", version: "2026-08-17-draft", granted: true }])
      .expect(204);

    const exported = await request(app.getHttpServer()).get("/v1/me/export").expect(200);
    expect(exported.body).toMatchObject({
      exported_at: expect.any(String),
      profile: { id: USER_ID, body_fat_pct: 21.5 },
      consents: [expect.objectContaining({ type: "privacy_collection", granted: true })],
      data: { programs: expect.any(Array), sessions: expect.any(Array) },
    });
    expect(exported.text).not.toContain("v1:");
  });

  it("삭제 요청은 모든 세션을 revoke하고 soft delete로 즉시 접근을 막는다", async () => {
    const session = await prisma.authSession.create({
      data: {
        userId: USER_ID,
        sessionTokenHash: createHash("sha256").update("delete-test-session").digest("hex"),
        csrfTokenHash: createHash("sha256").update("delete-test-csrf").digest("hex"),
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });

    await request(app.getHttpServer()).delete("/v1/me").expect(202);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: USER_ID } })).resolves.toMatchObject({
      deletedAt: expect.any(Date),
    });
    await expect(
      prisma.authSession.findUniqueOrThrow({ where: { id: session.id } }),
    ).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    });
    await expect(
      prisma.accessAudit.findFirst({
        where: { userId: USER_ID, action: "account_delete_requested" },
      }),
    ).resolves.toBeTruthy();
  });
});
