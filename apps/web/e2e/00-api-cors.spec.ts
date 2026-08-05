/**
 * 웹(:3000) → API(:3001) 는 교차 출처다. 브라우저가 쿠키 세션을 실어 보내려면
 * 서버가 허용목록 기반 CORS 를 줘야 한다(apps/api common/http/cors.ts).
 *
 * 이 스펙은 **나머지 E2E 의 전제조건**이다. 여기가 깨지면 화면 검증은 의미가 없다.
 */
import { expect, test } from "@playwright/test";
import { API_V1, WEB_ORIGIN } from "./helpers";

test("허용된 origin 에는 Access-Control-Allow-Origin 을 준다", async ({ request }) => {
  const response = await request.get(`${API_V1}/dashboard`, {
    headers: { Origin: WEB_ORIGIN },
  });
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  // 쿠키 세션을 쓰므로 credentials 가 켜져 있어야 하고, 그때 `*` 는 브라우저가 거부한다.
  expect(headers["access-control-allow-credentials"]).toBe("true");
  expect(headers["access-control-allow-origin"]).not.toBe("*");
});

test("변경 요청 프리플라이트(OPTIONS)가 204 로 통과한다", async ({ request }) => {
  const response = await request.fetch(`${API_V1}/programs/generate`, {
    method: "OPTIONS",
    headers: {
      Origin: WEB_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-csrf-token",
    },
  });
  expect(response.status()).toBe(204);
  const headers = response.headers();
  expect(headers["access-control-allow-methods"]).toContain("POST");
  expect(headers["access-control-allow-headers"]).toContain("X-CSRF-Token");
});

test("허용목록 밖 origin 에는 Access-Control-Allow-Origin 을 주지 않는다", async ({ request }) => {
  const response = await request.get(`${API_V1}/dashboard`, {
    headers: { Origin: "http://evil.example" },
  });
  expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("브라우저에서 실제로 교차 출처 요청이 통과한다", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url, { credentials: "include" });
      return { ok: true, status: response.status };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }, `${API_V1}/dashboard`);

  expect(result, `브라우저 fetch 결과: ${JSON.stringify(result)}`).toMatchObject({
    ok: true,
    status: 200,
  });
});
