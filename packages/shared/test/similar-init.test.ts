import { describe, expect, it } from "vitest";
import { isAssistedExercise } from "../src/assistance-transition";
import catalog from "../../../docs/specs/exercises_seed.json";
import {
  SIMILAR_INIT_DEFAULT_RATIO,
  SIMILAR_INIT_PAIRS,
  similarSourcesFor,
} from "../src/similar-init";

type CatalogExercise = (typeof catalog.exercises)[number] & { load_semantics?: string };

function assertSimilarInitPairs(
  pairs: typeof SIMILAR_INIT_PAIRS,
  exercises: readonly CatalogExercise[],
): void {
  for (const targetId of Object.keys(pairs)) {
    const target = exercises.find((e) => e.id === targetId)!;
    expect(target, targetId).toBeDefined();
    for (const { source, ratio = SIMILAR_INIT_DEFAULT_RATIO } of pairs[targetId]!) {
      const from = exercises.find((e) => e.id === source)!;
      expect(from, source).toBeDefined();
      expect(source).not.toBe(targetId);
      expect(from.movement_pattern, targetId + " <- " + source).toBe(target.movement_pattern);
      expect(from.mechanic).toBe(target.mechanic);
      expect(from.primary_muscles.some((m) => target.primary_muscles.includes(m))).toBe(true);
      for (const exercise of [target, from]) {
        const canonical = isAssistedExercise(exercise.id) ? "assistance" : "external_load";
        if (exercise.load_semantics !== undefined) {
          expect(exercise.load_semantics, exercise.id + " canonical semantics").toBe(canonical);
        }
        expect(canonical, exercise.id + " must be external_load").toBe("external_load");
        expect(exercise.default_step_kg).toBeGreaterThan(0);
        expect(exercise.metric).toBe("reps");
      }
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(1);
    }
  }
}

describe("SIMILAR_INIT 쌍 표", () => {
  it("20행·23개 방향 쌍을 전수 검증한다", () => {
    expect(Object.keys(SIMILAR_INIT_PAIRS)).toHaveLength(20);
    expect(Object.values(SIMILAR_INIT_PAIRS).flat()).toHaveLength(23);
    assertSimilarInitPairs(SIMILAR_INIT_PAIRS, catalog.exercises);
  });

  it("어시스트 소스가 들어간 표 복사본을 거부한다", () => {
    const pairs = {
      ...SIMILAR_INIT_PAIRS,
      e_neutral_grip_pulldown: [{ source: "e_assisted_pullup" }],
    };
    expect(() => assertSimilarInitPairs(pairs, catalog.exercises)).toThrow("external_load");
  });

  it("어시스트 대상이 들어간 표 복사본을 거부한다", () => {
    const pairs = {
      ...SIMILAR_INIT_PAIRS,
      e_assisted_pullup: [{ source: "e_lat_pulldown" }],
    };
    expect(() => assertSimilarInitPairs(pairs, catalog.exercises)).toThrow("external_load");
  });

  it("명시된 seed semantics가 canonical 판정과 다르면 거부한다", () => {
    const exercises = catalog.exercises.map((e) =>
      e.id === "e_lat_pulldown" ? { ...e, load_semantics: "assistance" } : e,
    );
    expect(() => assertSimilarInitPairs(SIMILAR_INIT_PAIRS, exercises)).toThrow("canonical");
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
