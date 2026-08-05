/**
 * 스텁 응답 통합 테스트: 라우트가 실제로 호출되고 501 + 에러 엔벨로프를 돌려주는지,
 * DTO 검증(ValidationPipe)이 붙어 있는지 확인한다.
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";

describe("스텁 엔드포인트", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("GET /v1/subscriptions/status → 501 + 에러 엔벨로프", async () => {
    const response = await request(app.getHttpServer()).get("/v1/subscriptions/status");

    expect(response.status).toBe(501);
    expect(response.body).toEqual({
      error: { code: "NOT_IMPLEMENTED", message: expect.any(String) },
    });
  });

  it("POST /v1/sync (유효한 바디) → 501 + 에러 엔벨로프", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [
          {
            client_id: "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
            entity: "performed_set",
            op: "upsert",
            payload: { planned_set_id: "ps_5", actual_reps: 9 },
          },
        ],
      });

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("POST /v1/programs/generate (필수 필드 누락) → 400 + VALIDATION_ERROR", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ goal: "hypertrophy" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.message).toContain("days_per_week");
  });

  /**
   * 최상위 JSON 배열 바디(POST /me/consents)는 전역 ValidationPipe 가 건너뛴다
   * (metatype === Array) → 라우트에서 배열 요소까지 검증하는지 회귀 테스트로 고정한다.
   */
  describe("POST /v1/me/consents (최상위 배열 바디 검증)", () => {
    it("요소 필드 위반 → 400 + VALIDATION_ERROR", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/me/consents")
        .send([{ bogus: 1 }]);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: "VALIDATION_ERROR", message: expect.any(String) },
      });
      expect(response.body.error.message).toContain("type");
    });

    it("배열이 아닌 바디 → 400 + VALIDATION_ERROR", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/me/consents")
        .send({ not: "an array" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("빈 바디 → 400 + VALIDATION_ERROR (requestBody required: true)", async () => {
      const response = await request(app.getHttpServer()).post("/v1/me/consents");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("올바른 바디 → 501 (스텁)", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/me/consents")
        .send([{ type: "privacy", version: "1.0", granted: true }]);

      expect(response.status).toBe(501);
      expect(response.body.error.code).toBe("NOT_IMPLEMENTED");
    });

    it("빈 배열 → 501 (openapi 에 minItems 가 없으므로 계약상 유효)", async () => {
      const response = await request(app.getHttpServer()).post("/v1/me/consents").send([]);

      expect(response.status).toBe(501);
      expect(response.body.error.code).toBe("NOT_IMPLEMENTED");
    });
  });
});
