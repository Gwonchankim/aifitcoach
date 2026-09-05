import type { INestApplication } from "@nestjs/common";
import {
  RULES_BUNDLE_V2,
  SESSION_SET_CAP,
  assignRoles,
  estimateSessionSeconds,
  packSession,
} from "shared";
import type { PackCandidate } from "shared";
import {
  ProgramsService,
  buildProgramSelectionContext,
  selectPrePackExercises,
} from "../src/programs/programs.service";
import { toPackCandidate } from "../src/programs/planned-set.factory";

import { RULES_VERSION, restSecFor } from "../src/programs/program-rules";
import type { GenerateProgramDto } from "../src/programs/dto/generate-program.dto";
import { PrismaService } from "../src/prisma/prisma.service";
import { devUserId } from "../src/auth/dev-user";
import { createTestApp, resetUserData } from "./support/app";
import { normalizeProgram, planKey } from "./support/v1-plan-fixture";
import type { NormalizedProgram } from "./support/v1-plan-fixture";
import fixtureJson from "./fixtures/v1-plan-225.json";
import { CATALOG_ADDITION_IDS } from "./support/catalog-extension";

const fixture = fixtureJson as { rules_version: string; cases: NormalizedProgram[] };

const DEV_USER_ID = devUserId();

/**
 * V2-PLAN-01 substep B.
 * ① legacy(2026.08.1) 생성 결과를 goal3 × days5 × minutes5 × experience3 = **225조합** 으로 동결한다.
 *    경험 수준이 종목 선택에 영향을 주므로 75 로 줄이지 않는다.
 * ② 예약 bundle(2026.09.0) packer 경로가 시간·cap 을 동시에 만족하는지 **전수** 확인한다.
 *
 * **`unilateral` 을 가정하지 않는다.** 예전에는 전 종목을 `unilateral: true` 로 놓고 상한을
 * 더 빡세게 본다고 적었지만, 그건 **실제로 편측이 아닌 종목의 수행시간을 2배로 부풀려**
 * 존재하지 않는 초과를 만들어냈다. 카탈로그를 join 해 **실제 metadata** 를 쓴다.
 */

const GOALS = ["diet", "hypertrophy", "strength"] as const;
const DAYS = [2, 3, 4, 5, 6];
const MINUTES = [30, 45, 60, 75, 90];
const LEVELS = ["beginner", "intermediate", "advanced"] as const;
const LEGACY_COUNT: Record<number, number> = { 30: 3, 45: 4, 60: 5, 75: 6, 90: 7 };

/** 225 = 3 goal × 5 days × 5 minutes × 3 level. 900 = Σ days × (3 goal × 5 minutes × 3 level). */
const EXPECTED_PROGRAMS = GOALS.length * DAYS.length * MINUTES.length * LEVELS.length;
const EXPECTED_SESSIONS =
  DAYS.reduce((a, d) => a + d, 0) * GOALS.length * MINUTES.length * LEVELS.length;

function dto(
  goal: (typeof GOALS)[number],
  days: number,
  minutes: number,
  level: (typeof LEVELS)[number],
): GenerateProgramDto {
  return {
    goal,
    days_per_week: days,
    minutes_per_day: minutes,
    experience_level: level,
  } as GenerateProgramDto;
}

/** UUID·시각을 뺀 결정론적 표현. focus/운동 ID/세트 수/목표/휴식만 남긴다. */
function representation(program: Awaited<ReturnType<ProgramsService["generate"]>>): string {
  return JSON.stringify(
    program.sessions.map((s) => ({
      day: s.day,
      focus: s.focus,
      exercises: s.exercises.map((e) => ({
        id: e.exercise_id,
        sets: e.sets,
        reps_low: e.reps_low,
        reps_high: e.reps_high,
        rir: e.target_rir,
        rest: e.rest_sec,
        time_low: e.time_low_sec,
        time_high: e.time_high_sec,
      })),
    })),
  );
}

/** 카탈로그의 권위 있는 metadata. `unilateral` 을 여기서만 읽는다. */
type CatalogRow = {
  unilateral: boolean;
  mechanic: string;
  movementPattern: string;
  metric: string;
};

/**
 * collector 의 두 검사 규칙을 **순수 함수로 뺀다.**
 *
 * 인라인으로 두면 정상 시드에서 조건이 발생하지 않아 **가드를 지워도 결과가 같다** —
 * mutation 이 통과해 버린다. 여기서 규칙 자체를 직접 밟아 실효성을 증명한다.
 */

/** 카탈로그에 없는 id 를 그대로 돌려준다. 기본값으로 덮지 않는다. */
export function findCatalogMisses(ids: string[], catalog: Map<string, CatalogRow>): string[] {
  return ids.filter((id) => !catalog.has(id));
}

/** **원래** primary 가 결과에 남았는가. 생존자만 놓고 다시 매기면 아무나 승격돼 항상 통과한다. */
export function originalPrimarySurvived(
  roles: Map<string, string>,
  packedIds: Set<string>,
): { ok: boolean; primaryId: string | undefined } {
  const primaryId = [...roles.entries()].find(([, role]) => role === "primary")?.[0];
  return { ok: primaryId !== undefined && packedIds.has(primaryId), primaryId };
}

describe("collector 검사 규칙", () => {
  const row: CatalogRow = {
    unilateral: false,
    mechanic: "compound",
    movementPattern: "squat",
    metric: "reps",
  };

  it("카탈로그 miss 는 id 를 그대로 보고한다", () => {
    const catalog = new Map([["e_known", row]]);
    expect(findCatalogMisses(["e_known", "e_missing"], catalog)).toEqual(["e_missing"]);
  });

  it("전부 있으면 miss 가 없다", () => {
    const catalog = new Map([["e_known", row]]);
    expect(findCatalogMisses(["e_known"], catalog)).toEqual([]);
  });

  it("원래 primary 가 빠지면 위반이다 — 다른 운동이 승격돼도 통과하지 않는다", () => {
    const roles = new Map([
      ["e_primary", "primary"],
      ["e_accessory", "accessory"],
    ]);
    expect(originalPrimarySurvived(roles, new Set(["e_accessory"]))).toEqual({
      ok: false,
      primaryId: "e_primary",
    });
  });

  it("원래 primary 가 남으면 통과다", () => {
    const roles = new Map([["e_primary", "primary"]]);
    expect(originalPrimarySurvived(roles, new Set(["e_primary"])).ok).toBe(true);
  });

  it("primary 가 아예 없으면 위반이다", () => {
    expect(originalPrimarySurvived(new Map([["e_a", "accessory"]]), new Set(["e_a"])).ok).toBe(
      false,
    );
  });
});

/**
 * 강제 trim fixture — DB 없이 `packSession` 계약을 직접 밟는다.
 *
 * 225조합은 "예산 안에 들어온다"만 확인할 뿐, **예산이 모자랄 때 무엇을 먼저 버리는지**는
 * 밟지 못한다(현행 카탈로그가 그 상황을 안 만든다). 여기서 인위적으로 좁혀 순서를 고정한다.
 */
describe("packSession 강제 trim", () => {
  const candidate = (id: string, over: Partial<PackCandidate> = {}): PackCandidate => ({
    id,
    mechanic: "isolation",
    movement_pattern: "squat",
    unilateral: false,
    metric: "reps",
    target_reps_high: 10,
    target_time_high_sec: null,
    ...over,
  });

  /** compound + 첫 pattern = primary. 나머지는 secondary/accessory 로 떨어진다. */
  const primary = candidate("e_primary", { mechanic: "compound" });
  const secondary = candidate("e_secondary", { mechanic: "compound", movement_pattern: "hinge" });
  const accessoryA = candidate("e_accessory_a");
  const accessoryB = candidate("e_accessory_b");
  const core = candidate("e_core", {
    movement_pattern: "core",
    metric: "time",
    target_reps_high: null,
    target_time_high_sec: 60,
  });

  it("role 은 카탈로그 metadata 에서 파생한다", () => {
    const roles = assignRoles([primary, secondary, accessoryA, core]);
    expect(roles.get("e_primary")).toBe("primary");
    expect([...roles.values()]).toContain("secondary");
  });

  it("여유가 있으면 전부 기본 3세트로 들어간다", () => {
    const packed = packSession({
      candidates: [primary, secondary, accessoryA],
      minutesPerDay: 90,
      restSec: 60,
    });
    expect(packed.map((p) => `${p.candidate.id}:${p.sets}`)).toEqual([
      "e_primary:3",
      "e_secondary:3",
      "e_accessory_a:3",
    ]);
  });

  it("ADD_ORDER 가 comparator 순서를 role 순서로 재배열한다", () => {
    // `assignRoles` 는 **입력 순서의 첫 비-core 후보**를 primary 로 잡는다. 입력은 이미
    // focus pattern + comparator 로 정렬돼 들어온다는 것이 packer 의 전제다(임의로 섞지 않는다).
    // 여기서 검증할 것은 그 전제 위에서 **accessory 가 core 뒤로 밀리는가**다.
    const packed = packSession({
      candidates: [primary, accessoryA, core, secondary],
      minutesPerDay: 90,
      restSec: 60,
    });
    // primary → secondary → core → accessory
    expect(packed.map((p) => p.role)).toEqual(["primary", "secondary", "core", "accessory"]);
    expect(packed.map((p) => p.candidate.id)).toEqual([
      "e_primary",
      "e_secondary",
      "e_core",
      "e_accessory_a",
    ]);
  });

  /**
   * **모든 role 이 3 → 2 fallback 을 쓴다.**
   *
   * 두 운동이 **모두 남되** 두 번째 role 만 3 → 2 로 줄어드는 경계를 쓴다.
   * primary 하나만 남는 값으로는 role 별 fallback 이 독립적으로 증명되지 않는다.
   * 단독 candidate 도 쓰지 않는다 — 첫 비-core 후보는 primary 로 재분류되기 때문이다.
   *
   * 고정비 780(warmup 480 + cooldown 300) + 전환 90(2운동) + 휴식 (sets-1)×180
   * + 수행 clamp(reps_high×4, 20, 90). primary reps_high 10 → 40s/set.
   */
  const FALLBACK_REST = 180;

  const fallbackCases: Array<[string, PackCandidate, string, string]> = [
    [
      "secondary",
      candidate("e_secondary_f", {
        mechanic: "compound",
        movement_pattern: "hinge",
        target_reps_high: 15,
      }),
      "e_secondary_f",
      "secondary",
    ],
    [
      "core",
      candidate("e_core_f", {
        movement_pattern: "core",
        metric: "time",
        target_reps_high: null,
        target_time_high_sec: 60,
      }),
      "e_core_f",
      "core",
    ],
    [
      "accessory",
      candidate("e_accessory_f", { target_reps_high: 15 }),
      "e_accessory_f",
      "accessory",
    ],
  ];

  it.each(fallbackCases)("%s — 경계값이 3세트만 초과하고 2세트는 들어간다", (_label, other) => {
    const P = { sets: 3, reps_high: 10, time_high_sec: null, unilateral: false };
    const R = (sets: number) => ({
      sets,
      reps_high: other.target_reps_high,
      time_high_sec: other.target_time_high_sec,
      unilateral: other.unilateral,
    });
    const withThree = estimateSessionSeconds({ exercises: [P, R(3)], restSec: FALLBACK_REST });
    const withTwo = estimateSessionSeconds({ exercises: [P, R(2)], restSec: FALLBACK_REST });
    expect(withThree).toBeGreaterThan(1800);
    expect(withTwo).toBeLessThanOrEqual(1800);
  });

  it.each(fallbackCases)(
    "%s — 두 운동이 모두 남고 두 번째만 3 → 2 로 줄어든다",
    (_label, other, id, role) => {
      const packed = packSession({
        candidates: [primary, other],
        minutesPerDay: 30,
        restSec: FALLBACK_REST,
      });
      expect(packed.map((x) => [x.candidate.id, x.role, x.sets].join(":"))).toEqual([
        "e_primary:primary:3",
        [id, role, 2].join(":"),
      ]);
    },
  );

  it("여유가 있으면 모든 role 이 3세트를 유지한다(fallback 이 항상 켜지지 않는다)", () => {
    const packed = packSession({
      candidates: [primary, secondary, core, accessoryA],
      minutesPerDay: 90,
      restSec: 60,
    });
    expect(packed.map((p) => `${p.role}:${p.sets}`)).toEqual([
      "primary:3",
      "secondary:3",
      "core:3",
      "accessory:3",
    ]);
  });

  /**
   * low-priority trim — **적어도 하나가 실제로 탈락하고 둘 이상이 남는** 예산이다.
   * ADD_ORDER fixture(전부 fit, 90분)와 예산대를 분리해 두 mutation 이 서로 다른
   * 테스트를 죽이게 한다.
   *
   * rest 150 · P3+S3 = 1770s(fit) · P3+S3+A2 = 2130s(초과) → accessory 둘이 탈락한다.
   */
  const TRIM_REST = 150;

  it("low-priority trim 경계값이 3번째 후보를 실제로 탈락시킨다", () => {
    const P = { sets: 3, reps_high: 10, time_high_sec: null, unilateral: false };
    const S3 = { sets: 3, reps_high: 15, time_high_sec: null, unilateral: false };
    const A2 = { sets: 2, reps_high: 15, time_high_sec: null, unilateral: false };
    // 두 운동은 들어가고, 세 번째는 최소 2세트로도 못 들어간다.
    expect(estimateSessionSeconds({ exercises: [P, S3], restSec: TRIM_REST })).toBeLessThanOrEqual(
      1800,
    );
    expect(estimateSessionSeconds({ exercises: [P, S3, A2], restSec: TRIM_REST })).toBeGreaterThan(
      1800,
    );
  });

  it("낮은 우선순위부터 빠진다 — exact ordered 결과", () => {
    const secondaryT = candidate("e_secondary_t", {
      mechanic: "compound",
      movement_pattern: "hinge",
      target_reps_high: 15,
    });
    const accessoryT1 = candidate("e_accessory_t1", { target_reps_high: 15 });
    const accessoryT2 = candidate("e_accessory_t2", { target_reps_high: 15 });

    const packed = packSession({
      candidates: [primary, secondaryT, accessoryT1, accessoryT2],
      minutesPerDay: 30,
      restSec: TRIM_REST,
    });

    // primary·secondary 는 3세트로 남고 **accessory 둘은 전부 탈락**한다.
    expect(packed.map((x) => [x.candidate.id, x.role, x.sets].join(":"))).toEqual([
      "e_primary:primary:3",
      "e_secondary_t:secondary:3",
    ]);
  });

  it("primary 3세트가 안 들어가면 **2세트로 보존**한다 — accessory 에게 자리를 내주지 않는다", () => {
    // primary 3세트 = 2100s > 1800s, 2세트 = 1460s <= 1800s.
    // primary 만 하한을 못 쓰면 줄일 수 있는 accessory 가 살아남고 primary 가 탈락한다.
    const packed = packSession({
      candidates: [primary, accessoryA, accessoryB],
      minutesPerDay: 30,
      restSec: 600,
    });
    const found = packed.find((p) => p.candidate.id === "e_primary");
    expect(found).toBeDefined();
    expect(found!.sets).toBe(2);
    // accessory 가 남은 채 primary 가 빠지는 결과는 나오지 않는다.
    expect(packed.map((p) => p.candidate.id)).not.toEqual(["e_accessory_a"]);
  });

  it("primary 2세트조차 안 들어가면 **빈 결과** — accessory-only 세션을 만들지 않는다", () => {
    // **accessory 는 들어갈 수 있는데 primary 만 못 들어가는** 값이어야 이 계약을 실제로 밟는다.
    // 둘 다 탈락하는 값을 쓰면 early return 을 지워도 결과가 `[]` 라 아무것도 검증하지 못한다.
    //   고정비 = warmup 480 + cooldown 300 = 780, 예산 1800, rest 900(1회)
    //   heavy 2세트 = 780 + 900 + 2×80 = 1840 > 1800  → primary 탈락
    //   light 2세트 = 780 + 900 + 2×20 = 1720 <= 1800 → accessory 는 들어갈 수 있다
    const heavyPrimary = candidate("e_primary_heavy", {
      mechanic: "compound",
      target_reps_high: 20,
    });
    const lightAccessory = candidate("e_accessory_light", { target_reps_high: 5 });

    const packed = packSession({
      candidates: [heavyPrimary, lightAccessory],
      minutesPerDay: 30,
      restSec: 900,
    });

    // early return 이 없으면 여기서 `["e_accessory_light:accessory:2"]` 가 나온다.
    expect(packed).toEqual([]);
  });

  it("위 경계값이 실제로 그 상황을 만든다(fixture 자체 검증)", () => {
    const est = (sets: number, repsHigh: number) =>
      estimateSessionSeconds({
        exercises: [{ sets, reps_high: repsHigh, time_high_sec: null, unilateral: false }],
        restSec: 900,
      });
    expect(est(2, 20)).toBeGreaterThan(1800); // primary 2세트는 못 들어간다
    expect(est(2, 5)).toBeLessThanOrEqual(1800); // accessory 2세트는 들어간다
  });

  it("cap 과 시간 예산이 둘 다 지켜진다", () => {
    const many = Array.from({ length: 12 }, (_u, i) => candidate(`e_${i}`));
    const packed = packSession({ candidates: [primary, ...many], minutesPerDay: 30, restSec: 60 });
    const totalSets = packed.reduce((a, p) => a + p.sets, 0);
    expect(totalSets).toBeLessThanOrEqual(SESSION_SET_CAP[30]!);
    const seconds = estimateSessionSeconds({
      exercises: packed.map((p) => ({
        sets: p.sets,
        reps_high: p.candidate.target_reps_high,
        time_high_sec: p.candidate.target_time_high_sec,
        unilateral: p.candidate.unilateral,
      })),
      restSec: 60,
    });
    expect(seconds).toBeLessThanOrEqual(30 * 60);
  });
});

describe("프로그램 생성 — legacy 동결 + V2 packer", () => {
  let app: INestApplication;
  let programs: ProgramsService;
  let prisma: PrismaService;
  let catalog: Map<string, CatalogRow>;
  let catalogRows: Awaited<ReturnType<PrismaService["exercise"]["findMany"]>>;

  beforeAll(async () => {
    app = await createTestApp();
    programs = app.get(ProgramsService);
    prisma = app.get(PrismaService);
    // 전체 행이 필요하다 — selection context 가 equipment/pattern 까지 본다.
    catalogRows = await prisma.exercise.findMany();
    const rows = catalogRows;
    catalog = new Map(
      rows.map((r) => [
        r.id,
        {
          unilateral: r.unilateral,
          mechanic: String(r.mechanic),
          movementPattern: String(r.movementPattern),
          metric: String(r.metric),
        },
      ]),
    );
    expect(catalog.size).toBeGreaterThan(0);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, DEV_USER_ID);
  });

  it("활성 상수는 아직 2026.08.1 이다 — activation 전 production 은 legacy 만 탄다", () => {
    expect(RULES_VERSION).toBe("2026.08.1");
  });

  it("baseline106 catalog의 legacy 225조합이 **커밋된 fixture 와 정확히 같다**", async () => {
    // current-vs-current(같은 코드로 두 번 생성해 비교)는 규칙을 바꿔도 양쪽이 함께 바뀌어
    // **항상 통과**한다. 커밋된 정적 fixture 와 exact equality 로 비교해야 회귀가 잡힌다.
    expect(fixture.rules_version).toBe("2026.08.1");
    expect(fixture.cases).toHaveLength(EXPECTED_PROGRAMS);

    const expected = new Map(fixture.cases.map((c) => [c.key, c]));
    const mismatches: string[] = [];
    let compared = 0;

    for (const goal of GOALS) {
      for (const days of DAYS) {
        for (const minutes of MINUTES) {
          for (const level of LEVELS) {
            const key = planKey(goal, days, minutes, level);
            await resetUserData(prisma, DEV_USER_ID);
            const actual = normalizeProgram(
              key,
              // Freeze the original catalog candidates; later 225-case tests still use all110.
              await programs.generate(DEV_USER_ID, {
                ...dto(goal, days, minutes, level),
                avoid_exercises: CATALOG_ADDITION_IDS,
              }),
            );
            const want = expected.get(key);
            compared += 1;
            if (want === undefined) {
              mismatches.push(`${key}: fixture 에 없음`);
              continue;
            }
            if (JSON.stringify(actual) !== JSON.stringify(want)) {
              mismatches.push(key);
            }
          }
        }
      }
    }

    expect(compared).toBe(EXPECTED_PROGRAMS);
    expect(mismatches).toEqual([]);
  }, 900_000);

  it("legacy 225조합 전부 생성되고 V1 세트 규칙을 지킨다", async () => {
    const violations: string[] = [];
    let programCount = 0;
    let sessionCount = 0;

    for (const goal of GOALS) {
      for (const days of DAYS) {
        for (const minutes of MINUTES) {
          for (const level of LEVELS) {
            await resetUserData(prisma, DEV_USER_ID);
            const program = await programs.generate(DEV_USER_ID, dto(goal, days, minutes, level));
            const label = `${goal}/${days}일/${minutes}분/${level}`;
            programCount += 1;
            if (program.sessions.length !== days) {
              violations.push(`${label}: sessions ${program.sessions.length} != ${days}`);
            }
            if (program.rules_version !== "2026.08.1") {
              violations.push(`${label}: rules_version ${program.rules_version}`);
            }
            for (const session of program.sessions) {
              sessionCount += 1;
              // V1 은 고정 EXERCISE_COUNT 표를 쓴다 — packer 가 legacy 를 침범하지 않았는지 본다.
              if (session.exercises.length > LEGACY_COUNT[minutes]!) {
                violations.push(
                  `${label}/${session.focus}: count ${session.exercises.length} > ${LEGACY_COUNT[minutes]}`,
                );
              }
              for (const exercise of session.exercises) {
                // V1 세트 규칙: strength compound 5, 그 외 3. packer 의 2세트는 나오지 않는다.
                if (![3, 5].includes(exercise.sets)) {
                  violations.push(`${label}/${exercise.exercise_id}: sets ${exercise.sets}`);
                }
              }
            }
          }
        }
      }
    }

    expect(programCount).toBe(EXPECTED_PROGRAMS);
    expect(sessionCount).toBe(EXPECTED_SESSIONS);
    expect(violations).toEqual([]);
  }, 900_000);

  it("예약 bundle packer 는 225 프로그램 900 세션 전수에서 시간·cap 을 만족한다", async () => {
    // **첫 실패에서 멈추지 않는다.** 전부 모아 개수와 목록을 함께 단언한다 —
    // 하나만 보고 멈추면 "고쳤다"고 믿은 뒤 다음 조합에서 다시 터진다.
    const timeViolations: string[] = [];
    const capViolations: string[] = [];
    const emptyViolations: string[] = [];
    const primaryViolations: string[] = [];
    const catalogMisses: string[] = [];
    let programCount = 0;
    let sessionCount = 0;

    for (const goal of GOALS) {
      for (const days of DAYS) {
        for (const minutes of MINUTES) {
          for (const level of LEVELS) {
            await resetUserData(prisma, DEV_USER_ID);
            const generateDto = dto(goal, days, minutes, level);
            const context = buildProgramSelectionContext(catalogRows, generateDto);
            const program = await programs.generateWithRulesVersion(
              DEV_USER_ID,
              generateDto,
              RULES_BUNDLE_V2,
            );
            const label = `${goal}/${days}일/${minutes}분/${level}`;
            programCount += 1;
            expect(program.rules_version).toBe(RULES_BUNDLE_V2);

            for (const session of program.sessions) {
              sessionCount += 1;
              const budget = minutes * 60;
              const cap = SESSION_SET_CAP[minutes]!;

              if (session.exercises.length === 0) {
                emptyViolations.push(`${label}/${session.focus}`);
                continue;
              }

              const totalSets = session.exercises.reduce((a, e) => a + e.sets, 0);
              if (totalSets > cap) {
                capViolations.push(`${label}/${session.focus}: sets ${totalSets} > ${cap}`);
              }

              // **카탈로그 miss 를 기본값으로 덮지 않는다.** 덮으면 시드가 빠져도 조용히 통과하고
              // 그때부터 이 테스트는 실제 metadata 가 아니라 기본값을 검증하게 된다.
              const missing = findCatalogMisses(
                session.exercises.map((e) => e.exercise_id),
                catalog,
              );
              if (missing.length > 0) {
                catalogMisses.push(`${label}/${session.focus}: ${missing.join(",")}`);
                continue;
              }

              const seconds = estimateSessionSeconds({
                exercises: session.exercises.map((e) => ({
                  sets: e.sets,
                  reps_high: e.reps_high,
                  time_high_sec: e.time_high_sec,
                  unilateral: catalog.get(e.exercise_id)!.unilateral,
                })),
                restSec: restSecFor(goal),
              });
              if (seconds > budget) {
                timeViolations.push(`${label}/${session.focus}: ${seconds}s > ${budget}s`);
              }

              // **원래 primary 가 결과에 그대로 남았는지**를 본다.
              // 생존자만 놓고 role 을 다시 매기면 아무나 primary 로 승격돼 항상 통과한다.
              // **pack 이전 후보**로 원래 primary 를 구한다.
              // packed 생존자를 다시 assign 하면 아무나 primary 로 승격돼 항상 통과한다.
              const prePack = selectPrePackExercises(
                context,
                session.focus as Parameters<typeof selectPrePackExercises>[1],
              );
              const roles = assignRoles(prePack.map((e) => toPackCandidate(goal, e)));
              const survived = originalPrimarySurvived(
                roles,
                new Set(session.exercises.map((e) => e.exercise_id)),
              );
              if (!survived.ok) {
                primaryViolations.push(`${label}/${session.focus}: primary ${survived.primaryId}`);
              }
            }
          }
        }
      }
    }

    expect(programCount).toBe(EXPECTED_PROGRAMS);
    expect(sessionCount).toBe(EXPECTED_SESSIONS);
    expect({
      time: timeViolations.length,
      cap: capViolations.length,
      empty: emptyViolations.length,
      primary: primaryViolations.length,
      catalogMiss: catalogMisses.length,
    }).toEqual({ time: 0, cap: 0, empty: 0, primary: 0, catalogMiss: 0 });
    // 개수만 맞추고 끝내지 않는다 — 목록을 그대로 보여줘야 무엇이 깨졌는지 안다.
    expect([
      ...timeViolations,
      ...capViolations,
      ...emptyViolations,
      ...primaryViolations,
      ...catalogMisses,
    ]).toEqual([]);
  }, 900_000);

  it("V2 세트는 2~3 만 나온다(4·5 는 defer)", async () => {
    const bad: string[] = [];
    for (const goal of GOALS) {
      for (const minutes of MINUTES) {
        await resetUserData(prisma, DEV_USER_ID);
        const program = await programs.generateWithRulesVersion(
          DEV_USER_ID,
          dto(goal, 3, minutes, "intermediate"),
          RULES_BUNDLE_V2,
        );
        for (const session of program.sessions) {
          for (const e of session.exercises) {
            if (e.sets < 2 || e.sets > 3)
              bad.push(`${goal}/${minutes}분/${e.exercise_id}:${e.sets}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it("대표 조합 diet/30분 의 실제 추정 소요를 기록한다", async () => {
    // 이 조합이 `unilateral: true` 가정 때문에 2178s 로 잘못 계산되던 곳이다.
    // 실제 metadata 로는 예산 안에 들어온다 — 숫자를 남겨 회귀를 눈으로 잡는다.
    await resetUserData(prisma, DEV_USER_ID);
    const program = await programs.generateWithRulesVersion(
      DEV_USER_ID,
      dto("diet", 3, 30, "intermediate"),
      RULES_BUNDLE_V2,
    );
    const seconds = program.sessions.map((s) =>
      estimateSessionSeconds({
        exercises: s.exercises.map((e) => ({
          sets: e.sets,
          reps_high: e.reps_high,
          time_high_sec: e.time_high_sec,
          unilateral: catalog.get(e.exercise_id)?.unilateral ?? false,
        })),
        restSec: restSecFor("diet"),
      }),
    );
    expect(seconds.every((s) => s <= 1800)).toBe(true);
    // 상한만 보면 값이 절반이 돼도 통과한다. 최댓값 자체를 좁은 범위로 고정한다.
    const max = Math.max(...seconds);
    expect(max).toBeGreaterThan(1200);
    expect(max).toBeLessThanOrEqual(1800);
  }, 120_000);

  it("같은 입력이라도 bundle 이 다르면 다른 계획이 나온다(분기가 실제로 산다)", async () => {
    await resetUserData(prisma, DEV_USER_ID);
    const legacy = representation(
      await programs.generate(DEV_USER_ID, dto("strength", 3, 30, "intermediate")),
    );
    await resetUserData(prisma, DEV_USER_ID);
    const v2 = representation(
      await programs.generateWithRulesVersion(
        DEV_USER_ID,
        dto("strength", 3, 30, "intermediate"),
        RULES_BUNDLE_V2,
      ),
    );
    // legacy 30분 strength = 3운동×5세트, V2 = 2운동×3세트.
    expect(v2).not.toBe(legacy);
  }, 120_000);
});
