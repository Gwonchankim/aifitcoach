import { readFileSync } from "node:fs";
import path from "node:path";
import type { RecommendedAction } from "shared";
import { recommendedActionFor } from "../src/programs/assistance-migration";
import { RecommendationService } from "../src/recommendation/recommendation.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { CURRENT_CATALOG } from "./support/catalog-extension";

// Optional metadata signature is the approved contract; keep TDD runnable before implementation.
const actionFor = recommendedActionFor as (
  reason: string,
  id?: string,
  semantics?: string,
) => RecommendedAction | null;

describe("ticket02 canonical assistance transition", () => {
  it("expects the 110-row catalog including exactly one assisted dips", () => {
    const seed = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../../docs/specs/exercises_seed.json"), "utf8"),
    ) as { exercises: { id: string }[] };
    expect(seed.exercises).toHaveLength(110);
    expect(seed.exercises.filter((row) => row.id === "e_assisted_dips")).toHaveLength(1);
  });

  it.each([
    ["e_assisted_pullup", "e_pullup"],
    ["e_assisted_dips", "e_dips"],
  ])("%s minimum proposes only its canonical target", (id, target) => {
    expect(actionFor("ASSISTANCE_MINIMUM_REACHED", id, "assistance")).toEqual({
      kind: "suggest_exercise_swap",
      exercise_id: target,
    });
  });

  it.each([undefined, "unknown", "e_bench_press"])(
    "%s metadata never falls back to pullup",
    (id) => {
      expect(actionFor("ASSISTANCE_MINIMUM_REACHED", id, "assistance")).toBeNull();
    },
  );

  it.each(["e_assisted_pullup", "e_assisted_dips"])(
    "%s requires assistance snapshot and minimum reason",
    (id) => {
      expect(actionFor("ASSISTANCE_MINIMUM_REACHED", id, "external_load")).toBeNull();
      expect(actionFor("ASSISTANCE_MINIMUM_REACHED", id)).toBeNull();
      for (const reason of [
        "ASSISTANCE_DOWN_REP_TARGET_MET",
        "SUBSTITUTE_PAIN",
        "INVALID_INPUT",
        "ASSISTANCE_CALIBRATION_NEEDED",
      ])
        expect(actionFor(reason, id, "assistance")).toBeNull();
    },
  );
});

describe("recommendation input and persisted action metadata", () => {
  const service = new RecommendationService({} as PrismaService);
  it.each(["e_assisted_pullup", "e_assisted_dips"])(
    "%s keeps direction/step/numbers and same canonical minimum target",
    (id) => {
      const exercise = CURRENT_CATALOG.find((row) => row.id === id)!;
      for (const [weight, reps, rir, expected] of [
        [20, 12, 2, 17.5],
        [20, 4, 0, 22.5],
        [2.5, 12, 2, 2.5],
      ]) {
        const result = service.recommend({
          goal: "hypertrophy",
          exercise,
          target: { reps_low: 6, reps_high: 12, rir: 2 },
          history: {
            lastSets: [{ w: weight, reps, rir }],
            assistance: { has_valid_positive_assistance: true },
          },
        });
        expect(result.weight).toBe(expected);
        expect(result.recommended_action ?? null).toEqual(
          weight === 2.5
            ? {
                kind: "suggest_exercise_swap",
                exercise_id: id === "e_assisted_dips" ? "e_dips" : "e_pullup",
              }
            : null,
        );
      }
    },
  );
  it.each([undefined, "unknown", "e_bench_press", "e_assisted_pullup", "e_assisted_dips"])(
    "persisted %s honors snapshot rather than ID alone",
    (id) => {
      for (const loadSemantics of ["external_load", "assistance"] as const)
        for (const reasonCode of [
          "ASSISTANCE_MINIMUM_REACHED",
          "ASSISTANCE_DOWN_REP_TARGET_MET",
          "SUBSTITUTE_PAIN",
          "INVALID_INPUT",
        ]) {
          const row = {
            recommendedWeight:
              reasonCode === "SUBSTITUTE_PAIN" || reasonCode === "INVALID_INPUT" ? null : 2.5,
            recommendedReps: 6,
            targetRepsLow: 6,
            targetRepsHigh: 12,
            targetTimeLowSec: null,
            targetTimeHighSec: null,
            reasonCode,
            confidence: 0.85,
            rulesVersion: "2026.08.2",
            loadSemantics,
          };
          expect(service.plannedToApi(id ?? "", 1, row).recommended_action).toEqual(
            actionFor(reasonCode, id, loadSemantics),
          );
        }
    },
  );
});
