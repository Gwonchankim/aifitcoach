import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { toJsonSchema } from "./support/openapi-response";

const doc = parse(
  readFileSync(path.resolve(__dirname, "../../../docs/specs/openapi.yaml"), "utf8"),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(toJsonSchema(doc) as AnySchema, "week-swap-wire");
const validate = (name: string, value: unknown) =>
  ajv.validate(`week-swap-wire#/components/schemas/${name}`, value);
const id = "00000000-0000-4000-8000-000000000001";
const candidateReasons = [
  "readonly",
  "not_scheduled",
  "performed_history",
  "wrong_week",
  "ambiguous_schedule",
  "recovery_unverifiable",
  "recovery_gap_violation",
];
const session = {
  id,
  scheduled_date: "2026-09-14",
  focus: "upper",
  status: "scheduled",
  origin: "planned",
  revision: "v1:opaque",
  planned_set_ids: [],
  exercises: [],
};

describe("promoted weekly swap wire", () => {
  it("keeps candidate and POST reasons closed and distinct", () => {
    for (const reason of candidateReasons) {
      expect(validate("WeekSwapCandidate", { session, eligible: false, reason })).toBe(true);
      expect(validate("WeekSwapCandidate", { session, eligible: true, reason })).toBe(false);
    }
    expect(validate("WeekSwapCandidate", { session, eligible: true, reason: null })).toBe(true);
    for (const reason of [null, "stale_revision", "set_cap_reached", "new_unknown"]) {
      expect(validate("WeekSwapCandidate", { session, eligible: false, reason })).toBe(false);
    }
    for (const reason of [...candidateReasons, "stale_revision", "idempotency_payload_mismatch"]) {
      const error = { error: { code: "CONFLICT", message: "Conflict", details: { reason } } };
      expect(validate("Error", error)).toBe(true);
      expect(validate("WeekSwapConflict", error)).toBe(true);
    }
    for (const reason of [null, "set_cap_reached", "new_unknown", undefined]) {
      expect(
        validate("WeekSwapConflict", {
          error: { code: "CONFLICT", message: "Conflict", details: { reason } },
        }),
      ).toBe(false);
    }
  });

  it("carries an unavailable today without inventing an identity", () => {
    const value = {
      program_id: id,
      week_start: "2026-09-14",
      today_session_id: null,
      today_revision: null,
      today_eligible: false,
      today_reason: "ambiguous_schedule",
      candidates: [],
    };
    expect(validate("WeekSwapCandidates", value)).toBe(true);
    expect(validate("WeekSwapCandidates", { ...value, today_eligible: true })).toBe(false);
    expect(validate("WeekSwapCandidates", { ...value, today_reason: null })).toBe(false);
    expect(validate("WeekSwapCandidates", { ...value, today_session_id: id })).toBe(false);
    expect(validate("WeekSwapCandidates", { ...value, today_reason: "readonly" })).toBe(false);
  });

  it("retains direct Error, mandatory CSRF and independent POST refinement", () => {
    const post = doc.paths["/programs/{id}/week-swaps"].post;
    expect(post.parameters).toContainEqual({ $ref: "#/components/parameters/CsrfHeader" });
    expect(post.responses["409"]["x-afc-response-refinement"]).toEqual({
      $ref: "#/components/schemas/WeekSwapConflict",
    });
    for (const status of ["400", "401", "403", "404", "409"]) {
      expect(post.responses[status].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Error",
      });
    }
  });
});
