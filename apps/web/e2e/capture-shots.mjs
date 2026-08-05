/**
 * 재설계 전/후 비교 스크린샷 캡처 (F0-0 / F1-0 / F1-1 / F5).
 *
 * 사용법: node e2e/capture-shots.mjs before   (재설계 전)
 *         node e2e/capture-shots.mjs after    (재설계 후)
 *
 * 같은 화면·같은 뷰포트(390x844)로 before-*.png / after-*.png 를 남겨 1:1 로 비교한다.
 * E2E 스펙이 아니라 **비교 근거를 남기는 도구**다(테스트 수에 포함되지 않는다).
 * 실행 중인 웹(:3000)·API(:3001)를 그대로 친다 — E2E 와 동시에 돌리지 않는다.
 */
/* global process, fetch, console, document */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const prefix = process.argv[2];
if (prefix !== "before" && prefix !== "after") {
  throw new Error("사용법: node e2e/capture-shots.mjs <before|after>");
}

const WEB = process.env.E2E_WEB_ORIGIN ?? "http://localhost:3000";
const API = `${process.env.E2E_API_TARGET ?? "http://localhost:3001"}/v1`;
const SHOTS = path.resolve(process.cwd(), "e2e/screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const file = (name) => path.join(SHOTS, `${prefix}-${name}.png`);

async function seed() {
  const response = await fetch(`${API}/programs/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
    body: JSON.stringify({
      goal: "hypertrophy",
      days_per_week: 3,
      minutes_per_day: 60,
      experience_level: "intermediate",
      equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
      pain_areas: ["knee"],
    }),
  });
  if (response.status !== 201) throw new Error(`프로그램 생성 실패: ${response.status}`);

  const dashboard = await (await fetch(`${API}/dashboard`)).json();
  if (!dashboard.today.session_id) throw new Error(`오늘(${dashboard.today.status}) 세션이 없다`);
  return dashboard.today.session_id;
}

const sessionId = await seed();

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: "ko-KR",
  timezoneId: "Asia/Seoul",
  hasTouch: true,
});

// ---- S1 온보딩: 가장 짧은 스텝(3/7, 4/7) 과 가장 긴 스텝(1/7, 7/7) ----
await page.goto(`${WEB}/onboarding`);
const steps = [
  ["onboarding-step1-profile", "기본 정보를 알려 주세요"],
  [null, "어떤 목표로 운동하세요?"],
  ["onboarding-step3-days", "일주일에 며칠 운동하세요?"],
  ["onboarding-step4-minutes", "한 번에 얼마나 운동하세요?"],
  [null, "운동 경력이 어느 정도인가요?"],
  ["onboarding-step6-equipment", "쓸 수 있는 장비를 골라 주세요"],
  ["onboarding-step7-pain", "운동할 때 불편한 곳이 있나요?"],
];
for (const [name, title] of steps) {
  await page.getByRole("heading", { name: title }).waitFor({ state: "visible" });
  if (name) await page.screenshot({ path: file(name) });
  if (title !== steps.at(-1)[1]) await page.getByRole("button", { name: "다음" }).click();
}

// ---- S4 루틴: 세트 행·운동 카드 헤더 ----
await page.goto(`${WEB}/session/${sessionId}`);
await page.getByRole("heading", { name: "오늘 운동" }).waitFor({ state: "visible" });
await page
  .getByRole("button", { name: /1세트 완료 처리$/ })
  .first()
  .waitFor({ state: "visible" });
await page.getByRole("heading", { name: /^운동 \d+$/ }).waitFor({ state: "detached" });

await page.screenshot({ path: file("routine-viewport") });
await page.screenshot({ path: file("routine-full"), fullPage: true });

const firstCheck = page.getByRole("button", { name: /1세트 완료 처리$/ }).first();
const name = ((await firstCheck.getAttribute("aria-label")) ?? "").replace(/ 1세트 완료 처리$/, "");
const row = page
  .locator("li")
  .filter({ has: page.getByRole("button", { name: `${name} 1세트 완료 처리` }) });
await row.screenshot({ path: file("set-row") });

const card = page.getByRole("heading", { name, exact: true }).locator("xpath=..");
await card.screenshot({ path: file("exercise-card") });

// 완료 세트가 1개 이상인 상태(축약 렌더 + 대비 확인용)
await page.getByLabel(`${name} 1세트 무게, 킬로그램`).fill("50");
await page.getByLabel(`${name} 1세트 횟수, 회`).fill("6");
await firstCheck.click();
const timer = page.getByRole("dialog", { name: /후 휴식/ });
await timer.waitFor({ state: "visible" });
await timer.getByRole("button", { name: "휴식 종료" }).click();
await timer.waitFor({ state: "hidden" });
await card.screenshot({ path: file("exercise-card-completed") });
await page.screenshot({ path: file("routine-completed") });

// 세로 스크롤 총량(밀도) 실측
const setCount = await page.getByRole("button", { name: /세트 완료 (처리|취소)$/ }).count();
const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
console.log(
  JSON.stringify({ prefix, setCount, scrollHeight, perSet: Math.round(scrollHeight / setCount) }),
);

await browser.close();
