import { describe, expect, it } from "vitest";
import catalog from "../../../docs/specs/exercises_seed.json";
import { SIMILAR_INIT_PAIRS, similarSourcesFor } from "../src/similar-init";

describe("SIMILAR_INIT 쌍 표", () => {
  it("20행·23개 방향 쌍을 전수 검증한다", () => {
    expect(Object.keys(SIMILAR_INIT_PAIRS)).toHaveLength(20);
    expect(Object.values(SIMILAR_INIT_PAIRS).flat()).toHaveLength(23);
    for (const targetId of Object.keys(SIMILAR_INIT_PAIRS)) {
      const target = catalog.exercises.find((e) => e.id === targetId)!;
      expect(target, targetId).toBeDefined();
      for (const { source, ratio } of similarSourcesFor(targetId)) {
        const from = catalog.exercises.find((e) => e.id === source)!;
        expect(from, source).toBeDefined();
        expect(source).not.toBe(targetId);
        expect(from.movement_pattern, targetId + " <- " + source).toBe(target.movement_pattern);
        expect(from.mechanic).toBe(target.mechanic);
        expect(from.primary_muscles.some((m) => target.primary_muscles.includes(m))).toBe(true);
        for (const exercise of [target, from]) {
          // 기존 카탈로그 계약: 누락 load_semantics는 external_load다.
          expect((exercise as { load_semantics?: string }).load_semantics ?? "external_load").toBe(
            "external_load",
          );
          expect(exercise.default_step_kg).toBeGreaterThan(0);
          expect(exercise.metric).toBe("reps");
        }
        expect(ratio).toBeGreaterThan(0);
        expect(ratio).toBeLessThan(1);
      }
    }
  });

  it("소스 우선순위와 기본·예외 계수를 보존한다", () => {
    expect(similarSourcesFor("e_bench_press")).toEqual([
      { source: "e_incline_bench_press", ratio: 0.8 },
      { source: "e_decline_bench_press", ratio: 0.8 },
    ]);
    expect(similarSourcesFor("e_rdl")).toEqual([{ source: "e_deadlift", ratio: 0.7 }]);
    expect(similarSourcesFor("e_ohp")).toEqual([{ source: "e_push_press", ratio: 0.7 }]);
  });

  it("미지 종목은 소스가 없다", () => {
    for (const id of ["unknown", "constructor", "toString"])
      expect(similarSourcesFor(id)).toEqual([]);
  });
});
