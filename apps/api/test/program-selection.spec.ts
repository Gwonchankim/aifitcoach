import { readFileSync } from "node:fs";
import path from "node:path";
import type { Exercise } from "@prisma/client";
import {
  buildProgramSelectionContext,
  DIFFICULTY_RANK,
  selectExercises,
  type SelectionOptions,
} from "../src/programs/programs.service";
import type { GenerateProgramDto } from "../src/programs/dto/generate-program.dto";
import { loadSemanticsFor } from "../src/programs/assistance-migration";
import {
  exerciseCountFor,
  type Focus,
  PAIN_AREAS,
  patternsFor,
  scheduleFor,
  splitTypeFor,
} from "../src/programs/program-rules";

const BEGINNER_OPTIONS: SelectionOptions = {
  levelRank: DIFFICULTY_RANK.beginner,
  preferStable: false,
  substituteMuscles: new Set(),
};

function exercise(
  id: string,
  difficulty: Exercise["difficulty"],
  mechanic: Exercise["mechanic"],
): Exercise {
  return {
    id,
    nameKo: id,
    nameEn: id,
    movementPattern: "horizontal_push",
    mechanic,
    region: "upper",
    primaryMuscles: ["chest"],
    secondaryMuscles: [],
    equipment: "bodyweight",
    difficulty,
    metric: "reps",
    defaultRepsLow: 6,
    defaultRepsHigh: 12,
    defaultTimeLowSec: null,
    defaultTimeHighSec: null,
    defaultStepKg: null,
    loadSemantics: "external_load" as const,
    unilateral: false,
    substitutions: [],
    cues: [],
    media: {},
  };
}

describe("프로그램 운동 선택 안전 계약", () => {
  it("beginner에게 intermediate·advanced 운동을 처방하지 않는다", () => {
    const selected = selectExercises(
      [
        exercise("e_advanced_deadlift", "advanced", "compound"),
        exercise("e_beginner_pushup", "beginner", "compound"),
      ],
      ["horizontal_push", "horizontal_push"],
      2,
      BEGINNER_OPTIONS,
    );

    expect(selected.map((item) => item.id)).toEqual(["e_beginner_pushup"]);
    expect(
      selected.every((item) => DIFFICULTY_RANK[item.difficulty] <= DIFFICULTY_RANK.beginner),
    ).toBe(true);
  });

  it("같은 패턴에서는 compound를 먼저 고르고 isolation으로 보충한다", () => {
    const selected = selectExercises(
      [
        exercise("e_a_isolation", "beginner", "isolation"),
        exercise("e_z_compound", "beginner", "compound"),
      ],
      ["horizontal_push", "horizontal_push"],
      2,
      BEGINNER_OPTIONS,
    );

    expect(selected.map((item) => item.mechanic)).toEqual(["compound", "isolation"]);
  });
});

/**
 * **신규 종목이 기존 처방을 어디까지 바꾸는가.**
 *
 * 카탈로그에 종목을 하나 더하는 것은 무해해 보이지만 선택기는 카탈로그 전체를 후보로 본다.
 * 그래서 "안 바뀐다"를 말로 두지 않고 **신규 행이 있는 카탈로그와 없는 카탈로그의 결과를 직접
 * 비교**한다. 선택 로직과 통증 매핑은 이 티켓에서 한 줄도 바뀌지 않았으므로, 차이가 난다면
 * 그것은 전부 이 한 행 때문이다.
 *
 * 판정 근거: `docs/SAFETY_PAIN_MAPPING.md` 규칙 1 — 제외로 자리가 비면 **같은 근육군의
 * 머신/케이블 종목으로 안정성 우선 대체**한다.
 */
const NEW_ID = "e_smith_incline_bench_press";

const SEED_PATH = path.resolve(__dirname, "..", "..", "..", "docs", "specs", "exercises_seed.json");

/** 시드 1행 → Prisma 행. 시드가 진실의 원천이므로 여기서 값을 다시 적지 않는다. */
function toRow(raw: Record<string, unknown>): Exercise {
  return {
    id: raw.id,
    nameKo: raw.name_ko,
    nameEn: raw.name_en,
    movementPattern: raw.movement_pattern,
    mechanic: raw.mechanic,
    region: raw.region,
    primaryMuscles: raw.primary_muscles,
    secondaryMuscles: raw.secondary_muscles,
    equipment: raw.equipment,
    difficulty: raw.difficulty,
    metric: raw.metric,
    defaultRepsLow: raw.default_reps_low ?? null,
    defaultRepsHigh: raw.default_reps_high ?? null,
    defaultTimeLowSec: raw.default_time_low_sec ?? null,
    defaultTimeHighSec: raw.default_time_high_sec ?? null,
    defaultStepKg: raw.default_step_kg ?? null,
    unilateral: raw.unilateral,
    loadSemantics: loadSemanticsFor(String(raw.id)),
    substitutions: raw.substitutions,
    cues: raw.cues,
    media: raw.media,
  } as unknown as Exercise;
}

const CATALOG: Exercise[] = (
  JSON.parse(readFileSync(SEED_PATH, "utf8")) as { exercises: Record<string, unknown>[] }
).exercises.map(toRow);

/** 신규 행을 뺀 카탈로그 = 이 티켓 이전 상태. */
const CATALOG_BEFORE = CATALOG.filter((exercise) => exercise.id !== NEW_ID);

function dto(overrides: Partial<GenerateProgramDto> = {}): GenerateProgramDto {
  return {
    goal: "hypertrophy",
    days_per_week: 4,
    minutes_per_day: 60,
    experience_level: "intermediate",
    ...overrides,
  } as unknown as GenerateProgramDto;
}

/**
 * 한 focus 의 선택 결과 id 목록.
 *
 * **개수는 `exerciseCountFor(minutes_per_day)` 다** — active V1(`planFocus` legacy 분기)이 넘기는
 * 바로 그 값이고, production 이 export 하는 같은 helper 를 쓴다. 여기서 `patterns.length` 같은
 * 테스트 전용 개수를 쓰면 화면에 실제로 나오지 않는 계획을 검증하게 된다(독립 리뷰 P1-1).
 */
function selectFor(catalog: Exercise[], input: GenerateProgramDto, focus: Focus) {
  const context = buildProgramSelectionContext(catalog, input);
  return selectExercises(
    context.allowed,
    patternsFor(focus),
    exerciseCountFor(input.minutes_per_day),
    context.options,
  ).map((exercise) => exercise.id);
}

/** 프로그램 생성 입력의 전수 격자 225개(goal 3 × days 5 × minutes 5 × level 3). */
function* BASE_INPUTS(painAreas?: string[]): Generator<GenerateProgramDto> {
  for (const goal of ["diet", "hypertrophy", "strength"] as const)
    for (const days of [2, 3, 4, 5, 6])
      for (const minutes of [30, 45, 60, 75, 90] as const)
        for (const level of ["beginner", "intermediate", "advanced"] as const)
          yield dto({
            goal,
            days_per_week: days,
            minutes_per_day: minutes,
            experience_level: level,
            ...(painAreas ? { pain_areas: painAreas } : {}),
          });
}

/** 주간 계획 전체를 문자열로 — 전수 비교용. 개수 계약은 `selectFor` 와 같다. */
function planOf(catalog: Exercise[], input: GenerateProgramDto): string {
  return scheduleFor(input.days_per_week)
    .map(({ focus }) => `${focus}:${selectFor(catalog, input, focus).join(",")}`)
    .join(" | ");
}

describe("스미스 인클라인 추가의 선택 영향", () => {
  it("시드에 신규 행이 정확히 하나 늘어 있다", () => {
    expect(CATALOG).toHaveLength(106);
    expect(CATALOG_BEFORE).toHaveLength(105);
    expect(CATALOG.filter((exercise) => exercise.id === NEW_ID)).toHaveLength(1);
  });

  it("통증이 없으면 225조합 전부에서 계획이 한 글자도 바뀌지 않는다", () => {
    const changed: string[] = [];
    let compared = 0;

    for (const input of BASE_INPUTS()) {
      compared += 1;
      if (planOf(CATALOG, input) !== planOf(CATALOG_BEFORE, input))
        changed.push(`${input.goal}/${input.days_per_week}d/${input.minutes_per_day}m`);
    }

    // 전수라는 사실 자체를 못박는다 — 표본이 줄면 이 단언이 먼저 깨진다.
    expect(compared).toBe(225);
    expect(changed).toEqual([]);
  });

  /**
   * **영향 범위 전수.** 통증 목록은 손으로 적지 않고 계약 원천(`PAIN_AREAS`)에서 가져온다 —
   * 임의로 고른 시나리오로 세면 총 조합 수부터 틀린다(독립 리뷰 P1-1 에서 실제로 그랬다).
   */
  it("통증 enum 전수에서 달라지는 조합은 목 통증뿐이고, 시간대별 분포까지 고정된다", () => {
    expect(PAIN_AREAS).toEqual([
      "knee",
      "lower_back",
      "shoulder",
      "elbow",
      "wrist",
      "hip",
      "neck",
      "ankle",
    ]);

    const scenarios: (string[] | undefined)[] = [undefined, ...PAIN_AREAS.map((area) => [area])];
    const changedByPain: Record<string, number> = {};
    const changedByMinutes: Record<number, number> = {};
    let compared = 0;

    for (const pain of scenarios)
      for (const input of BASE_INPUTS(pain)) {
        compared += 1;
        if (planOf(CATALOG, input) === planOf(CATALOG_BEFORE, input)) continue;
        const key = pain?.[0] ?? "(통증 없음)";
        changedByPain[key] = (changedByPain[key] ?? 0) + 1;
        changedByMinutes[input.minutes_per_day] =
          (changedByMinutes[input.minutes_per_day] ?? 0) + 1;
      }

    // 225 조합 × (통증 없음 + 8부위) = 2,025.
    expect(compared).toBe(225 * (PAIN_AREAS.length + 1));
    expect(compared).toBe(2025);

    // 목 통증에서만, 그리고 시간이 넉넉해 대체 자리가 생기는 시간대에서만 달라진다.
    expect(changedByPain).toEqual({ neck: 81 });
    expect(changedByMinutes).toEqual({ 60: 9, 75: 27, 90: 45 });
  });

  it("통증이 없으면 신규 종목은 아예 선택되지 않는다 — 기존 후보가 모두 앞선다", () => {
    const picked = new Set<string>();
    for (const days of [2, 3, 4, 5, 6])
      for (const level of ["beginner", "intermediate", "advanced"] as const)
        for (const id of planOf(CATALOG, dto({ days_per_week: days, experience_level: level }))
          .split(/[:,| ]+/)
          .filter(Boolean))
          picked.add(id);

    expect(picked.has(NEW_ID)).toBe(false);
    // 비공허성: 같은 순회가 실제로 종목을 모으고 있다는 증거.
    expect(picked.has("e_bench_press")).toBe(true);
  });

  it("목 통증에서는 신규 머신 종목이 바벨 인클라인을 대체한다(안정성 우선)", () => {
    const input = dto({
      goal: "diet",
      days_per_week: 2,
      // **대체가 실제로 일어나는 시간대여야 한다.** 30·45분은 V1 개수가 3·4라 대체 자리 자체가
      // 생기지 않는다 — 그런 입력으로 고정하면 통과해도 아무것도 보증하지 않는다(P1-1).
      minutes_per_day: 90,
      pain_areas: ["neck"],
    });

    // 이 fixture 가 밟는 개수가 active V1 의 값이라는 것을 명시한다.
    expect(exerciseCountFor(90)).toBe(7);

    const after = selectFor(CATALOG, input, "full_body");
    const before = selectFor(CATALOG_BEFORE, input, "full_body");

    // exact — 순서까지 고정한다.
    expect(before).toEqual([
      "e_belt_squat",
      "e_chest_press_machine",
      "e_chest_supported_row",
      "e_cable_pull_through",
      "e_assisted_pullup",
      "e_cable_woodchop",
      "e_incline_bench_press",
    ]);
    expect(after).toEqual([
      "e_belt_squat",
      "e_chest_press_machine",
      "e_chest_supported_row",
      "e_cable_pull_through",
      "e_assisted_pullup",
      NEW_ID,
      "e_cable_woodchop",
    ]);

    // 바뀐 것은 정확히 한 자리다 — 바벨이 빠지고 머신이 들어왔다.
    expect(after).toContain(NEW_ID);
    expect(after).not.toContain("e_incline_bench_press");
    expect(after).toHaveLength(before.length);
  });

  it("어깨 통증에서는 horizontal_push 가 통째로 빠져 신규 종목도 후보에 없다", () => {
    const input = dto({ pain_areas: ["shoulder"] });
    const context = buildProgramSelectionContext(CATALOG, input);

    // 후보 단계에서 이미 없다 — 선택 결과만 보면 "우연히 안 뽑혔다"와 구분되지 않는다.
    expect(context.allowed.some((exercise) => exercise.id === NEW_ID)).toBe(false);
    expect(context.allowed.some((exercise) => exercise.movementPattern === "horizontal_push")).toBe(
      false,
    );
    expect(selectFor(CATALOG, input, "upper")).not.toContain(NEW_ID);
    // 비공허성: 어깨 통증이어도 상체 계획 자체는 비어 있지 않다.
    expect(selectFor(CATALOG, input, "upper").length).toBeGreaterThan(0);
  });

  it("substitutions 는 실재하는 종목만 가리킨다", () => {
    const ids = new Set(CATALOG.map((exercise) => exercise.id));
    const row = CATALOG.find((exercise) => exercise.id === NEW_ID)!;

    expect(row.substitutions).toEqual(["e_incline_bench_press", "e_incline_db_press"]);
    expect(row.substitutions.filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe("주 5일 분할 빈도 계약", () => {
  it("upper/lower를 각각 주 2회 이상 반복한다", () => {
    const focuses = scheduleFor(5).map((item) => item.focus);

    expect(focuses).toEqual(["upper", "lower", "upper", "lower", "upper"]);
    expect(focuses.filter((focus) => focus === "upper")).toHaveLength(3);
    expect(focuses.filter((focus) => focus === "lower")).toHaveLength(2);
    expect(splitTypeFor(5)).toBe("upper_lower");
  });
});
