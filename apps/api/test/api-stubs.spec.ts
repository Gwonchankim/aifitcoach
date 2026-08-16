/**
 * 스텁 응답 통합 테스트: 스텁 라우트와 구현된 sync 라우트의 DTO 검증을 고정한다.
 * DTO 검증(ValidationPipe)이 붙어 있는지 확인한다.
 */
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
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

  it("POST /v1/sync (없는 논리 엔터티) → 200 conflict", async () => {
    // 유효 요청은 sync_mutations에 멱등 키를 남긴다. 고정 UUID면 로컬 재실행이 이전 실행과 충돌한다.
    const clientId = randomUUID();
    const entityId = randomUUID();
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [
          {
            client_id: clientId,
            entity: "performed_set",
            entity_id: entityId,
            op: "upsert",
            updated_at: "2026-08-15T08:00:00.000Z",
            payload: { actual_reps: 9 },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.conflicts).toEqual([
      expect.objectContaining({
        entity_id: entityId,
        reason: "not_found",
      }),
    ]);
  });

  it.each(["entity_id", "updated_at"])(
    "POST /v1/sync (%s 누락) → 400 + VALIDATION_ERROR",
    async (missing) => {
      const mutation: Record<string, unknown> = {
        client_id: "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
        entity: "performed_set",
        entity_id: "7d410e45-f83e-4951-82c7-c2cf6a09d536",
        op: "upsert",
        updated_at: "2026-08-15T08:00:00.000Z",
        payload: { actual_reps: 9 },
      };
      delete mutation[missing];

      const response = await request(app.getHttpServer())
        .post("/v1/sync")
        .send({ mutations: [mutation] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.message).toContain(missing);
    },
  );

  it("POST /v1/sync (profile entity) → 400 — ADR-33 로컬 전용", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({
        mutations: [
          {
            client_id: "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
            entity: "profile",
            entity_id: "7d410e45-f83e-4951-82c7-c2cf6a09d536",
            op: "upsert",
            updated_at: "2026-08-15T08:00:00.000Z",
            payload: {},
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
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
