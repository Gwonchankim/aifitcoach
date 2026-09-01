import { describe, expect, it } from "vitest";
import {
  assignRoles,
  estimateSessionSeconds,
  packSession,
  SESSION_SET_CAP,
  TIME_CONSTANTS,
} from "../src/session-plan";
import type { PackCandidate, SessionRole } from "../src/session-plan";

/**
 * V2-PLAN-01 계약(docs/PROGRAM_V2_CONTRACT.md §4.4).
 * cap 과 시간 예산은 **둘 다 hard constraint** 이고 더 엄격한 쪽이 구속한다.
 */

const REST = { strength: 180, hypertrophy: 120, diet: 90 } as const;
/** 목표별 compound 반복 상단(program-rules 와 같은 값). 수행시간 계산에 쓴다. */
const REPS_HIGH = { strength: 5, hypertrophy: 12, diet: 12 } as const;

function candidate(over: Partial<PackCandidate> & { id: string }): PackCandidate {
  return {
    mechanic: "compound",
    movement_pattern: "squat",
    unilateral: false,
    metric: "reps",
    target_reps_high: 12,
    target_time_high_sec: null,
    ...over,
  };
}

/** 30분 세션에서 실제로 뽑히는 모양: compound 만 앞에 온다(mechanicFirst). */
function compounds(n: number, repsHigh: number): PackCandidate[] {
  const patterns = ["squat", "horizontal_push", "horizontal_pull", "hinge", "vertical_push"];
  return Array.from({ length: n }, (_u, i) =>
    candidate({
      id: `c${i}`,
      movement_pattern: patterns[i % patterns.length]!,
      target_reps_high: repsHigh,
    }),
  );
}

describe("estimateSessionSeconds", () => {
  it("휴식은 운동별 (sets-1)×rest 이고 마지막 세트 뒤는 세지 않는다", () => {
    const one = estimateSessionSeconds({
      exercises: [{ sets: 3, reps_high: 5, time_high_sec: null, unilateral: false }],
      restSec: 180,
    });
    // 480 warmup + 300 cooldown + (3-1)*180 rest + 3*clamp(20)=60 work + 전환 0
    expect(one).toBe(480 + 300 + 360 + 60);
  });

  it("전환은 (운동 수 - 1) × 90초다", () => {
    const two = estimateSessionSeconds({
      exercises: [
        { sets: 3, reps_high: 5, time_high_sec: null, unilateral: false },
        { sets: 3, reps_high: 5, time_high_sec: null, unilateral: false },
      ],
      restSec: 180,
    });
    expect(two).toBe(480 + 300 + 2 * 360 + 6 * 20 + 90);
  });

  it("수행시간은 clamp(reps_high×4, 20, 90) 이다", () => {
    const low = estimateSessionSeconds({
      exercises: [{ sets: 1, reps_high: 3, time_high_sec: null, unilateral: false }],
      restSec: 0,
    });
    const high = estimateSessionSeconds({
      exercises: [{ sets: 1, reps_high: 40, time_high_sec: null, unilateral: false }],
      restSec: 0,
    });
    expect(low - 780).toBe(20); // 3*4=12 → 하한 20
    expect(high - 780).toBe(90); // 40*4=160 → 상한 90
  });

  it("시간 종목은 target_time_high_sec 를 그대로 쓴다", () => {
    const t = estimateSessionSeconds({
      exercises: [{ sets: 2, reps_high: null, time_high_sec: 60, unilateral: false }],
      restSec: 60,
    });
    expect(t).toBe(480 + 300 + 60 + 120);
  });

  it("unilateral 은 수행시간만 2배다(휴식·전환은 그대로)", () => {
    const base = { sets: 3, reps_high: 12, time_high_sec: null };
    const normal = estimateSessionSeconds({
      exercises: [{ ...base, unilateral: false }],
      restSec: 120,
    });
    const uni = estimateSessionSeconds({
      exercises: [{ ...base, unilateral: true }],
      restSec: 120,
    });
    expect(uni - normal).toBe(3 * 48); // work 만 3세트분 추가
  });

  it("additional_fixed_block_sec 를 그대로 더한다(cardio 전용 분기 없음)", () => {
    const plan = {
      exercises: [{ sets: 3, reps_high: 12, time_high_sec: null, unilateral: false }],
      restSec: 120,
    };
    expect(estimateSessionSeconds({ ...plan, additional_fixed_block_sec: 600 })).toBe(
      estimateSessionSeconds(plan) + 600,
    );
  });

  it("상수는 단일값이다(범위 금지)", () => {
    expect(TIME_CONSTANTS.warmupSec).toBe(480);
    expect(TIME_CONSTANTS.cooldownReserveSec).toBe(300);
    expect(TIME_CONSTANTS.transitionSec).toBe(90);
  });
});

describe("assignRoles", () => {
  it("core pattern 은 core 다", () => {
    const roles = assignRoles([
      candidate({ id: "a" }),
      candidate({ id: "p", movement_pattern: "core" }),
    ]);
    expect(roles.get("p")).toBe("core");
  });

  it("첫 feasible non-core 가 primary 다", () => {
    const roles = assignRoles([
      candidate({ id: "core1", movement_pattern: "core" }),
      candidate({ id: "first" }),
      candidate({ id: "second", movement_pattern: "hinge" }),
    ]);
    expect(roles.get("first")).toBe("primary");
    expect(roles.get("second")).toBe("secondary");
  });

  it("compound 가 하나도 없으면 isolation 도 primary 가 된다(safety fallback)", () => {
    const roles = assignRoles([
      candidate({ id: "iso1", mechanic: "isolation", movement_pattern: "elbow_flexion" }),
      candidate({ id: "iso2", mechanic: "isolation", movement_pattern: "elbow_extension" }),
    ]);
    expect(roles.get("iso1")).toBe("primary");
    expect(roles.get("iso2")).toBe("accessory");
  });

  it("나머지 compound=secondary, 나머지 isolation=accessory", () => {
    const roles = assignRoles([
      candidate({ id: "p" }),
      candidate({ id: "c2", movement_pattern: "hinge" }),
      candidate({ id: "i1", mechanic: "isolation", movement_pattern: "calf" }),
    ]);
    expect([...roles.values()]).toEqual<SessionRole[]>(["primary", "secondary", "accessory"]);
  });
});

describe("packSession — cap 과 시간이 둘 다 hard", () => {
  it("30분 strength 는 2운동×3세트로 성립한다", () => {
    const packed = packSession({
      candidates: compounds(3, REPS_HIGH.strength),
      minutesPerDay: 30,
      restSec: REST.strength,
    });
    expect(packed).toHaveLength(2);
    expect(packed.every((p) => p.sets === 3)).toBe(true);
    expect(packed[0]!.role).toBe("primary");
  });

  // 잠긴 상수(warmup 480 + cooldown 300)에서는 30분 hypertrophy 9세트를 **시간과 cap 이 모두** 막는다.
  // cap 단독으로 막히는 셀은 긴 시간대다(diet 90분: 24/24 세트인데 추정은 66.7/90분).
  it("30분 hypertrophy 는 9세트를 만들지 않는다(cap·시간 둘 다 막는다)", () => {
    const packed = packSession({
      candidates: compounds(3, REPS_HIGH.hypertrophy),
      minutesPerDay: 30,
      restSec: REST.hypertrophy,
    });
    const totalSets = packed.reduce((a, p) => a + p.sets, 0);
    expect(totalSets).toBeLessThanOrEqual(SESSION_SET_CAP[30]!);
    expect(totalSets).not.toBe(9);
  });

  it("30분 diet 도 성립한다", () => {
    const packed = packSession({
      candidates: compounds(3, REPS_HIGH.diet),
      minutesPerDay: 30,
      restSec: REST.diet,
    });
    expect(packed.length).toBeGreaterThanOrEqual(1);
  });

  it("primary 는 feasible 하면 항상 살아남는다", () => {
    for (const goal of ["strength", "hypertrophy", "diet"] as const) {
      for (const minutes of [30, 45, 60, 75, 90]) {
        const packed = packSession({
          candidates: compounds(7, REPS_HIGH[goal]),
          minutesPerDay: minutes,
          restSec: REST[goal],
        });
        expect(packed.length, `${goal} ${minutes}`).toBeGreaterThanOrEqual(1);
        expect(packed[0]!.role, `${goal} ${minutes}`).toBe("primary");
      }
    }
  });

  it("accessory 가 남은 채 primary 가 빠지지 않는다", () => {
    for (const goal of ["strength", "hypertrophy", "diet"] as const) {
      for (const minutes of [30, 45, 60, 75, 90]) {
        const candidates = [
          ...compounds(4, REPS_HIGH[goal]),
          candidate({ id: "iso", mechanic: "isolation", movement_pattern: "calf" }),
          candidate({ id: "core", movement_pattern: "core", mechanic: "isolation" }),
        ];
        const packed = packSession({ candidates, minutesPerDay: minutes, restSec: REST[goal] });
        const roles = new Set(packed.map((p) => p.role));
        if (roles.has("accessory")) expect(roles.has("primary"), `${goal} ${minutes}`).toBe(true);
      }
    }
  });

  it("core 는 accessory 보다 나중에 잘린다", () => {
    const candidates = [
      ...compounds(1, REPS_HIGH.strength),
      candidate({
        id: "iso",
        mechanic: "isolation",
        movement_pattern: "calf",
        target_reps_high: 12,
      }),
      candidate({
        id: "core",
        movement_pattern: "core",
        mechanic: "isolation",
        metric: "time",
        target_reps_high: null,
        target_time_high_sec: 60,
      }),
    ];
    const packed = packSession({ candidates, minutesPerDay: 45, restSec: REST.strength });
    const roles = packed.map((p) => p.role);
    // accessory 가 들어갔다면 core 도 반드시 들어가 있어야 한다(core 가 먼저 잘리면 안 된다).
    if (roles.includes("accessory")) expect(roles).toContain("core");
  });

  it("모든 조합에서 시간·cap 을 동시에 만족한다(property)", () => {
    for (const goal of ["strength", "hypertrophy", "diet"] as const) {
      for (const minutes of [30, 45, 60, 75, 90]) {
        for (const n of [1, 3, 5, 7]) {
          const candidates = compounds(n, REPS_HIGH[goal]);
          const packed = packSession({ candidates, minutesPerDay: minutes, restSec: REST[goal] });
          const label = `${goal} ${minutes} n=${n}`;
          const seconds = estimateSessionSeconds({
            exercises: packed.map((p) => ({
              sets: p.sets,
              reps_high: p.candidate.target_reps_high,
              time_high_sec: p.candidate.target_time_high_sec,
              unilateral: p.candidate.unilateral,
            })),
            restSec: REST[goal],
          });
          expect(seconds, label).toBeLessThanOrEqual(minutes * 60);
          const sets = packed.reduce((a, p) => a + p.sets, 0);
          expect(sets, label).toBeLessThanOrEqual(SESSION_SET_CAP[minutes]!);
        }
      }
    }
  });

  it("세트는 2~3 범위이고 4·5세트를 만들지 않는다(PLAN-01 범위)", () => {
    for (const minutes of [30, 45, 60, 75, 90]) {
      const packed = packSession({
        candidates: compounds(7, REPS_HIGH.hypertrophy),
        minutesPerDay: minutes,
        restSec: REST.hypertrophy,
      });
      for (const p of packed) {
        expect(p.sets).toBeGreaterThanOrEqual(2);
        expect(p.sets).toBeLessThanOrEqual(3);
      }
    }
  });

  it("결정론적이다 — 같은 입력 100회가 같은 출력", () => {
    const input = {
      candidates: compounds(5, REPS_HIGH.hypertrophy),
      minutesPerDay: 60,
      restSec: REST.hypertrophy,
    };
    const first = JSON.stringify(packSession(input));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(packSession(input))).toBe(first);
  });
});
