import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { toJsonSchema } from "./support/openapi-response";

const doc = parse(
  readFileSync(path.resolve(__dirname, "../../../docs/specs/openapi.yaml"), "utf8"),
);
const reserved = parse(
  readFileSync(
    path.resolve(__dirname, "../../../docs/specs/feature-improvements.openapi.yaml"),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(toJsonSchema(doc) as AnySchema, "active-split");
const valid = (name: string, value: unknown) =>
  ajv.validate(`active-split#/components/schemas/${name}`, value);

describe("S3 active split wire matches the reserved snapshot", () => {
  it("promotes all six immutable fields and four reasons without shrinking the reservation", () => {
    expect(doc.components.schemas.SplitProgramSnapshot).toEqual(
      reserved.components.schemas.SplitProgramSnapshot,
    );
    expect(doc.components.schemas.SplitProgramSnapshot.required).toEqual([
      "requested_preference",
      "effective_preference",
      "applicable",
      "reason",
      "upper_days",
      "lower_days",
    ]);
    expect(doc.components.schemas.SplitProgramSnapshot.properties.reason.enum).toEqual([
      null,
      "unsupported_days",
      "four_day_balanced_only",
      "legacy_input",
    ]);
    expect(doc.components.schemas.Program.required).toContain("split_preference_snapshot");
  });
  it("only profile clearing accepts null; generation remains a three-goal optional enum", () => {
    expect(valid("ProfileUpdate", { split_preference: null })).toBe(true);
    const input = {
      goal: "hypertrophy",
      days_per_week: 5,
      minutes_per_day: 60,
      experience_level: "intermediate",
    };
    expect(valid("GenerateProgramRequest", input)).toBe(true);
    expect(valid("GenerateProgramRequest", { ...input, split_preference: null })).toBe(false);
    for (const value of ["balanced", "upper_priority", "lower_priority"]) {
      expect(valid("GenerateProgramRequest", { ...input, split_preference: value })).toBe(true);
      expect(valid("ProfileUpdate", { split_preference: value })).toBe(true);
    }
    for (const value of ["bad", 1, {}, []])
      expect(valid("ProfileUpdate", { split_preference: value })).toBe(false);
    expect(doc.components.schemas.GenerateProgramRequest.properties.goal.enum).toEqual([
      "diet",
      "hypertrophy",
      "strength",
    ]);
  });
  it("requires a boolean read capability without allowing clients to choose a rules bundle", () => {
    expect(doc.components.schemas.Profile.required).toEqual(
      expect.arrayContaining(["split_preference", "split_preference_supported"]),
    );
    expect(doc.components.schemas.Profile.properties.split_preference_supported).toMatchObject({
      type: "boolean",
      readOnly: true,
    });
    expect(doc.components.schemas.ProfileUpdate.properties).not.toHaveProperty(
      "split_preference_supported",
    );
    expect(doc.components.schemas.GenerateProgramRequest.properties).not.toHaveProperty(
      "split_preference_supported",
    );
    expect(doc.components.schemas.GenerateProgramRequest.properties).not.toHaveProperty(
      "rules_version",
    );
  });
});
