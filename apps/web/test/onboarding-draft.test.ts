import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPERIENCE_OPTIONS,
  INITIAL_DRAFT,
  STEP_COUNT,
  STEP_TITLES,
  clampStep,
  clearDraft,
  loadDraft,
  loadProfile,
  normalizeDraft,
  saveDraft,
  toGenerateRequest,
  toggleEquipment,
} from "../components/onboarding/draft";
import { toggleNone, togglePainArea } from "../components/onboarding/pain-areas";

describe("계약 페이로드", () => {
  it("openapi 필수 필드를 모두 채운다", () => {
    const body = toGenerateRequest(INITIAL_DRAFT);

    expect(body.goal).toBe("hypertrophy");
    expect(body.days_per_week).toBe(3);
    expect(body.minutes_per_day).toBe(60);
    expect(body.experience_level).toBe("beginner");
  });

  it("운동 경력은 사용자가 고른 값을 그대로 보낸다 (기본값 고정 금지)", () => {
    // 고정하면 고급자가 초급 프로그램을 받는다 — 종목 난도 선택에 실제로 반영되는 값이다.
    for (const option of EXPERIENCE_OPTIONS) {
      const body = toGenerateRequest({ ...INITIAL_DRAFT, experience_level: option.value });
      expect(body.experience_level).toBe(option.value);
    }
  });

  it("운동 경력 선택지는 openapi enum 3종과 일치한다", () => {
    expect(EXPERIENCE_OPTIONS.map((option) => option.value)).toEqual([
      "beginner",
      "intermediate",
      "advanced",
    ]);
  });

  it("통증 부위는 항상 enum 배열로 나간다", () => {
    const painful = {
      ...INITIAL_DRAFT,
      pain: togglePainArea(togglePainArea(INITIAL_DRAFT.pain, "knee"), "neck"),
    };
    expect(toGenerateRequest(painful).pain_areas).toEqual(["knee", "neck"]);

    const none = { ...INITIAL_DRAFT, pain: toggleNone(INITIAL_DRAFT.pain) };
    expect(toGenerateRequest(none).pain_areas).toEqual([]);
  });

  it("프로필(키·체중 등)은 보낼 자리가 없어 페이로드에 넣지 않는다", () => {
    const body = toGenerateRequest({ ...INITIAL_DRAFT, height_cm: "172", weight_kg: "70" });
    expect(Object.keys(body).sort()).toEqual([
      "days_per_week",
      "equipment",
      "experience_level",
      "goal",
      "minutes_per_day",
      "pain_areas",
    ]);
  });
});

describe("장비 다중 선택", () => {
  it("토글되고 화면 순서를 유지한다", () => {
    expect(toggleEquipment([], "machine")).toEqual(["machine"]);
    expect(toggleEquipment(["machine"], "barbell")).toEqual(["barbell", "machine"]);
    expect(toggleEquipment(["barbell", "machine"], "machine")).toEqual(["barbell"]);
  });
});

describe("스텝 범위", () => {
  it("F0 수집 항목대로 7스텝이다", () => {
    expect(STEP_COUNT).toBe(7);
    expect(STEP_TITLES[4]).toBe("운동 경력이 어느 정도인가요?");
  });

  it("0~6 밖으로 나가지 않는다", () => {
    expect(clampStep(-2)).toBe(0);
    expect(clampStep(9)).toBe(6);
    expect(clampStep(Number.NaN)).toBe(0);
  });
});

describe("저장된 초안 복원", () => {
  it("모르는 값은 기본값으로 되돌린다", () => {
    const stored = normalizeDraft({
      draft: {
        sex: "robot",
        goal: "powerlifting",
        days_per_week: 9,
        minutes_per_day: 33,
        experience_level: "expert",
        equipment: ["barbell", "kettlebell"],
        pain: { areas: ["knee", "spine"], none: false },
      },
      step: 3,
    });

    expect(stored?.draft.sex).toBe(INITIAL_DRAFT.sex);
    expect(stored?.draft.goal).toBe(INITIAL_DRAFT.goal);
    expect(stored?.draft.days_per_week).toBe(INITIAL_DRAFT.days_per_week);
    expect(stored?.draft.minutes_per_day).toBe(INITIAL_DRAFT.minutes_per_day);
    expect(stored?.draft.experience_level).toBe(INITIAL_DRAFT.experience_level);
    expect(stored?.draft.equipment).toEqual(["barbell"]);
    // 통증 부위는 저장 대상이 아니다 → 옛 저장값이 남아 있어도 복원하지 않는다.
    expect(stored?.draft.pain).toEqual({ areas: [], none: false });
    expect(stored?.step).toBe(3);
  });

  it("유효한 값은 그대로 되살린다", () => {
    const stored = normalizeDraft({
      draft: { ...INITIAL_DRAFT, experience_level: "advanced", minutes_per_day: 90 },
      step: 4,
    });

    expect(stored?.draft.experience_level).toBe("advanced");
    expect(stored?.draft.minutes_per_day).toBe(90);
  });

  it("형태가 아니면 복원하지 않는다", () => {
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft({ step: 2 })).toBeNull();
  });
});

/**
 * F0 저장 정책: 프로필은 로컬에 남기고(계약이 열리면 전송), 통증 부위는 민감정보라 남기지 않는다.
 */
describe("로컬 저장 정책", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const painful = {
    ...INITIAL_DRAFT,
    sex: "female" as const,
    birth_year: "1994",
    height_cm: "168",
    weight_kg: "58",
    experience_level: "advanced" as const,
    pain: togglePainArea(INITIAL_DRAFT.pain, "knee"),
  };

  it("통증 부위는 어떤 키에도 저장되지 않는다", () => {
    saveDraft({ draft: painful, step: 6 });

    const dumped = [...store.values()].join("");
    expect(dumped).not.toContain("knee");
    expect(dumped).not.toContain("pain");
    expect(loadDraft()?.draft.pain).toEqual({ areas: [], none: false });
  });

  it("제출 후 진행 초안을 지워도 프로필은 로컬에 남는다(F0)", () => {
    saveDraft({ draft: painful, step: 6 });
    clearDraft();

    expect(loadProfile()).toEqual({
      sex: "female",
      birth_year: "1994",
      height_cm: "168",
      weight_kg: "58",
    });
    // 진행 초안(경력·장비 등)은 사라지고 프로필만 되살아난다.
    const restored = loadDraft();
    expect(restored?.draft.height_cm).toBe("168");
    expect(restored?.draft.experience_level).toBe(INITIAL_DRAFT.experience_level);
    expect(restored?.step).toBe(0);
  });

  it("진행 중에는 초안과 프로필이 함께 복원된다", () => {
    saveDraft({ draft: painful, step: 4 });

    const restored = loadDraft();
    expect(restored?.step).toBe(4);
    expect(restored?.draft.experience_level).toBe("advanced");
    expect(restored?.draft.sex).toBe("female");
  });

  it("저장된 것이 없으면 복원하지 않는다", () => {
    expect(loadDraft()).toBeNull();
    expect(loadProfile()).toBeNull();
  });
});
