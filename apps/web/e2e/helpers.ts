/**
 * E2E 공용 헬퍼. 여기서는 **앱을 거치지 않는 준비 작업**(프로그램 시드, 세션 id 조회)만 한다.
 * 화면 검증은 각 spec 이 실제 클릭으로 한다.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * 실서버(apps/api). 테스트 프로세스에서 준비 작업용으로 직접 친다.
 * **Playwright 가 띄운 E2E 전용 인스턴스(:3101, `<db>_e2e`)** 다 — 개발 서버(:3001, `afc`)가 아니다.
 */
export const API =
  process.env.E2E_API_TARGET ?? `http://localhost:${process.env.E2E_API_PORT ?? 3101}`;
export const API_V1 = `${API}/v1`;

/** 앱이 브라우저에서 쓰는 출처. api 의 CORS 허용목록과 일치해야 한다. */
export const WEB_ORIGIN = `http://localhost:${process.env.E2E_WEB_PORT ?? 3000}`;

export const SHOTS = path.resolve(process.cwd(), "e2e/.artifacts/screenshots");

export function shotPath(name: string): string {
  fs.mkdirSync(SHOTS, { recursive: true });
  return path.join(SHOTS, `${name}.png`);
}

export async function shot(page: Page, name: string): Promise<string> {
  const file = shotPath(name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export type GeneratePayload = {
  goal: "diet" | "hypertrophy" | "strength";
  days_per_week: number;
  minutes_per_day: number;
  experience_level: "beginner" | "intermediate" | "advanced";
  equipment: string[];
  pain_areas: string[];
};

export const DEFAULT_PROGRAM: GeneratePayload = {
  goal: "hypertrophy",
  days_per_week: 3, // MON/WED/FRI — 오늘이 수요일이면 운동일이 된다
  minutes_per_day: 60,
  experience_level: "intermediate",
  equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  pain_areas: ["knee"],
};

/** 프로그램을 새로 만들어 오늘 세션을 scheduled 상태로 되돌린다. */
export async function seedProgram(
  request: APIRequestContext,
  payload: Partial<GeneratePayload> = {},
): Promise<void> {
  const response = await request.post(`${API_V1}/programs/generate`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
    data: { ...DEFAULT_PROGRAM, ...payload },
  });
  expect(response.status(), "프로그램 생성").toBe(201);
}

export type TodaySession = { sessionId: string; status: string };

/** 오늘 세션 id. 오늘이 휴식일이면 테스트를 세우기 위해 실패시킨다(조용한 skip 금지). */
export async function todaySession(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${API_V1}/dashboard`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { today: { session_id: string | null; status: string } };
  expect(body.today.session_id, `오늘(${body.today.status})에 세션이 없다`).not.toBeNull();
  return body.today.session_id as string;
}

export async function addExercise(
  request: APIRequestContext,
  sessionId: string,
  exerciseId: string,
): Promise<void> {
  const response = await request.post(`${API_V1}/sessions/${sessionId}/exercises`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev" },
    data: { exercise_id: exerciseId },
  });
  expect(response.status(), `${exerciseId} 추가`).toBe(200);
}

/**
 * 오늘 루틴 화면이 완전히 그려질 때까지 기다린다.
 *
 * 주의: 세션 응답이 먼저 도착하면 운동 이름 자리에 **"운동 1" 임시 이름**이 렌더된다
 * (SessionScreen.nameOf 폴백). 카탈로그(`GET /exercises`)가 도착하면 이름이 바뀌므로,
 * 그 전에 잡은 접근 이름은 곧 무효가 된다 → 임시 이름이 사라질 때까지 기다린다.
 */
export async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/session/${sessionId}`);
  await expect(page.getByRole("heading", { name: "오늘 운동" })).toBeVisible();
  await expect(page.getByRole("button", { name: /1세트 완료 처리$/ }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /^운동 \d+$/ })).toHaveCount(0);
}

/** 화면 전체 텍스트에서 "0kg" 류 금지 표기를 찾는다(AC-E-1). */
export async function assertNoZeroKg(page: Page): Promise<void> {
  const text = (await page.locator("body").innerText()).replace(/\s+/g, "");
  expect(text, "화면에 0kg 이 노출되면 안 된다").not.toMatch(/(^|[^\d.])0kg/);
}
