/**
 * 통증 부위 선택 (FEATURES_UX F0-1, UX_STATES §6) — **안전 필드**.
 *
 * 서버는 enum 8종만 받고 그 외는 400 이다(조용한 무시 없음). 그래서 여기서
 * - 전송값은 이 파일의 상수 배열에서만 나온다(라벨을 전송하는 사고 차단),
 * - "해당 없음"과 부위 칩은 상호 배타로 강제한다.
 * 목록은 docs/SAFETY_PAIN_MAPPING.md 매핑표와 1:1 이다. 부위가 늘거나 줄면 문서·openapi·UI 를 함께 바꾼다.
 */

export const PAIN_AREAS = [
  { value: "knee", label: "무릎", srLabel: "무릎 통증" },
  { value: "lower_back", label: "허리", srLabel: "허리 통증" },
  { value: "shoulder", label: "어깨", srLabel: "어깨 통증" },
  { value: "elbow", label: "팔꿈치", srLabel: "팔꿈치 통증" },
  { value: "wrist", label: "손목", srLabel: "손목 통증" },
  { value: "hip", label: "고관절", srLabel: "고관절 통증" },
  { value: "neck", label: "목", srLabel: "목 통증" },
  { value: "ankle", label: "발목", srLabel: "발목 통증" },
] as const;

export type PainArea = (typeof PAIN_AREAS)[number]["value"];

const PAIN_AREA_SET: ReadonlySet<string> = new Set(PAIN_AREAS.map((area) => area.value));

export function isPainArea(value: string): value is PainArea {
  return PAIN_AREA_SET.has(value);
}

export function painAreaLabel(value: string): string | null {
  return PAIN_AREAS.find((area) => area.value === value)?.label ?? null;
}

/**
 * 화면 상태. `none = true` 는 "해당 없음"을 명시적으로 고른 상태다.
 * 아무것도 안 고른 상태(`none = false, areas = []`)와 전송 결과는 같지만(빈 배열),
 * 칩의 선택 표시가 달라 상태를 구분해 둔다.
 */
export type PainSelection = {
  areas: PainArea[];
  none: boolean;
};

export const EMPTY_PAIN_SELECTION: PainSelection = { areas: [], none: false };

/** 부위 칩 토글. "해당 없음"이 켜져 있었다면 자동으로 꺼진다(§6.3). */
export function togglePainArea(selection: PainSelection, area: PainArea): PainSelection {
  const selected = selection.areas.includes(area);
  const areas = selected
    ? selection.areas.filter((value) => value !== area)
    : // 화면 순서와 전송 순서를 맞춰 둔다(스냅샷·로그 비교가 쉬워진다).
      PAIN_AREAS.map((item) => item.value).filter(
        (value) => value === area || selection.areas.includes(value),
      );

  return { areas, none: false };
}

/** "해당 없음" 토글. 켜면 부위 선택이 모두 해제된다(§6.3). */
export function toggleNone(selection: PainSelection): PainSelection {
  return selection.none ? EMPTY_PAIN_SELECTION : { areas: [], none: true };
}

/**
 * 전송 페이로드. 항상 8종 enum 의 부분집합이거나 빈 배열이다(AC-P-3).
 * 목록 밖 값이 섞였다면(하이드레이션 등으로 오염) 조용히 버리고 개발 로그만 남긴다 — 사용자 오류가 아니다.
 */
export function painAreasPayload(selection: PainSelection): PainArea[] {
  if (selection.none) return [];

  const valid = selection.areas.filter(isPainArea);
  if (valid.length !== selection.areas.length && process.env.NODE_ENV !== "production") {
    console.warn("[onboarding] pain_areas 에 목록 밖 값이 있어 제외했다.", selection.areas);
  }
  return valid;
}

/** localStorage 등에서 복원한 값을 상태로 되돌린다. 모르는 값은 버린다. */
export function normalizePainSelection(value: unknown): PainSelection {
  if (typeof value !== "object" || value === null) return EMPTY_PAIN_SELECTION;

  const raw = value as { areas?: unknown; none?: unknown };
  if (raw.none === true) return { areas: [], none: true };

  const areas = Array.isArray(raw.areas)
    ? raw.areas.filter((item): item is PainArea => typeof item === "string" && isPainArea(item))
    : [];
  return { areas, none: false };
}
