/**
 * RIR 입력 규칙(FEATURES_UX F1-1). 순수 함수라 테스트로 고정한다(test/session-rir.test.ts).
 *
 * 범위 0~6 은 추천 엔진의 `corrected_RIR = clamp(reported + rir_bias, 0, 6)` 과 같은 범위다
 * (docs/RECOMMENDATION_ENGINE.md). **미입력은 0 이 아니다** — 값이 없으면 엔진이 RIR 축 판정을
 * 보류하고 반복 기반 더블 프로그레션으로 간다. 그래서 미입력은 끝까지 `null` 로 남겨야 하고,
 * 기록에 `0` 으로 바꿔 넣으면 안 된다.
 */

export const RIR_MIN = 0;
export const RIR_MAX = 6;

/** 고르기 시트에 올리는 값(0~6). */
export const RIR_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** 미입력("모름")의 입력칸 표기. 값 자체는 끝까지 `null` 이다. */
export const RIR_UNKNOWN = "";

export const RIR_UNKNOWN_LABEL = "모름";

/**
 * 숫자 입력칸에 들어온 문자열 → RIR 값.
 * 범위 밖·숫자 아님은 **거부**한다(`accepted: false`) → 호출부가 이전 값을 그대로 유지하므로
 * UI 가 애초에 7 같은 값을 만들 수 없다(F1-1).
 */
export function parseRirText(text: string): { accepted: boolean; value: number | null } {
  const trimmed = text.trim();
  if (trimmed === "") return { accepted: true, value: null };
  if (!/^\d$/.test(trimmed)) return { accepted: false, value: null };

  const value = Number(trimmed);
  if (value < RIR_MIN || value > RIR_MAX) return { accepted: false, value: null };
  return { accepted: true, value };
}

/**
 * `↑`/`↓` 로 값을 ±1 한다(UX_STATES §2.4.2).
 * 비어 있으면 **아무 일도 하지 않는다**(0 이 생기면 미입력과 구분이 사라진다).
 * 0·6 에서 멈춘다(순환 금지).
 */
export function stepRir(value: number | null, delta: 1 | -1): number | null {
  if (value == null) return null;
  return Math.min(RIR_MAX, Math.max(RIR_MIN, value + delta));
}

/** 시트에서 고른 문자열 → RIR 값. 목록 밖 값은 미입력으로 떨어뜨린다. */
export function parseRirChoice(value: string): number | null {
  const parsed = parseRirText(value);
  return parsed.accepted ? parsed.value : null;
}

/** RIR 값 → 입력칸·드롭다운에 넣을 문자열. 미입력은 빈 문자열이다(`"0"` 이 아니다). */
export function rirText(value: number | null): string {
  return value == null ? RIR_UNKNOWN : String(value);
}
