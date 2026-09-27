import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSeedFile, parseSeedRows } from "../prisma/seed-exercises";
import { assertResistanceExercise, isResistanceExercise } from "../src/exercises/exercise-domain";

const baseline = JSON.parse(
  readFileSync(resolve(__dirname, "support/catalog-baseline-110-domain.fixture"), "utf8"),
);
const seedPath = resolve(__dirname, "../../../docs/specs/exercises_seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

describe("S1 canonical exercise modality", () => {
  it("110 explicit resistance entries preserve every baseline field and ID", () => {
    expect(baseline.capture_commit).toBe("1e1573747d08ee9817c7af29d05bfc97412cd4a5");
    expect(seed.exercises).toHaveLength(110);
    expect(
      seed.exercises.map(({ modality, ...old }: Record<string, unknown>) => {
        expect(modality).toBe("resistance");
        return old;
      }),
    ).toEqual(baseline.catalog.exercises);
    expect(
      seed.exercises.filter((row: { modality: string }) => row.modality !== "resistance"),
    ).toEqual([]);
    expect(parseSeedFile()).toHaveLength(110);
  });
  it("rejects a missing ID even when every remaining substitution resolves", () => {
    const rows = seed.exercises
      .slice(1)
      .map((row: Record<string, unknown>) => ({ ...row, substitutions: [] }));
    expect(() => parseSeedRows(rows)).toThrow(/canonical/);
  });
  it("rejects an unknown ID instead of classifying it by resistance-looking fields", () => {
    expect(() =>
      parseSeedRows([...seed.exercises, { ...seed.exercises[0], id: "e_unknown" }]),
    ).toThrow(/canonical/);
  });
  it.each([undefined, null, "unknown", "cardio"])(
    "rejects missing or unapproved seed modality %s",
    (modality) => {
      const rows = seed.exercises.map((row: Record<string, unknown>, index: number) =>
        index === 0 ? { ...row, modality } : row,
      );
      expect(() => parseSeedRows(rows)).toThrow(/modality/);
    },
  );

  const valid = {
    modality: "resistance",
    movementPattern: "squat",
    mechanic: "compound",
    region: "lower",
    loadSemantics: "external_load",
    metric: "reps",
    defaultRepsLow: 6,
    defaultRepsHigh: 12,
    defaultTimeLowSec: null,
    defaultTimeHighSec: null,
    defaultStepKg: 2.5,
  };
  it("accepts explicit resistance and sufficient legacy null classification", () => {
    expect(isResistanceExercise(valid)).toBe(true);
    expect(isResistanceExercise({ ...valid, modality: null })).toBe(true);
    expect(() => assertResistanceExercise(valid)).not.toThrow();
  });
  it.each(["cardio", "mobility", "warmup", "unknown"])(
    "does not infer %s as resistance",
    (modality) => {
      expect(isResistanceExercise({ ...valid, modality })).toBe(false);
      expect(() => assertResistanceExercise({ ...valid, modality })).toThrow();
    },
  );
  it.each(["movementPattern", "mechanic", "region", "loadSemantics"])(
    "rejects missing legacy %s",
    (key) => {
      expect(isResistanceExercise({ ...valid, modality: null, [key]: null })).toBe(false);
    },
  );
  it("plank remains resistance/time with its existing time bounds", () => {
    const plank = parseSeedFile().find((row) => row.id === "e_plank")!;
    expect(isResistanceExercise(plank)).toBe(true);
    expect(plank.metric).toBe("time");
    expect(plank.modality).toBe("resistance");
  });
});
