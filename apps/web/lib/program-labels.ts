/**
 * 계약값(enum 문자열) → 한국어 라벨, 그리고 숫자 표기 (docs/UX_STATES.md §1.3, §2.2).
 *
 * 원칙: **목록 밖 값은 null 을 돌려준다.** 호출부는 그 자리(문장·배지)를 통째로 생략한다.
 * 영문 원문(`upper_lower`, `push`, `e_back_squat` …)은 화면에 절대 노출하지 않는다(AC-S2-1).
 */

const GOAL_LABELS: Record<string, string> = {
  diet: "다이어트",
  hypertrophy: "근비대",
  strength: "스트렝스",
};

/**
 * `ppl` 은 UX_STATES 표기, `push_pull_legs` 는 서버(programs.service `splitTypeFor`)가 실제로 내려주는 값이다.
 * 둘 다 같은 분할이라 함께 받는다.
 */
const SPLIT_LABELS: Record<string, string> = {
  full_body: "전신",
  upper_lower: "상·하체 분할",
  ppl: "밀기·당기기·하체 분할",
  push_pull_legs: "밀기·당기기·하체 분할",
};

/**
 * 서버 `Focus`(programs/program-rules.ts).
 * 뒤쪽 6개는 즉석 세션(F8-1)이 만드는 부위 focus 다 — 계약 enum
 * `CreateAdHocSessionRequest.body_part` 와 1:1이다. 빠지면 대시보드 요약에 영문이 그대로 노출된다.
 */
const FOCUS_LABELS: Record<string, string> = {
  full_body: "전신",
  upper: "상체",
  lower: "하체",
  push: "밀기",
  pull: "당기기",
  chest: "가슴",
  back: "등",
  shoulders: "어깨",
  arms: "팔",
  legs: "하체",
  core: "코어",
};

const DAY_LABELS: Record<string, string> = {
  MON: "월요일",
  TUE: "화요일",
  WED: "수요일",
  THU: "목요일",
  FRI: "금요일",
  SAT: "토요일",
  SUN: "일요일",
};

function lookup(table: Record<string, string>, value: string): string | null {
  return table[value] ?? null;
}

export function goalLabel(value: string): string | null {
  return lookup(GOAL_LABELS, value);
}

export function splitLabel(value: string): string | null {
  return lookup(SPLIT_LABELS, value);
}

export function focusLabel(value: string): string | null {
  return lookup(FOCUS_LABELS, value);
}

export function dayLabel(value: string): string | null {
  return lookup(DAY_LABELS, value);
}

/** 소수점 1자리까지, 정수면 소수점을 생략한다. 천 단위는 콤마(`3,450`, `62.5`). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";

  const rounded = Math.round(value * 10) / 10;
  const [whole, fraction] = Math.abs(rounded).toFixed(1).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = rounded < 0 ? "-" : "";
  return fraction === "0" ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
}

export function formatKg(value: number): string {
  return `${formatNumber(value)}kg`;
}

/**
 * `weekly_completion_rate` 는 **0~1 비율**이다(서버 확정). 그대로 뿌리면 0.5 가 "0.5%" 로 보이므로
 * 백분율 변환은 여기서 한 번만 한다.
 */
export function formatRate(rate: number): string {
  const clamped = Math.min(1, Math.max(0, rate));
  return `${Math.round(clamped * 100)}%`;
}
