import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { expectMatchesContract, toJsonSchema } from "./support/openapi-response";

const document = parse(
  readFileSync(path.resolve(__dirname, "../../../docs/specs/openapi.yaml"), "utf8"),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(toJsonSchema(document) as AnySchema, "active");
const valid = (name: string, value: unknown) =>
  ajv.validate(`active#/components/schemas/${name}`, value);
const id = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const request = {
  client_id: id,
  exercise_id: "e_bench_press",
  correlation_id: child,
  source: { source_planned_set_id: id, source_revision: "opaque-raw-revision" },
};
const mutation = {
  client_id: id,
  entity: "session_set",
  entity_id: id,
  op: "upsert",
  updated_at: "2026-08-14T10:00:00.000Z",
  payload: {
    exercise_id: request.exercise_id,
    correlation_id: child,
    source: request.source,
  },
};

describe("Sprint03 active append wire (no server/DB execution)", () => {
  it("promotes only append, with CSRF and mandatory narrow 409 refinement", () => {
    const post = document.paths["/sessions/{id}/sets"]?.post;
    expect(post).toBeDefined();
    expect(post.parameters).toContainEqual({ $ref: "#/components/parameters/CsrfHeader" });
    expect(post.parameters.some((p: { name?: string }) => p.name === "Idempotency-Key")).toBe(
      false,
    );
    expect(post.responses["409"]["x-afc-response-refinement"]).toEqual({
      $ref: "#/components/schemas/SessionAppendConflict",
    });
    for (const status of [400, 401, 403, 404, 409]) {
      expect(post.responses[status].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Error",
      });
    }
    for (const route of ["/programs/{id}/weeks/current", "/programs/{id}/week-swaps"]) {
      expect(document.paths[route]).toBeUndefined();
    }
  });

  it("accepts exactly one immutable source representation", () => {
    expect(valid("AppendSetRequest", request)).toBe(true);
    expect(
      valid("AppendSetRequest", { ...request, source: { source_correlation_id: child } }),
    ).toBe(true);
    for (const source of [
      {},
      null,
      { source_planned_set_id: id },
      { ...request.source, source_correlation_id: child },
    ]) {
      expect(valid("AppendSetRequest", { ...request, source })).toBe(false);
    }
    for (const extra of [{ set_no: 9 }, { actual_weight: 40 }, { raw_prescription: {} }]) {
      expect(valid("AppendSetRequest", { ...request, ...extra })).toBe(false);
    }
  });

  it("allows additive append upserts but rejects delete, prescribed payload, or extra dependencies", () => {
    expect(valid("Mutation", mutation)).toBe(true);
    expect(valid("Mutation", { ...mutation, op: "delete" })).toBe(false);
    expect(valid("Mutation", { ...mutation, payload: { ...mutation.payload, set_no: 9 } })).toBe(
      false,
    );
    expect(
      valid("Mutation", {
        ...mutation,
        append_dependencies: { session_id: id, client_ids: [child] },
      }),
    ).toBe(false);
  });

  it("carries distinct append parents and the completion-only committed performed barrier", () => {
    const actual = {
      ...mutation,
      entity: "performed_set",
      payload: { completed: true },
      append_dependencies: { session_id: id, client_ids: [child] },
    };
    const completion = {
      ...actual,
      entity: "session",
      payload: { status: "completed" },
      append_dependencies: { ...actual.append_dependencies, performed_client_ids: [id] },
    };
    expect(valid("Mutation", actual)).toBe(true);
    expect(valid("Mutation", completion)).toBe(true);
    expect(
      valid("Mutation", { ...actual, append_dependencies: completion.append_dependencies }),
    ).toBe(false);
    expect(valid("Mutation", { ...completion, op: "delete" })).toBe(false);
    expect(
      valid("Mutation", { ...actual, entity: "session_routine", payload: { exercise_ids: [] } }),
    ).toBe(false);
    expect(
      valid("Mutation", {
        ...actual,
        append_dependencies: { session_id: id, client_ids: [child, child] },
      }),
    ).toBe(false);
  });

  it("keeps eligibility bound to source/cohort with no raw payload and correlated reason", () => {
    const eligibility = {
      version: 1,
      source_revision: "raw",
      cohort_revision: "cohort",
      status: "allowed",
      reason: null,
    };
    expect(valid("AppendEligibility", eligibility)).toBe(true);
    expect(
      valid("AppendEligibility", {
        ...eligibility,
        status: "blocked",
        reason: "unsafe_assistance_snapshot",
      }),
    ).toBe(true);
    for (const extra of [
      { version: 2 },
      { source_revision: "" },
      { reason: "unsafe_assistance_snapshot" },
      { raw_weight: 20 },
    ]) {
      expect(valid("AppendEligibility", { ...eligibility, ...extra })).toBe(false);
    }
    expect(document.components.schemas.PlannedSet.required).toEqual(
      expect.arrayContaining(["source_revision", "append_eligibility", "correlation_id"]),
    );
    expect(document.components.schemas.PlannedSet.properties.correlation_id).toMatchObject({
      type: "string",
      format: "uuid",
      nullable: true,
    });
  });

  it("requires both common Error and the declared append refinement during response checks", () => {
    const body = {
      error: { code: "CONFLICT", message: "Source changed", details: { reason: "source_changed" } },
    };
    expect(() => expectMatchesContract("post", "/sessions/{id}/sets", 409, body)).not.toThrow();
    for (const details of [
      {},
      { reason: "stale_revision" },
      { reason: "source_changed", raw_weight: 20 },
    ]) {
      expect(() =>
        expectMatchesContract("post", "/sessions/{id}/sets", 409, {
          error: { ...body.error, details },
        }),
      ).toThrow();
    }
    // The existing common Error still accepts its original arbitrary details.
    expect(
      valid("Error", {
        error: { code: "CONFLICT", message: "Existing", details: { reason: "stale_revision" } },
      }),
    ).toBe(true);
  });

  it("carries only exact removed identities while preserving existing free-form changes and null deletes", () => {
    const tombstone = { planned_set_id: child, correlation_id: null, exercise_id: "e_bench_press" };
    const response = (data: unknown, op = "upsert", entity = "session_routine") => ({
      applied: [],
      conflicts: [],
      planned_set_mappings: [],
      next_cursor: "opaque",
      changes: [{ entity, entity_id: id, op, data, server_seq: "42" }],
    });
    expect(valid("SyncResponse", response({ exercise_ids: [], tombstones: [tombstone] }))).toBe(
      true,
    );
    expect(valid("SyncResponse", response({ tombstones: [tombstone] }, "delete"))).toBe(true);
    expect(
      valid("SyncResponse", response({ tombstones: [{ ...tombstone, correlation_id: id }] })),
    ).toBe(true);
    expect(valid("SyncResponse", response(null, "delete"))).toBe(true);
    expect(
      valid(
        "SyncResponse",
        response({ actual_weight: 47.5, completed: true }, "upsert", "performed_set"),
      ),
    ).toBe(true);
    for (const bad of [
      { planned_set_id: child, exercise_id: "e_bench_press" },
      { ...tombstone, planned_set_id: "not-an-id" },
      { ...tombstone, correlation_id: "not-an-id" },
      { ...tombstone, actual_weight: 47.5 },
    ]) {
      expect(valid("SyncResponse", response({ tombstones: [bad] }))).toBe(false);
    }
  });
});
