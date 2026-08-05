/**
 * 통합 테스트: CORS. (qa 브라우저 E2E blocker D-1 재현 — CORS 가 없으면 웹앱이 API 를 전혀 못 부른다.)
 *
 * 검증 계약:
 * - 허용 origin 은 `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials: true` 를 받는다.
 * - 프리플라이트(OPTIONS)는 204 로 통과하고 허용 헤더에 `X-CSRF-Token` 이 있다(변경 요청 필수 헤더).
 * - 허용목록 밖 origin 은 `Access-Control-Allow-Origin` 을 받지 못한다(와일드카드 반사 금지).
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { allowedOrigins, DEFAULT_WEB_ORIGIN } from "../src/common/http/cors";
import { createTestApp } from "./support/app";

const ALLOWED = "http://localhost:3000";
const ALSO_ALLOWED = "https://afc-preview.example.com";
const DENIED = "https://evil.example.com";

describe("CORS", () => {
  const originalWebOrigin = process.env.WEB_ORIGIN;
  let app: INestApplication;

  beforeAll(async () => {
    process.env.WEB_ORIGIN = `${ALLOWED},${ALSO_ALLOWED}`;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (originalWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = originalWebOrigin;
  });

  it("허용 origin 의 GET /v1/dashboard 는 ACAO + credentials 헤더를 받는다", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/dashboard")
      .set("Origin", ALLOWED)
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("쉼표로 넘긴 두 번째 origin 도 허용한다", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/dashboard")
      .set("Origin", ALSO_ALLOWED)
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe(ALSO_ALLOWED);
  });

  it("POST 프리플라이트가 204 로 통과하고 x-csrf-token 을 허용한다", async () => {
    const response = await request(app.getHttpServer())
      .options("/v1/programs/generate")
      .set("Origin", ALLOWED)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-csrf-token")
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"].toLowerCase()).toContain(
      "x-csrf-token",
    );
    expect(response.headers["access-control-allow-headers"].toLowerCase()).toContain(
      "content-type",
    );
  });

  it("DELETE·PATCH 프리플라이트도 허용한다(세션 편집·프로그램 수정)", async () => {
    const cases: [string, string][] = [
      ["DELETE", "/v1/sessions/00000000-0000-4000-8000-0000000000ff/exercises/1"],
      ["PATCH", "/v1/programs/00000000-0000-4000-8000-0000000000ff"],
    ];

    for (const [method, path] of cases) {
      const response = await request(app.getHttpServer())
        .options(path)
        .set("Origin", ALLOWED)
        .set("Access-Control-Request-Method", method)
        .expect(204);

      expect(response.headers["access-control-allow-methods"]).toContain(method);
    }
  });

  it("허용목록 밖 origin 은 ACAO 를 받지 못한다(요청·프리플라이트 모두)", async () => {
    const get = await request(app.getHttpServer()).get("/v1/dashboard").set("Origin", DENIED);
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();

    const preflight = await request(app.getHttpServer())
      .options("/v1/programs/generate")
      .set("Origin", DENIED)
      .set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("allowedOrigins", () => {
  const original = process.env.WEB_ORIGIN;

  afterEach(() => {
    if (original === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = original;
  });

  it("미설정이면 로컬 프론트가 기본값이다", () => {
    delete process.env.WEB_ORIGIN;

    expect(allowedOrigins()).toEqual([DEFAULT_WEB_ORIGIN]);
  });

  it("쉼표 목록을 공백 제거해 파싱한다", () => {
    process.env.WEB_ORIGIN = "http://localhost:3000, https://afc.example.com ";

    expect(allowedOrigins()).toEqual(["http://localhost:3000", "https://afc.example.com"]);
  });

  it("`*` 는 쿠키 세션과 함께 쓸 수 없어 거부한다", () => {
    process.env.WEB_ORIGIN = "*";

    expect(() => allowedOrigins()).toThrow(/\*/);
  });

  it("빈 값이면 거부한다(모든 origin 이 열리는 실수 방지)", () => {
    process.env.WEB_ORIGIN = " , ";

    expect(() => allowedOrigins()).toThrow(/WEB_ORIGIN/);
  });
});
