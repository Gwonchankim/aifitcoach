import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { AppendSetDto } from "../src/sessions/dto/append-set.dto";
import { SyncRequestDto } from "../src/sync/dto/sync-request.dto";

// Exercise the same transformation/whitelisting as AppModule, without booting it or a DB.
const pipe = new ValidationPipe({ whitelist: true, transform: true });
const id = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";
const request = {
  client_id: id,
  exercise_id: "e_bench_press",
  correlation_id: child,
  source: { source_planned_set_id: id, source_revision: "opaque-revision" },
};
const append = {
  client_id: id,
  entity: "session_set",
  entity_id: id,
  op: "upsert",
  updated_at: "2026-08-14T10:00:00.000Z",
  payload: { exercise_id: request.exercise_id, correlation_id: child, source: request.source },
};
const direct = (value: unknown) => pipe.transform(value, { type: "body", metatype: AppendSetDto });
const sync = (mutation: unknown) =>
  pipe.transform({ mutations: [mutation] }, { type: "body", metatype: SyncRequestDto });

describe("append DTO exact intent boundary", () => {
  it("accepts either source without rewriting input", async () => {
    const original = structuredClone(request);
    expect(await direct(request)).toEqual(request);
    expect(await direct({ ...request, source: { source_correlation_id: child } })).toEqual({
      ...request,
      source: { source_correlation_id: child },
    });
    expect(request).toEqual(original);
    expect((await sync(append)).mutations[0]).toEqual(append);
  });

  it.each([
    {},
    null,
    [],
    { source_planned_set_id: id },
    { source_planned_set_id: "invalid", source_revision: "revision" },
    { source_planned_set_id: id, source_revision: "" },
    { ...request.source, source_correlation_id: child },
    { ...request.source, actual_weight: 20 },
  ])("rejects malformed or ambiguous source %j through direct and sync", async (source) => {
    await expect(direct({ ...request, source })).rejects.toMatchObject({ status: 400 });
    await expect(sync({ ...append, payload: { ...append.payload, source } })).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it("rejects client prescriptions instead of silently stripping them", async () => {
    for (const extra of [{ set_no: 9 }, { actual_weight: 20 }, { recommended_weight: 30 }]) {
      await expect(direct({ ...request, ...extra })).rejects.toMatchObject({ status: 400 });
      await expect(
        sync({ ...append, payload: { ...append.payload, ...extra } }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(sync({ ...append, ...extra })).rejects.toMatchObject({ status: 400 });
    }
    await expect(sync({ ...append, op: "delete" })).rejects.toMatchObject({ status: 400 });
  });

  it("preserves original dependency lists and allows performed barriers only on completion", async () => {
    const dependencies = { session_id: id, client_ids: [child] };
    const actual = {
      ...append,
      entity: "performed_set",
      payload: { completed: false },
      append_dependencies: dependencies,
    };
    const completion = {
      ...actual,
      entity: "session",
      payload: { status: "completed" },
      append_dependencies: { ...dependencies, performed_client_ids: [id] },
    };
    expect((await sync(actual)).mutations[0]).toEqual(actual);
    expect((await sync({ ...actual, op: "delete", payload: {} })).mutations[0].op).toBe("delete");
    expect((await sync(completion)).mutations[0]).toEqual(completion);
    for (const mutation of [
      { ...actual, append_dependencies: completion.append_dependencies },
      { ...completion, op: "delete" },
      { ...completion, payload: {} },
      { ...actual, entity: "session_routine", payload: { exercise_ids: [] } },
      { ...append, append_dependencies: dependencies },
    ])
      await expect(sync(mutation)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    null,
    [],
    {},
    { session_id: "invalid", client_ids: [child] },
    { session_id: id, client_ids: [child, child] },
    { session_id: id, client_ids: ["invalid"] },
    { session_id: id, client_ids: [child], performed_client_ids: [id, id] },
    { session_id: id, client_ids: [child], hidden_actual: 20 },
  ])("rejects malformed dependency envelope %j", async (append_dependencies) => {
    await expect(
      sync({ ...append, entity: "session", payload: { status: "completed" }, append_dependencies }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps dependency-free legacy transformation unchanged", async () => {
    const actual = {
      ...append,
      entity: "performed_set",
      payload: { actual_rir: null, completed: true },
    };
    expect((await sync({ ...actual, legacy_unknown: 1 })).mutations[0]).toEqual(actual);
    expect((await sync({ ...actual, op: "delete", payload: {} })).mutations[0].payload).toEqual({});
  });
});
