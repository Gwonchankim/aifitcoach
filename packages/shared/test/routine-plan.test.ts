import { describe, expect, it } from "vitest";
import { buildProvisionalRoutineSets, routineSetCountFor } from "../src";

describe("offline provisional routine mirror", () => {
  const compound = {
    id: "e_bench_press",
    mechanic: "compound" as const,
    region: "upper" as const,
    step_kg: 2.5,
    metric: "reps" as const,
    default_time_low_sec: null,
    default_time_high_sec: null,
  };

  it("서버 기본 규칙과 같은 3/5 세트 수를 만든다", () => {
    expect(routineSetCountFor("hypertrophy", "compound")).toBe(3);
    expect(routineSetCountFor("strength", "compound")).toBe(5);
    expect(routineSetCountFor("strength", "isolation")).toBe(3);
  });

  it("correlation ID를 provisional planned-set ID로 쓰고 BASELINE 추천을 만든다", () => {
    const ids = ["c1", "c2", "c3"];
    expect(buildProvisionalRoutineSets("hypertrophy", compound, ids)).toEqual(
      ids.map((id, index) =>
        expect.objectContaining({
          id,
          exercise_id: compound.id,
          set_no: index + 1,
          target_reps_low: 6,
          target_reps_high: 12,
          target_rir: 2,
          rest_sec: 120,
          reason_code: "BASELINE",
        }),
      ),
    );
  });
});
