/**
 * Sprint 0에서 서로 다른 미구현 경계를 red로 증명한 뒤 Sprint 2 일반 게이트로 승격한 계약 테스트.
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

describe("M-4′ 서버 계약", () => {
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

  it("analytics volume은 주별 projector 결과와 목표별 권장 범위를 200으로 반환한다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const response = await request(app.getHttpServer())
      .get("/v1/analytics/volume")
      .query({ weeks: 2 })
      .expect(200);
    expectMatchesContract("get", "/analytics/volume", 200, response.body);
    expect(response.body).toMatchObject({
      goal: "hypertrophy",
      recommendation_range: { min_hard_sets: 10, max_hard_sets: 20 },
    });
    expect(response.body.weeks).toHaveLength(2);
  });

  it("analytics completion은 lazy 세션과 미래 template preview를 7일 안정 정렬한다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(BASE).expect(201);
    const response = await request(app.getHttpServer())
      .get("/v1/analytics/completion")
      .query({ weeks: 1 })
      .expect(200);
    expectMatchesContract("get", "/analytics/completion", 200, response.body);
    expect(response.body.weeks).toHaveLength(1);
    expect(response.body.weeks[0].days).toHaveLength(7);
    expect(response.body.weeks[0].days.map((day: { date: string }) => day.date)).toEqual(
      [...response.body.weeks[0].days]
        .map((day: { date: string }) => day.date)
        .sort((left: string, right: string) => left.localeCompare(right)),
    );
  });
});
