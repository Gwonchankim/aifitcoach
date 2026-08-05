import { describe, expect, it } from "vitest";
import {
  EMPTY_PAIN_SELECTION,
  PAIN_AREAS,
  isPainArea,
  normalizePainSelection,
  painAreaLabel,
  painAreasPayload,
  toggleNone,
  togglePainArea,
} from "../components/onboarding/pain-areas";

/** docs/SAFETY_PAIN_MAPPING.md 매핑표 8종과 1:1(FEATURES_UX F0-1). */
const CONTRACT_ENUM = [
  "knee",
  "lower_back",
  "shoulder",
  "elbow",
  "wrist",
  "hip",
  "neck",
  "ankle",
] as const;

describe("통증 부위 목록", () => {
  it("openapi enum 8종과 정확히 일치한다", () => {
    expect(PAIN_AREAS.map((area) => area.value)).toEqual(CONTRACT_ENUM);
  });

  it("한국어 라벨을 전송값과 분리해 가지고 있다", () => {
    expect(painAreaLabel("lower_back")).toBe("허리");
    expect(painAreaLabel("허리")).toBeNull();
  });

  it("목록 밖 값은 통증 부위가 아니다", () => {
    expect(isPainArea("knee")).toBe(true);
    expect(isPainArea("Knee")).toBe(false);
    expect(isPainArea("무릎")).toBe(false);
  });
});

describe("선택 규칙 (AC-P-2)", () => {
  it("부위 칩은 서로 독립적으로 토글된다", () => {
    let selection = togglePainArea(EMPTY_PAIN_SELECTION, "knee");
    selection = togglePainArea(selection, "shoulder");
    expect(selection.areas).toEqual(["knee", "shoulder"]);

    selection = togglePainArea(selection, "knee");
    expect(selection.areas).toEqual(["shoulder"]);
  });

  it("'해당 없음'을 고르면 부위 선택이 모두 해제된다", () => {
    const selected = togglePainArea(togglePainArea(EMPTY_PAIN_SELECTION, "knee"), "hip");
    const none = toggleNone(selected);

    expect(none.none).toBe(true);
    expect(none.areas).toEqual([]);
  });

  it("'해당 없음' 상태에서 부위를 고르면 '해당 없음'이 해제된다", () => {
    const none = toggleNone(EMPTY_PAIN_SELECTION);
    const next = togglePainArea(none, "neck");

    expect(next.none).toBe(false);
    expect(next.areas).toEqual(["neck"]);
  });

  it("'해당 없음'과 부위는 절대 동시에 선택되지 않는다", () => {
    const states = [
      EMPTY_PAIN_SELECTION,
      togglePainArea(EMPTY_PAIN_SELECTION, "ankle"),
      toggleNone(EMPTY_PAIN_SELECTION),
      togglePainArea(toggleNone(EMPTY_PAIN_SELECTION), "wrist"),
      toggleNone(togglePainArea(EMPTY_PAIN_SELECTION, "wrist")),
    ];

    for (const state of states) {
      expect(state.none && state.areas.length > 0).toBe(false);
    }
  });
});

describe("전송 페이로드 (AC-P-3)", () => {
  it("'해당 없음'은 빈 배열로 나간다", () => {
    expect(painAreasPayload(toggleNone(EMPTY_PAIN_SELECTION))).toEqual([]);
  });

  it("아무것도 고르지 않아도 빈 배열로 나간다", () => {
    expect(painAreasPayload(EMPTY_PAIN_SELECTION)).toEqual([]);
  });

  it("항상 8종 enum 의 부분집합이다", () => {
    const selection = togglePainArea(togglePainArea(EMPTY_PAIN_SELECTION, "elbow"), "knee");
    const payload = painAreasPayload(selection);

    expect(payload.every((value) => CONTRACT_ENUM.includes(value))).toBe(true);
    expect(payload).toEqual(["knee", "elbow"]);
  });

  it("오염된 값이 섞이면 전송 전에 버린다", () => {
    const polluted = { areas: ["knee", "무릎", "back"], none: false } as never;
    expect(painAreasPayload(polluted)).toEqual(["knee"]);
  });
});

describe("저장값 복원", () => {
  it("모르는 값은 버린다", () => {
    expect(normalizePainSelection({ areas: ["knee", "spine"], none: false })).toEqual({
      areas: ["knee"],
      none: false,
    });
  });

  it("none 이 켜져 있으면 부위는 비운다", () => {
    expect(normalizePainSelection({ areas: ["knee"], none: true })).toEqual({
      areas: [],
      none: true,
    });
  });

  it("형태가 깨진 값은 초기 상태로 되돌린다", () => {
    expect(normalizePainSelection(null)).toEqual(EMPTY_PAIN_SELECTION);
    expect(normalizePainSelection("knee")).toEqual(EMPTY_PAIN_SELECTION);
  });
});
