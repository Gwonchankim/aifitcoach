import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(__dirname, "../../..");
const seed = JSON.parse(readFileSync(resolve(root, "docs/specs/exercises_seed.json"), "utf8"));
const migration = () => readFileSync(resolve(root, "apps/api/prisma/migrations/20260928010000_cardio_prescription/migration.sql"), "utf8");
describe("S2 canonical cardio storage domain", () => {
  it("adds the exact D7 bike and leaves all 110 resistance objects unchanged", () => {
    const original = JSON.parse(readFileSync(resolve(__dirname, "support/catalog-baseline-110-domain.fixture"), "utf8"));
    const resistance = seed.exercises.filter((e: { modality: string }) => e.modality === "resistance");
    expect(resistance).toHaveLength(110);
    expect(resistance.map(({ modality, ...e }: Record<string, unknown>) => { expect(modality).toBe("resistance"); return e; })).toEqual(original.catalog.exercises);
    expect(seed.exercises).toHaveLength(111);
    expect(seed.exercises.filter((e: { modality: string }) => e.modality !== "resistance")).toEqual([{
      id: "e_stationary_bike", modality: "cardio", name_ko: "고정식 자전거", name_en: "Stationary Bike", movement_pattern: null, mechanic: null, region: null,
      primary_muscles: [], secondary_muscles: [], equipment: "stationary_bike", difficulty: "beginner", metric: "time", default_reps_low: null, default_reps_high: null,
      default_time_low_sec: null, default_time_high_sec: null, default_step_kg: null, load_semantics: null, unilateral: false, substitutions: [], cues: [], media: {},
      cardio_movement_regions: ["lower"], prescription_kinds_supported: ["steady_cardio", "interval_cardio"], blocked_reported_pain_areas: ["knee", "lower_back", "shoulder", "elbow", "wrist", "hip", "neck", "ankle"],
    }]);
  });
  it("migration leaves old prescriptions untouched and computes interval totals without int overflow", () => {
    const sql = migration();
    expect(sql).not.toMatch(/UPDATE\s+"?planned_sets/i);
    expect(sql).toContain('"work_sec"::bigint');
    expect(sql).toContain('"recovery_sec"::bigint');
    for (const field of ["duration_sec", "rpe_scale_id", "target_rpe_low", "target_rpe_high", "long_session_flag", "progression_axis", "source_day", "source_ordinal", "intensity_seconds"])
      expect(sql).toContain(`"${field}" IS NOT NULL`);
  });
});
