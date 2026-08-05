/**
 * 온보딩 입력값(초안)과 로컬 보존 (UX_STATES §2.1).
 *
 * - 모든 스텝에 기본값이 있어 "빈 상태"가 없다(AC-S1-1 의 전제).
 * - 값은 localStorage 에 저장한다 → 뒤로가기·새로고침·중도 이탈 후 재진입에도 유지된다.
 *
 * 저장소를 둘로 나눈다.
 * 1. **프로필**(성별·출생연도·키·체중, `afc.profile.v1`) — F0 수집 항목인데 보낼 계약 자리가 없다
 *    (`GenerateProgramRequest` 에 없고 `PATCH /me` 는 테스트 단계 보류). F0 지시대로 **로컬에 계속 보관**하고,
 *    인증이 붙으면 그때 서버로 옮긴다. 온보딩을 마쳐도 지우지 않는다.
 * 2. **진행 초안**(목표·일수·시간·경력·장비 + 현재 스텝, `afc.onboarding.draft.v1`) — 중도 이탈 대비 임시값이라
 *    제출에 성공하면 지운다.
 *
 * **통증 부위(`pain_areas`)는 어느 쪽에도 저장하지 않는다.** 건강 관련 민감정보라
 * (docs/SECURITY_PIPA.md) 브라우저에 무기한 남기지 않는다 — 온보딩을 진행하는 동안 메모리에만 두고
 * 계획 생성 요청에 실어 보낸 뒤 화면과 함께 사라진다.
 */
import { EMPTY_PAIN_SELECTION, type PainSelection, painAreasPayload } from "./pain-areas";
import type { GenerateProgramRequest } from "../../lib/api";

export const SEX_OPTIONS = [
  { value: "male", label: "남성" },
  { value: "female", label: "여성" },
  { value: "other", label: "선택 안 함" },
] as const;

export type Sex = (typeof SEX_OPTIONS)[number]["value"];

export const GOAL_OPTIONS = [
  { value: "diet", label: "다이어트", description: "체지방을 줄이면서 근육을 지켜요" },
  { value: "hypertrophy", label: "근비대", description: "근육 크기를 키워요" },
  { value: "strength", label: "스트렝스", description: "최대 힘을 키워요" },
] as const;

export type Goal = (typeof GOAL_OPTIONS)[number]["value"];

/** openapi `days_per_week`: 2~6. */
export const DAYS_OPTIONS = [2, 3, 4, 5, 6] as const;

export type DaysPerWeek = (typeof DAYS_OPTIONS)[number];

/** openapi `minutes_per_day`: 30/45/60/75/90(계약이 enum 이라 리터럴 유니온으로 들고 있는다). */
export const MINUTES_OPTIONS = [30, 45, 60, 75, 90] as const;

export type MinutesPerDay = (typeof MINUTES_OPTIONS)[number];

/** prisma `Equipment` enum 과 같은 값이다. 카탈로그 필터에 그대로 쓰인다. */
export const EQUIPMENT_OPTIONS = [
  { value: "barbell", label: "바벨" },
  { value: "dumbbell", label: "덤벨" },
  { value: "machine", label: "머신" },
  { value: "cable", label: "케이블" },
  { value: "bodyweight", label: "맨몸" },
  { value: "ez_bar", label: "EZ바" },
] as const;

export type Equipment = (typeof EQUIPMENT_OPTIONS)[number]["value"];

/**
 * `experience_level` 은 `POST /programs/generate` 의 필수 필드이고 **종목 선택 난도에 실제로 반영된다**
 * (programs.service `levelRank`). 기본값으로 고정하면 고급자가 초급 프로그램을 받으므로 반드시 물어본다.
 */
export const EXPERIENCE_OPTIONS = [
  { value: "beginner", label: "초급", description: "웨이트 운동 6개월 미만" },
  { value: "intermediate", label: "중급", description: "6개월~2년, 기본 동작이 익숙해요" },
  { value: "advanced", label: "고급", description: "2년 이상, 계획을 스스로 조절해요" },
] as const;

export type ExperienceLevel = (typeof EXPERIENCE_OPTIONS)[number]["value"];

export type OnboardingDraft = {
  sex: Sex;
  birth_year: string;
  height_cm: string;
  weight_kg: string;
  goal: Goal;
  days_per_week: DaysPerWeek;
  minutes_per_day: MinutesPerDay;
  experience_level: ExperienceLevel;
  equipment: Equipment[];
  pain: PainSelection;
};

export const INITIAL_DRAFT: OnboardingDraft = {
  sex: "other",
  birth_year: "",
  height_cm: "",
  weight_kg: "",
  goal: "hypertrophy",
  days_per_week: 3,
  minutes_per_day: 60,
  experience_level: "beginner",
  equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "ez_bar"],
  pain: EMPTY_PAIN_SELECTION,
};

export const STEP_TITLES = [
  "기본 정보를 알려 주세요",
  "어떤 목표로 운동하세요?",
  "일주일에 며칠 운동하세요?",
  "한 번에 얼마나 운동하세요?",
  "운동 경력이 어느 정도인가요?",
  "쓸 수 있는 장비를 골라 주세요",
  "운동할 때 불편한 곳이 있나요?",
] as const;

export const STEP_COUNT = STEP_TITLES.length;

export function clampStep(value: number): number {
  if (!Number.isInteger(value)) return 0;
  return Math.min(STEP_COUNT - 1, Math.max(0, value));
}

export function toggleEquipment(current: Equipment[], value: Equipment): Equipment[] {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : EQUIPMENT_OPTIONS.map((item) => item.value).filter(
        (item) => item === value || current.includes(item),
      );
}

/** 계약 페이로드. 통증 부위는 painAreasPayload 를 거쳐야만 만들어진다(AC-P-3). */
export function toGenerateRequest(draft: OnboardingDraft): GenerateProgramRequest {
  return {
    goal: draft.goal,
    days_per_week: draft.days_per_week,
    minutes_per_day: draft.minutes_per_day,
    experience_level: draft.experience_level,
    equipment: draft.equipment,
    pain_areas: painAreasPayload(draft.pain),
  };
}

const STORAGE_KEY = "afc.onboarding.draft.v1";
const PROFILE_KEY = "afc.profile.v1";

export type StoredDraft = { draft: OnboardingDraft; step: number };

/** 저장된 값은 신뢰하지 않는다 — 모르는 값은 기본값으로 되돌린다. */
export function normalizeDraft(value: unknown): StoredDraft | null {
  if (typeof value !== "object" || value === null) return null;

  const raw = (value as { draft?: unknown; step?: unknown }).draft;
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;

  const oneOf = <T extends string | number>(
    candidate: unknown,
    allowed: readonly T[],
    fallback: T,
  ) => (allowed.includes(candidate as T) ? (candidate as T) : fallback);

  const equipment = Array.isArray(source.equipment)
    ? EQUIPMENT_OPTIONS.map((item) => item.value).filter((item) =>
        (source.equipment as unknown[]).includes(item),
      )
    : INITIAL_DRAFT.equipment;

  return {
    draft: {
      sex: oneOf(
        source.sex,
        SEX_OPTIONS.map((item) => item.value),
        INITIAL_DRAFT.sex,
      ),
      birth_year: typeof source.birth_year === "string" ? source.birth_year : "",
      height_cm: typeof source.height_cm === "string" ? source.height_cm : "",
      weight_kg: typeof source.weight_kg === "string" ? source.weight_kg : "",
      goal: oneOf(
        source.goal,
        GOAL_OPTIONS.map((item) => item.value),
        INITIAL_DRAFT.goal,
      ),
      days_per_week: oneOf(source.days_per_week, DAYS_OPTIONS, INITIAL_DRAFT.days_per_week),
      minutes_per_day: oneOf(
        source.minutes_per_day,
        MINUTES_OPTIONS,
        INITIAL_DRAFT.minutes_per_day,
      ),
      experience_level: oneOf(
        source.experience_level,
        EXPERIENCE_OPTIONS.map((item) => item.value),
        INITIAL_DRAFT.experience_level,
      ),
      equipment,
      // 통증 부위는 저장하지 않는다 → 복원도 하지 않는다(옛 저장값이 남아 있어도 버린다).
      pain: EMPTY_PAIN_SELECTION,
    },
    step: clampStep(Number((value as { step?: unknown }).step ?? 0)),
  };
}

/** 로컬에 계속 남는 프로필(F0). 계약에 보낼 자리가 생기면 이 값을 전송한다. */
export type Profile = Pick<OnboardingDraft, "sex" | "birth_year" | "height_cm" | "weight_kg">;

export function toProfile(draft: OnboardingDraft): Profile {
  return {
    sex: draft.sex,
    birth_year: draft.birth_year,
    height_cm: draft.height_cm,
    weight_kg: draft.weight_kg,
  };
}

/** 저장된 프로필도 신뢰하지 않는다 — 모르는 값은 기본값으로 되돌린다. */
export function normalizeProfile(value: unknown): Profile | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const text = (candidate: unknown) => (typeof candidate === "string" ? candidate : "");

  return {
    sex: SEX_OPTIONS.map((item) => item.value).includes(source.sex as Profile["sex"])
      ? (source.sex as Profile["sex"])
      : INITIAL_DRAFT.sex,
    birth_year: text(source.birth_year),
    height_cm: text(source.height_cm),
    weight_kg: text(source.weight_kg),
  };
}

export function loadProfile(): Profile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    return raw ? normalizeProfile(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: Profile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // 저장 공간이 없어도 온보딩 자체는 계속 진행할 수 있어야 한다.
  }
}

/** 진행 초안은 프로필도 통증 부위도 담지 않는다(각각 별도 저장·미저장). */
function toProgress(draft: OnboardingDraft) {
  return {
    goal: draft.goal,
    days_per_week: draft.days_per_week,
    minutes_per_day: draft.minutes_per_day,
    experience_level: draft.experience_level,
    equipment: draft.equipment,
  };
}

/** 진행 초안 + 프로필을 합쳐 화면 상태를 되살린다. */
export function loadDraft(): StoredDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = raw ? normalizeDraft(JSON.parse(raw)) : null;
    const profile = loadProfile();
    if (!stored) return profile ? { draft: { ...INITIAL_DRAFT, ...profile }, step: 0 } : null;
    return { draft: { ...stored.draft, ...(profile ?? {}) }, step: stored.step };
  } catch {
    return null;
  }
}

export function saveDraft(stored: StoredDraft): void {
  if (typeof window === "undefined") return;
  saveProfile(toProfile(stored.draft));
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ draft: toProgress(stored.draft), step: stored.step }),
    );
  } catch {
    // 저장 공간이 없어도 온보딩 자체는 계속 진행할 수 있어야 한다.
  }
}

/** 진행 초안만 지운다. 프로필(F0)은 로컬에 남는다. */
export function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 무시한다.
  }
}
