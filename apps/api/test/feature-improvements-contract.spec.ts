import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { ROUTINE_RULES_VERSION } from "shared";
import { toJsonSchema } from "./support/openapi-response";

type Schema = Record<string, unknown>;
type Document = {
  paths: Record<string, Schema>;
  components: { schemas: Record<string, Schema> };
  "x-afc-status"?: string;
};
const specs = path.resolve(__dirname, "../../../docs/specs");
const active = parse(readFileSync(path.join(specs, "openapi.yaml"), "utf8")) as Document;
const reserved = parse(
  readFileSync(path.join(specs, "feature-improvements.openapi.yaml"), "utf8"),
) as Document;
const fixture = JSON.parse(
  readFileSync(path.join(specs, "feature_improvements_contract.json"), "utf8"),
) as {
  active_bundle: string;
  composition: { goal: string; days: number; legacy: string; revised: string }[];
  preferences: {
    days: number;
    preference: string;
    focus: string[];
    day_offsets: number[];
    expected_counts: number[];
  }[];
  recovery_counterexample: {
    day_offsets: number[];
    focus_before: string[];
    swap_indices: number[];
    focus_after: string[];
    expected_status: number;
    minimum_gap_hours: number;
  };
  synthetic_time_boundary: {
    not_a_cardio_prescription: boolean;
    minutes: number;
    warmup_sec: number;
    cooldown_sec: number;
    sets: number;
    reps_high: number;
    rest_sec: number;
    cardio_sec: number;
    expected_total_sec: number;
    expected_error: string;
  };
};

function visit(value: unknown, callback: (ref: string) => void): void {
  if (Array.isArray(value)) value.forEach((item) => visit(item, callback));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") callback(item);
      else visit(item, callback);
    }
  }
}

function referenceTarget(reference: string): unknown {
  const [file, fragment] = reference.split("#");
  if (file !== "" && file !== "./openapi.yaml")
    throw new Error(`Unexpected contract reference ${file}`);
  return fragment
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (value, part) => {
        if (value === null || typeof value !== "object") return undefined;
        return (value as Schema)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      },
      file ? active : reserved,
    );
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(toJsonSchema(active) as AnySchema, "https://afc.test/openapi.yaml");
ajv.addSchema(
  toJsonSchema(reserved) as AnySchema,
  "https://afc.test/feature-improvements.openapi.yaml",
);
const validate = (name: string, value: unknown) =>
  ajv.validate(
    `https://afc.test/feature-improvements.openapi.yaml#/components/schemas/${name}`,
    value,
  );
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

/** Reserved schema/fixture checks; these are not evidence that future routes work. */
describe("feature improvement reserved contract", () => {
  it("keeps future operations out of the active route contract and leaves V1 active", () => {
    expect(reserved["x-afc-status"]).toBe("reserved-not-implemented");
    expect(Object.keys(reserved.paths)).toHaveLength(4);
    for (const route of Object.keys(reserved.paths)) expect(active.paths[route]).toBeUndefined();
    expect(ROUTINE_RULES_VERSION).toBe("2026.08.1");
    expect(fixture.active_bundle).toBe(ROUTINE_RULES_VERSION);
  });

  it("resolves every reserved ref and compiles every schema", () => {
    visit(reserved, (reference) => expect(referenceTarget(reference)).toBeDefined());
    for (const name of Object.keys(reserved.components.schemas)) {
      expect(() =>
        ajv.compile({
          $ref: `https://afc.test/feature-improvements.openapi.yaml#/components/schemas/${name}`,
        }),
      ).not.toThrow();
    }
  });

  it("requires append source identity/revision, rejects client set numbers and ambiguous source", () => {
    const request = {
      client_id: id,
      exercise_id: "e_bench_press",
      correlation_id: other,
      source: { source_planned_set_id: id, source_revision: "snapshot-1" },
    };
    expect(validate("AppendSetRequest", request)).toBe(true);
    expect(validate("AppendSetRequest", { ...request, set_no: 3 })).toBe(false);
    expect(
      validate("AppendSetRequest", { ...request, source: { source_planned_set_id: id } }),
    ).toBe(false);
    expect(
      validate("AppendSetRequest", {
        ...request,
        source: { ...request.source, source_correlation_id: other },
      }),
    ).toBe(false);
    expect(
      validate("AppendSetRequest", { ...request, source: { source_correlation_id: other } }),
    ).toBe(true);
    expect(validate("AppendSetRequest", { ...request, client_id: "not-a-uuid" })).toBe(false);
  });

  it("requires both swap revisions and a two-session authoritative result", () => {
    const request = {
      client_id: id,
      today_session_id: id,
      target_session_id: other,
      today_revision: "a",
      target_revision: "b",
    };
    expect(validate("WeekSwapRequest", request)).toBe(true);
    expect(validate("WeekSwapRequest", { ...request, target_revision: undefined })).toBe(false);
    expect(
      validate("WeekSwapResult", {
        client_id: id,
        program_id: id,
        week_start: "2026-09-07",
        today_session_id: other,
        sessions: [],
      }),
    ).toBe(false);
  });

  it("preserves all 25 legacy composition cells and only converts C to H on four/five days", () => {
    const legacy: Record<string, string[]> = {
      diet: ["HH", "HHC", "HHCC", "HHCCC", "HHCCCC"],
      hypertrophy: ["SS", "SSH", "SSSH", "SSSSH", "SSSSHH"],
      strength: ["SS", "SSH", "SSSH", "SSSHC", "SSSSHC"],
      general_fitness: ["HH", "HHC", "SSCC", "SSHCC", "SSHHCC"],
      endurance: ["HH", "HHC", "HHCC", "HHCCC", "HHCCCC"],
    };
    expect(fixture.composition).toHaveLength(25);
    expect(new Set(fixture.composition.map(({ goal, days }) => `${goal}:${days}`)).size).toBe(25);
    for (const row of fixture.composition) {
      expect(row.legacy).toBe(legacy[row.goal][row.days - 2]);
      expect(row.revised).toBe(
        [4, 5].includes(row.days) ? row.legacy.replaceAll("C", "H") : row.legacy,
      );
      expect(row.revised).toHaveLength(row.days);
    }
  });

  it("locks exact balanced/priority counts and week-boundary recovery", () => {
    expect(
      fixture.preferences.map(({ days, preference, expected_counts }) => [
        days,
        preference,
        expected_counts,
      ]),
    ).toEqual([
      [4, "balanced", [2, 2]],
      [5, "balanced", [3, 2]],
      [5, "upper_priority", [3, 2]],
      [5, "lower_priority", [2, 3]],
    ]);
    for (const row of fixture.preferences) {
      expect([
        row.focus.filter((x) => x === "upper").length,
        row.focus.filter((x) => x === "lower").length,
      ]).toEqual(row.expected_counts);
      for (const focus of ["upper", "lower"]) {
        const days = row.day_offsets.filter((_, index) => row.focus[index] === focus);
        days.push(days[0] + 7);
        for (let index = 1; index < days.length; index++)
          expect((days[index] - days[index - 1]) * 24).toBeGreaterThanOrEqual(48);
      }
    }
  });

  it("makes the documented Monday/Friday swap counterexample fail recovery", () => {
    const row = fixture.recovery_counterexample;
    const focus = [...row.focus_before];
    const [a, b] = row.swap_indices;
    [focus[a], focus[b]] = [focus[b], focus[a]];
    expect(focus).toEqual(row.focus_after);
    for (const region of ["upper", "lower"]) {
      const dates = row.day_offsets.filter((_, index) => focus[index] === region);
      expect((dates[1] - dates[0]) * 24).toBe(row.minimum_gap_hours);
      expect(row.minimum_gap_hours).toBeLessThan(48);
    }
    expect(row.expected_status).toBe(409);
  });

  it("labels the 1866-second infeasible fixture as synthetic, never a cardio prescription", () => {
    const row = fixture.synthetic_time_boundary;
    const seconds =
      row.warmup_sec +
      row.cooldown_sec +
      row.sets * Math.min(90, Math.max(20, row.reps_high * 4)) +
      (row.sets - 1) * row.rest_sec +
      row.cardio_sec;
    expect(row.not_a_cardio_prescription).toBe(true);
    expect(seconds).toBe(1866);
    expect(seconds).toBe(row.expected_total_sec);
    expect(seconds).toBeGreaterThan(row.minutes * 60);
    expect(row.expected_error).toBe("insufficient_time_for_mixed_focus");
  });
});
