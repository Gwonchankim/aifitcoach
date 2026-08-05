/**
 * 서버 에러 → 사용자 문구 매핑 (docs/UX_STATES.md §3).
 *
 * 규칙
 * - 서버 `error.message` 를 화면에 그대로 노출하지 않는다(개발자용 해라체 + 식별자 포함).
 * - `error.code` 는 로그·계측용이다. 화면에 렌더하지 않는다.
 * - 네트워크 레벨 실패는 ApiError 가 아니므로(fetch 가 TypeError 를 던진다) 오프라인 문구로 갈린다.
 */
import { ApiError } from "./api";

export type UiError = {
  /** 화면에 그대로 렌더할 문구. */
  message: string;
  /** offline = 네트워크 레벨 실패. api = 서버가 상태코드를 돌려준 경우. */
  kind: "offline" | "api";
  /** 로그·계측용. 화면에 렌더하지 않는다. */
  status: number | null;
  /** 로그·계측용. 화면에 렌더하지 않는다. */
  code: string | null;
};

/** §3.1 상태코드 → 기본 문구. */
const BASE_BY_STATUS: Record<number, string> = {
  400: "입력한 값을 다시 확인해 주세요.",
  404: "이 정보를 찾을 수 없어요.",
  409: "다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요.",
  500: "잠시 문제가 있었어요. 다시 시도해 주세요.",
  501: "이 기능은 아직 준비 중이에요.",
};

const FALLBACK = BASE_BY_STATUS[500];

export const OFFLINE_MESSAGE = "인터넷 연결이 불안정해요. 연결되면 자동으로 이어서 진행할게요.";

/**
 * E-1~E-4: 계획 만들기(`POST /programs/generate`).
 * pain_areas·days_per_week·minutes_per_day 는 UI 가 원천 차단하므로(§3.3) 남는 400 은
 * "조건에 맞는 운동이 없다"(E-3)뿐이다.
 */
export const GENERATE_PROGRAM_ERRORS: Record<number, string> = {
  400: "지금 고른 장비로는 계획을 만들기 어려워요. 장비를 하나 더 선택해 주세요.",
};

/** E-5: 계획 보기(`GET /programs/current`). 404 는 에러가 아니라 빈 상태로 다룬다(§2.2 빈③). */
export const CURRENT_PROGRAM_ERRORS: Record<number, string> = {
  404: "아직 운동 계획이 없어요. 먼저 계획을 만들어 주세요.",
};

/** E-22: 대시보드(`GET /dashboard`). 아직 501 인 구간을 포함한다. */
export const DASHBOARD_ERRORS: Record<number, string> = {
  500: "요약을 지금은 불러올 수 없어요.",
  501: "요약을 지금은 불러올 수 없어요.",
};

export function toUiError(error: unknown, overrides: Record<number, string> = {}): UiError {
  if (!(error instanceof ApiError)) {
    return { message: OFFLINE_MESSAGE, kind: "offline", status: null, code: null };
  }

  const message = overrides[error.status] ?? BASE_BY_STATUS[error.status] ?? FALLBACK;
  return { message, kind: "api", status: error.status, code: error.code };
}

/** 404 는 "없음"이라 화면 대부분에서 에러가 아니라 빈 상태다. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
