import { describe, expect, it } from "vitest";
import {
  assessAppend,
  captureAppendSource,
  createAppendEntry,
  acknowledgeAppend,
  rejectAppend,
  overlayAppends,
  freezeDependentIntent,
  completionAppendDependencies,
  mapDependentExecution,
  type AppendContext,
  type AppendRow,
  type AppendEntry,
} from "../components/session/session-set-append";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { user_id: "owner", session_id: id(1) };
const t0 = "2026-08-14T10:00:00.000Z";
function row(n = 1, patch: Partial<AppendRow> = {}): AppendRow {
  return {
    id: id(10 + n),
    exercise_id: "bench",
    set_no: n,
    target_reps_low: 8,
    target_reps_high: 12,
    target_rir: 2,
    rest_sec: 90,
    target_time_low_sec: null,
    target_time_high_sec: null,
    recommended_weight: 60,
    recommended_reps: 9,
    reason_code: "BASELINE",
    confidence: 0.3,
    rules_version: "2026.08.1",
    load_kind: "external",
    recommendation_state: "ready" as const,
    recommended_action: null,
    assistance_provenance: null,
    assistance_safety_status: null,
    recommendation_gate: "ready",
    performed_set: null,
    source_revision: `revision-${n}`,
    append_eligibility: {
      version: 1,
      source_revision: `revision-${n}`,
      cohort_revision: "cohort",
      status: "allowed",
      reason: null,
    },
    ...patch,
  };
}
function context(rows = [row()], entries: readonly AppendEntry[] = []): AppendContext {
  return {
    ...scope,
    exercise_id: "bench",
    scheduled_date: "2026-08-14",
    today: "2026-08-14",
    status: "in_progress",
    snapshot: { ...scope, rows },
    entries,
    tombstones: [],
  };
}
function create(ctx = context(), n = 100) {
  const result = createAppendEntry(ctx, {
    client_id: id(n),
    correlation_id: id(n + 1),
    updated_at: t0,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.entry;
}

describe("click source capture across a newer transaction snapshot", () => {
  const identity = { client_id: id(200), correlation_id: id(201), updated_at: t0 };
  function capture(ctx = context()) {
    const result = captureAppendSource(ctx);
    if (!result.ok) throw new Error(result.reason);
    return result.capture;
  }
  it("keeps the clicked root revision when another authoritative append changes max and cohort token", () => {
    const clicked = capture();
    const rows = [row(), row(2, { recommended_weight: 75 })].map((value) => ({
      ...value,
      append_eligibility: { ...value.append_eligibility!, cohort_revision: "new-cohort" },
    }));
    const result = createAppendEntry(context(rows), identity, clicked);
    expect(result).toMatchObject({
      ok: true,
      entry: {
        intent: {
          transport: {
            payload: { source: { source_planned_set_id: row().id, source_revision: "revision-1" } },
          },
        },
        provisional: { set_no: 3, recommended_weight: 60, performed_set: null },
      },
    });
    expect(Object.isFrozen(clicked)).toBe(true);
    expect(JSON.stringify(clicked)).not.toContain("performed_set");
  });
  it.each(["revision", "deleted", "scope"])(
    "rejects a captured source whose %s changed",
    (kind) => {
      const clicked = capture();
      const ctx = context();
      if (kind === "revision")
        ctx.snapshot = {
          ...ctx.snapshot,
          rows: [
            row(1, {
              source_revision: "new",
              append_eligibility: { ...row().append_eligibility!, source_revision: "new" },
            }),
          ],
        };
      if (kind === "deleted") ctx.tombstones = [row().id];
      if (kind === "scope") ctx.user_id = "other-owner";
      expect(createAppendEntry(ctx, identity, clicked).ok).toBe(false);
    },
  );
  it("keeps a captured parent correlation after an exact ACK replaces its visible identity", () => {
    const a = create();
    const clicked = capture(context([row(), a.provisional], [a]));
    const canonical = row(2, { id: id(500), correlation_id: a.provisional.id });
    const acked = acknowledgeAppend(a, {
      ...scope,
      client_id: a.intent.transport.client_id,
      correlation_id: a.provisional.id,
      planned_set: canonical,
    });
    const result = createAppendEntry(context([row(), canonical], [acked]), identity, clicked);
    expect(result).toMatchObject({
      ok: true,
      entry: {
        intent: { transport: { payload: { source: { source_correlation_id: a.provisional.id } } } },
        provisional: { set_no: 3 },
      },
    });
  });
  it("validates an unrelated pending append against its own proven root instead of the older clicked root", () => {
    const clicked = capture();
    const later = create(context([row(), row(2, { recommended_weight: 75 })]));
    const result = createAppendEntry(
      context([row(), row(2, { recommended_weight: 75 }), later.provisional], [later]),
      identity,
      clicked,
    );
    expect(result).toMatchObject({
      ok: true,
      entry: { provisional: { set_no: 4, recommended_weight: 60 } },
    });
    const unsafe = { ...later, lineage: { ...later.lineage, root_source_revision: "mismatch" } };
    expect(
      createAppendEntry(
        context([row(), row(2, { recommended_weight: 75 }), later.provisional], [unsafe]),
        identity,
        clicked,
      ).ok,
    ).toBe(false);
  });
});

describe("append copy eligibility and fixed source", () => {
  it.each(["scheduled", "in_progress", "completed"] as const)(
    "allows today's %s and pins maximum set_no regardless of completion",
    (status) => {
      const last = row(2, {
        performed_set: {
          actual_weight: 999,
          actual_reps: 99,
          actual_rir: 6,
          actual_time_sec: null,
          completed: true,
          performed_at: t0,
        },
      });
      const ctx = { ...context([last, row()]), status };
      const entry = create(ctx);
      expect(entry.intent.transport.payload.source).toEqual({
        source_planned_set_id: last.id,
        source_revision: last.source_revision,
      });
      expect(entry.provisional.set_no).toBe(3);
      expect(entry.provisional.performed_set).toBeNull();
      expect(entry.provisional.recommended_weight).toBe(60);
      expect(entry.provisional.source_revision).toBeNull();
      expect(entry.provisional.append_eligibility).toBeNull();
    },
  );
  it.each(["2026-08-13", "2026-08-15"])("rejects non-today %s", (scheduled_date) => {
    expect(assessAppend({ ...context(), scheduled_date })).toMatchObject({
      ok: false,
      reason: "readonly",
    });
  });
  it.each([[row(2)], [row(), row(3)], [row(), row()], [row(0)]])(
    "rejects gaps/duplicates/zero without renumbering",
    (...rows) => {
      expect(assessAppend(context(rows))).toMatchObject({ ok: false, reason: "set_number_gap" });
    },
  );
  it("allows the tenth set, blocks the eleventh and requires a source", () => {
    expect(
      create(context(Array.from({ length: 9 }, (_, i) => row(i + 1)))).provisional.set_no,
    ).toBe(10);
    expect(assessAppend(context(Array.from({ length: 10 }, (_, i) => row(i + 1))))).toMatchObject({
      ok: false,
      reason: "set_cap_reached",
    });
    expect(assessAppend(context([]))).toMatchObject({ ok: false, reason: "source_removed" });
  });
  it.each([
    { append_eligibility: null },
    { source_revision: null },
    { append_eligibility: { ...row().append_eligibility!, version: 2 } },
    { append_eligibility: { ...row().append_eligibility!, source_revision: "stale" } },
    { append_eligibility: { ...row().append_eligibility!, cohort_revision: "" } },
    {
      append_eligibility: {
        ...row().append_eligibility!,
        status: "allowed",
        reason: "unsafe_assistance_snapshot",
      },
    },
  ])("fails closed on missing or contradictory metadata %j", (patch) => {
    expect(assessAppend(context([row(1, patch as Partial<AppendRow>)]))).toMatchObject({
      ok: false,
    });
  });
  it("rejects blocked/stale cohort metadata and a cross-session snapshot", () => {
    expect(
      assessAppend(
        context([
          row(1, {
            append_eligibility: {
              ...row().append_eligibility!,
              status: "blocked",
              reason: "unsafe_assistance_snapshot",
            },
          }),
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "unsafe_assistance_snapshot" });
    expect(
      assessAppend(
        context([
          row(),
          row(2, {
            append_eligibility: { ...row(2).append_eligibility!, cohort_revision: "other" },
          }),
        ]),
      ),
    ).toMatchObject({ ok: false });
    const ctx = context();
    expect(
      assessAppend({ ...ctx, snapshot: { ...ctx.snapshot, session_id: id(2) } }),
    ).toMatchObject({ ok: false, reason: "scope_mismatch" });
  });
  it.each(["e_assisted_pullup", "e_assisted_dips"])(
    "uses allowed native %s snapshots through all display gates without synthesizing numbers",
    (exercise_id) => {
      for (const recommendation_gate of ["no_history", "early", "ready"] as const) {
        const source = row(1, {
          exercise_id,
          load_kind: "assistance",
          rules_version: "2026.08.2",
          assistance_provenance: "native",
          assistance_safety_status: "safe",
          recommendation_gate,
          recommended_weight: 20,
          recommended_reps: 9,
          reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
          confidence: recommendation_gate === "ready" ? 0.8 : null,
          recommendation_state: "ready",
        });
        const entry = create({ ...context([source]), exercise_id });
        for (const field of [
          "recommended_weight",
          "recommended_reps",
          "reason_code",
          "confidence",
          "recommendation_state",
          "recommended_action",
          "assistance_safety_status",
          "recommendation_gate",
        ] as const)
          expect(entry.provisional[field]).toEqual(source[field]);
      }
    },
  );
  it("uses only the selected source's copy eligibility when an earlier completed snapshot is safe", () => {
    const assistance = {
      load_kind: "assistance" as const,
      rules_version: "2026.08.2",
      assistance_provenance: "native" as const,
      assistance_safety_status: "safe" as const,
      recommendation_state: "ready" as const,
    };
    const earlier = row(1, {
      ...assistance,
      recommended_weight: 0,
      reason_code: "BASELINE",
      performed_set: {
        actual_weight: 0,
        actual_reps: 9,
        actual_rir: 2,
        actual_time_sec: null,
        completed: true,
        performed_at: t0,
      },
      append_eligibility: {
        ...row().append_eligibility!,
        status: "blocked",
        reason: "unsafe_assistance_snapshot",
      },
    });
    const selected = row(2, {
      ...assistance,
      recommended_weight: 20,
      reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
    });
    const entry = create(context([earlier, selected]));
    expect(entry.intent.transport.payload.source).toEqual({
      source_planned_set_id: selected.id,
      source_revision: selected.source_revision,
    });
    expect(entry.provisional.recommended_weight).toBe(20);
    expect(entry.provisional.performed_set).toBeNull();
    for (const patch of [
      { assistance_safety_status: "unsafe" },
      { rules_version: "unknown" },
      { assistance_provenance: "legacy_performed" },
      { load_kind: "external", assistance_provenance: null },
    ] as Partial<AppendRow>[])
      expect(assessAppend(context([{ ...earlier, ...patch }, selected])).ok).toBe(false);
    expect(
      assessAppend(
        context([
          earlier,
          {
            ...selected,
            append_eligibility: {
              ...selected.append_eligibility!,
              status: "blocked",
              reason: "unsafe_assistance_snapshot",
            },
          },
        ]),
      ).ok,
    ).toBe(false);
  });
  it.each(["legacy_performed", "unknown", null])(
    "cannot treat performed-safe provenance %s as copy permission",
    (provenance) => {
      const source = row(1, {
        load_kind: "assistance",
        assistance_safety_status: "safe",
        assistance_provenance: provenance as AppendRow["assistance_provenance"],
      });
      expect(assessAppend(context([source]))).toMatchObject({
        ok: false,
        reason: "unsafe_assistance_snapshot",
      });
    },
  );
  it("copies a time public snapshot but excludes unknown/raw/actual fields", () => {
    const source = row(1, {
      load_kind: "not_applicable",
      target_reps_low: null,
      target_reps_high: null,
      target_rir: null,
      recommended_weight: null,
      recommended_reps: null,
      target_time_low_sec: 23,
      target_time_high_sec: 41,
    });
    Object.assign(source, {
      actual_weight: 999,
      pain_score: 7,
      assistance_step_kg: 5,
      order_index: 4,
      hidden_raw: 88,
    });
    const copied = create(context([source])).provisional;
    expect(copied.target_time_low_sec).toBe(23);
    expect(copied.target_time_high_sec).toBe(41);
    for (const field of [
      "actual_weight",
      "pain_score",
      "assistance_step_kg",
      "order_index",
      "hidden_raw",
    ])
      expect(copied).not.toHaveProperty(field);
    expect(
      create({
        ...context([row(1, { exercise_id: "e_assisted_pullup" })]),
        exercise_id: "e_assisted_pullup",
      }).provisional.load_kind,
    ).toBe("external");
  });
});

describe("immutable append lineage and dependent envelopes", () => {
  it("rejects non-completion session intents even without a performed dependency list", () => {
    for (const payload of [{}, { status: "scheduled" }, { status: "in_progress" }])
      expect(() =>
        freezeDependentIntent(
          scope,
          {
            client_id: id(400),
            entity: "session",
            entity_id: scope.session_id,
            op: "upsert",
            updated_at: t0,
            payload,
          },
          { session_id: scope.session_id, client_ids: [id(100)] },
        ),
      ).toThrow();
  });
  it("supports an exact pending parent chain without forging source tokens; ACK never rewrites child source", () => {
    const parent = create();
    const child = create(context([row(), parent.provisional], [parent]), 102);
    const third = create(
      context([row(), parent.provisional, child.provisional], [parent, child]),
      104,
    );
    expect(child.intent.transport.payload.source).toEqual({
      source_correlation_id: parent.provisional.id,
    });
    expect(third.intent.transport.payload.source).toEqual({
      source_correlation_id: child.provisional.id,
    });
    const original = JSON.stringify(child.intent);
    const mapped = acknowledgeAppend(parent, {
      ...scope,
      client_id: parent.intent.transport.client_id,
      correlation_id: parent.provisional.id,
      planned_set: row(2, { id: id(500) }),
    });
    expect(mapped.execution.canonical_id).toBe(id(500));
    expect(JSON.stringify(child.intent)).toBe(original);
    expect(mapped.intent).toBe(parent.intent);
    expect(() =>
      Object.assign(child.intent.transport.payload, { source: { source_correlation_id: id(999) } }),
    ).toThrow();
  });
  it("rejects modified, missing, blocked or cross-owner lineage and identity reuse", () => {
    const parent = create();
    expect(
      assessAppend(context([row(), { ...parent.provisional, recommended_weight: 88 }], [parent])),
    ).toMatchObject({ ok: false });
    expect(assessAppend(context([row(), parent.provisional]))).toMatchObject({ ok: false });
    expect(
      assessAppend(
        context([row(), parent.provisional], [rejectAppend(parent, "source_changed", false)]),
      ),
    ).toMatchObject({ ok: false });
    expect(
      assessAppend({ ...context([row(), parent.provisional], [parent]), user_id: "other" }),
    ).toMatchObject({ ok: false });
    expect(
      createAppendEntry(context([row(), parent.provisional], [parent]), {
        client_id: id(200),
        correlation_id: parent.provisional.id,
        updated_at: t0,
      }),
    ).toMatchObject({ ok: false, reason: "correlation_mismatch" });
    expect(() =>
      acknowledgeAppend(parent, {
        ...scope,
        session_id: id(9),
        client_id: id(100),
        correlation_id: id(101),
        planned_set: row(2),
      }),
    ).toThrow();
  });
  it("fixes the completion barrier at committed append-related actual UUIDs including in-flight deletes", () => {
    const entry = create();
    const dependency = { session_id: scope.session_id, client_ids: [id(100)] };
    const actual = freezeDependentIntent(
      scope,
      {
        client_id: id(300),
        entity: "performed_set",
        entity_id: entry.provisional.id,
        op: "delete",
        updated_at: t0,
        payload: {},
      },
      dependency,
    );
    const deps = completionAppendDependencies(scope, [entry], [actual]);
    expect(deps).toEqual({
      session_id: scope.session_id,
      client_ids: [id(100)],
      performed_client_ids: [id(300)],
    });
    const completion = freezeDependentIntent(
      scope,
      {
        client_id: id(400),
        entity: "session",
        entity_id: scope.session_id,
        op: "upsert",
        updated_at: t0,
        payload: { status: "completed" },
      },
      deps!,
    );
    const before = JSON.stringify(completion);
    expect(() =>
      freezeDependentIntent(
        scope,
        { ...completion.transport, payload: { status: "in_progress" } },
        deps!,
      ),
    ).toThrow();
    const later = freezeDependentIntent(
      scope,
      { ...actual.transport, client_id: id(301) },
      dependency,
    );
    expect(
      completionAppendDependencies(scope, [entry], [actual, later])?.performed_client_ids,
    ).toEqual([id(300), id(301)]);
    expect(JSON.stringify(completion)).toBe(before);
    expect(completionAppendDependencies(scope, [entry], [])?.performed_client_ids).toEqual([]);
    expect(() =>
      freezeDependentIntent(scope, actual.transport, {
        ...dependency,
        performed_client_ids: [id(300)],
      }),
    ).toThrow();
    expect(() =>
      freezeDependentIntent(scope, actual.transport, { ...dependency, session_id: id(9) }),
    ).toThrow();
    expect(actual.transport.entity_id).toBe(entry.provisional.id);
    expect(actual.transport.updated_at).toBe(t0);
  });
  it("captures a committed canonical edit after parent ACK, but excludes unrelated or cross-scope writes", () => {
    const entry = create();
    const ack = acknowledgeAppend(entry, {
      ...scope,
      client_id: id(100),
      correlation_id: id(101),
      planned_set: row(2, { id: id(500) }),
    });
    const actual = freezeDependentIntent(
      scope,
      {
        client_id: id(300),
        entity: "performed_set",
        entity_id: id(101),
        op: "upsert",
        updated_at: t0,
        payload: { actual_weight: 47.5, actual_reps: 9, completed: true },
      },
      { session_id: scope.session_id, client_ids: [id(100)] },
    );
    const original = JSON.stringify(actual);
    const mapped = mapDependentExecution(
      { intent: actual, canonical_entity_id: id(101) },
      { ...scope, correlation_id: id(101), planned_set_id: id(500) },
    );
    expect(mapped.intent).toBe(actual);
    expect(mapped.canonical_entity_id).toBe(id(500));
    expect(JSON.stringify(actual)).toBe(original);
    const next = {
      ...scope,
      transport: {
        ...actual.transport,
        client_id: id(301),
        entity_id: id(500),
        append_dependencies: undefined,
      },
    };
    expect(
      completionAppendDependencies(
        scope,
        [ack],
        [
          next,
          { ...next, user_id: "other" },
          { ...next, session_id: id(2) },
          { ...next, transport: { ...next.transport, client_id: id(302), entity_id: id(900) } },
        ],
      )?.performed_client_ids,
    ).toEqual([id(301)]);
  });
});

describe("pending overlay and explicit tombstones", () => {
  it("propagates a GET-observed canonical parent tombstone before ACK across reversed children", () => {
    const a = create();
    const b = create(context([row(), a.provisional], [a]), 102);
    const c = create(context([row(), a.provisional, b.provisional], [a, b]), 104);
    const server = row(2, { id: id(500), correlation_id: a.provisional.id });
    const result = overlayAppends(scope, [row(), server], [c, b, a], [server.id]);
    expect(result.rows).toEqual([row()]);
    expect(result.blocked).toHaveLength(3);
    expect(result.blocked.find(({ entry }) => entry === a)?.reason).toBe("append_target_removed");
    expect(a.execution.phase).toBe("pending");
    expect(a.execution.canonical_id).toBeNull();
  });
  it("deduplicates a GET-before-ACK by exact authoritative correlation without acknowledging the intent", () => {
    const entry = create();
    const server = { ...row(2, { id: id(500) }), correlation_id: entry.provisional.id };
    const result = overlayAppends(scope, [row(), server], [entry], []);
    expect(result.rows).toEqual([row(), server]);
    expect(result.observedIdentities).toEqual([
      { correlation_id: entry.provisional.id, planned_set_id: server.id },
    ]);
    expect(entry.execution.phase).toBe("pending");
    expect(entry.execution.canonical_id).toBeNull();
    expect(entry.intent.transport.payload.correlation_id).toBe(entry.provisional.id);
    // Matching numbers or exercise labels without correlation do not establish identity.
    expect(
      overlayAppends(scope, [row(), row(2, { id: id(500) })], [entry], []).observedIdentities,
    ).toEqual([]);
    expect(() =>
      overlayAppends(scope, [row(), { ...server, exercise_id: "other" }], [entry], []),
    ).toThrow();
  });
  it("orders a reversed pending lineage by its fixed set numbers without changing identities", () => {
    const a = create();
    const b = create(context([row(), a.provisional], [a]), 102);
    const c = create(context([row(), a.provisional, b.provisional], [a, b]), 104);
    expect(
      overlayAppends(scope, [row()], [c, b, a], []).rows.map((item) => [item.id, item.set_no]),
    ).toEqual([
      [row().id, 1],
      [a.provisional.id, 2],
      [b.provisional.id, 3],
      [c.provisional.id, 4],
    ]);
  });
  it("a stale deferred response cannot downgrade an applied identity or revive terminal blocked intent", () => {
    const entry = create();
    const ack = acknowledgeAppend(entry, {
      ...scope,
      client_id: id(100),
      correlation_id: id(101),
      planned_set: row(2, { id: id(500) }),
    });
    expect(rejectAppend(ack, "unresolved_parent", true)).toBe(ack);
    expect(rejectAppend(ack, "source_removed", false)).toBe(ack);
    const removed = rejectAppend(ack, "append_target_removed", false);
    expect(removed.execution.phase).toBe("blocked");
    expect(rejectAppend(removed, "unresolved_parent", true)).toBe(removed);
    expect(() =>
      acknowledgeAppend(removed, {
        ...scope,
        client_id: id(100),
        correlation_id: id(101),
        planned_set: row(2, { id: id(500) }),
      }),
    ).toThrow();
  });
  it("preserves pending rows over stale GET and de-duplicates both ACK/GET arrival orders", () => {
    const entry = create();
    expect(overlayAppends(scope, [row()], [entry], []).rows.map((r) => r.id)).toEqual([
      row().id,
      entry.provisional.id,
    ]);
    const canonical = row(2, { id: id(500) });
    const ack = acknowledgeAppend(entry, {
      ...scope,
      client_id: id(100),
      correlation_id: id(101),
      planned_set: canonical,
    });
    for (const rows of [[row()], [row(), entry.provisional], [row(), canonical]]) {
      const merged = overlayAppends(scope, rows, [ack], []);
      expect(merged.rows.map((r) => r.id)).toEqual([row().id, canonical.id]);
      expect(merged.rows[1]).toEqual(canonical);
    }
    const repeated = acknowledgeAppend(ack, {
      ...scope,
      client_id: id(100),
      correlation_id: id(101),
      planned_set: canonical,
    });
    expect(repeated).toEqual(ack);
  });
  it("does not resurrect a removed source or target through stale GET or exercise re-add", () => {
    const entry = create();
    const before = JSON.stringify(entry.intent);
    const removed = overlayAppends(scope, [row(), row(1, { id: id(700) })], [entry], [row().id]);
    expect(removed.rows.map((r) => r.id)).toEqual([id(700)]);
    expect(removed.blocked[0].reason).toBe("source_removed");
    expect(JSON.stringify(removed.blocked[0].entry.intent)).toBe(before);
    const canonical = row(2, { id: id(500) });
    const ack = acknowledgeAppend(entry, {
      ...scope,
      client_id: id(100),
      correlation_id: id(101),
      planned_set: canonical,
    });
    expect(
      overlayAppends(scope, [row(), canonical], [ack], [canonical.id]).rows.map((r) => r.id),
    ).toEqual([row().id]);
    expect(overlayAppends(scope, [canonical], [ack], [row().id]).rows).toEqual([canonical]);
  });
  it("keeps deferred/terminal reasons without acknowledging or resending automatically", () => {
    const entry = create();
    const deferred = rejectAppend(entry, "unresolved_parent", true);
    expect(deferred.execution.phase).toBe("pending");
    expect(deferred.intent).toBe(entry.intent);
    const rejected = rejectAppend(deferred, "unsafe_assistance_snapshot", false);
    const result = overlayAppends(scope, [row()], [rejected], []);
    expect(result.rows).toEqual([row()]);
    expect(result.blocked[0].entry.intent).toBe(entry.intent);
    expect(overlayAppends({ ...scope, session_id: id(2) }, [], [entry], []).rows).toEqual([]);
  });
  it("propagates a terminal parent across reversed multi-child input without resurrecting descendants", () => {
    const a = create();
    const b = create(context([row(), a.provisional], [a]), 102);
    const c = create(context([row(), a.provisional, b.provisional], [a, b]), 104);
    const result = overlayAppends(
      scope,
      [row(), a.provisional, b.provisional, c.provisional],
      [c, b, rejectAppend(a, "unsafe_assistance_snapshot", false)],
      [],
    );
    expect(result.rows).toEqual([row()]);
    expect(result.blocked).toHaveLength(3);
  });
});
