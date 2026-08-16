/**
 * Sprint 0의 의도적 red suite. `pnpm --filter api test:red:m4`로만 실행한다.
 * Sprint 1에서 production 계약 테스트로 승격하기 전까지 현재 구현의 서로 다른 미구현 경계를 증명한다.
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
const BASE = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
};

describe("M-4′ Sprint 0 red", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) await resetUserData(prisma, USER_ID);
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  async function seedAndLocateTodaySession(): Promise<string> {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const dashboard = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
    expect(dashboard.body.today.session_id).toEqual(expect.any(String));
    return dashboard.body.today.session_id as string;
  }

  it("Program 200/201 응답은 12주 lazy lifecycle 필드를 만족해야 한다", async () => {
    const response = await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE);
    expectMatchesContract("post", "/programs/generate", 201, response.body);
  });

  it("Session 200 응답은 각 planned set의 실제 수행값 nullable 키를 만족해야 한다", async () => {
    const sessionId = await seedAndLocateTodaySession();
    const response = await request(app.getHttpServer())
      .get(`/v1/sessions/${sessionId}`)
      .expect(200);
    expectMatchesContract("get", "/sessions/{sessionId}", 200, response.body);
  });

  it("Dashboard 200 응답은 weekly rhythm과 서버 권위 e1RM gate를 만족해야 한다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const response = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
    expectMatchesContract("get", "/dashboard", 200, response.body);
  });

  it("analytics e1rm은 501이 아니라 게이트된 200 응답이어야 한다", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/analytics/e1rm")
      .query({ exercise_id: "e_bench_press" });
    expect(response.status).toBe(200);
    expectMatchesContract("get", "/analytics/e1rm", 200, response.body);
  });
});
