import { isAllowedAssistanceVersion, resolveRulesBundle } from "shared";
import type { PlannedSet, Session } from "../../lib/api";

export type AppendScope = { user_id: string; session_id: string };
export type AppendEligibility = {
  version: 1;
  source_revision: string;
  cohort_revision: string;
  status: "allowed" | "blocked";
  reason: null | "unsafe_assistance_snapshot";
};
/** Old mirrors and local provisional rows may lack authoritative metadata. No invented revisions. */
export type AppendRow = Omit<
  PlannedSet,
  "source_revision" | "append_eligibility" | "correlation_id"
> & {
  source_revision?: string | null;
  append_eligibility?: AppendEligibility | null;
  correlation_id?: string | null;
};
export type AppendSource =
  | { source_planned_set_id: string; source_revision: string; source_correlation_id?: never }
  | { source_correlation_id: string; source_planned_set_id?: never; source_revision?: never };
type AppendTransport = {
  client_id: string;
  entity: "session_set";
  entity_id: string;
  op: "upsert";
  updated_at: string;
  payload: { exercise_id: string; correlation_id: string; source: AppendSource };
};
export type AppendIntent = Readonly<
  AppendScope & {
    version: 1;
    transport: Readonly<
      Omit<AppendTransport, "payload"> & {
        payload: Readonly<
          Omit<AppendTransport["payload"], "source"> & { source: Readonly<AppendSource> }
        >;
      }
    >;
  }
>;
type Lineage = {
  root_source_id: string;
  root_source_revision: string;
  cohort_revision: string;
  public_snapshot: string;
  parent_client_ids: string[];
};
export type CapturedAppendSource = Readonly<
  AppendScope & {
    exercise_id: string;
    source_id: string;
    source: Readonly<AppendSource>;
    lineage: Readonly<Lineage>;
  }
>;
export type AppendEntry = {
  intent: AppendIntent;
  /** Store in the local view envelope, never in the append transport or a performed draft. */
  provisional: AppendRow;
  lineage: Lineage;
  execution: {
    phase: "pending" | "applied" | "blocked";
    canonical_id: string | null;
    row: AppendRow | null;
    reason: string | null;
  };
};
export type AppendContext = AppendScope & {
  exercise_id: string;
  today: string;
  scheduled_date: string;
  status: Session["status"];
  snapshot: AppendScope & { rows: readonly AppendRow[] };
  entries: readonly AppendEntry[];
  /** Confirmed identities in this context's scope, supplied by a successful delete/terminal observation. */
  tombstones: readonly string[];
};
type Denied = { ok: false; reason: string };
const denied = (reason: string): Denied => ({ ok: false, reason });
const sameScope = (a: AppendScope, b: AppendScope) =>
  a.user_id === b.user_id && a.session_id === b.session_id;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const uuid = (value: string) =>
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const copyFrozen = <T>(value: T): T => freeze(structuredClone(value));
const publicFields = [
  "target_reps_low",
  "target_reps_high",
  "target_time_low_sec",
  "target_time_high_sec",
  "target_rir",
  "rest_sec",
  "recommended_weight",
  "recommended_reps",
  "reason_code",
  "confidence",
  "rules_version",
  "load_kind",
  "recommendation_state",
  "assistance_provenance",
  "recommended_action",
  "assistance_safety_status",
  "recommendation_gate",
] as const;
function publicSnapshot(row: AppendRow) {
  return Object.fromEntries(publicFields.map((field) => [field, row[field]])) as Pick<
    AppendRow,
    (typeof publicFields)[number]
  >;
}
const snapshotKey = (row: AppendRow) => JSON.stringify(publicSnapshot(row));

/** Reader metadata is the authority; visible structural contradictions still fail closed. */
function metadata(row: AppendRow): AppendEligibility | null {
  const value = row.append_eligibility;
  if (
    !value ||
    value.version !== 1 ||
    !nonempty(row.source_revision) ||
    value.source_revision !== row.source_revision ||
    !nonempty(value.cohort_revision) ||
    !(
      (value.status === "allowed" && value.reason === null) ||
      (value.status === "blocked" && value.reason === "unsafe_assistance_snapshot")
    )
  )
    return null;
  return value;
}
function visibleCopySafe(row: AppendRow): boolean {
  try {
    resolveRulesBundle(row.rules_version);
    if (
      publicFields.some((field) => typeof row[field] === "number" && !Number.isFinite(row[field]))
    )
      return false;
    if (row.load_kind === "assistance") {
      const provenance = row.assistance_provenance;
      return (
        row.assistance_safety_status === "safe" &&
        (provenance === "native" || provenance === "remediated") &&
        isAllowedAssistanceVersion(provenance, row.rules_version)
      );
    }
    return (
      ["external", "bodyweight", "not_applicable"].includes(row.load_kind) &&
      row.assistance_provenance === null
    );
  } catch {
    return false;
  }
}

export function assessAppend(
  ctx: AppendContext,
  captured?: CapturedAppendSource,
):
  | Denied
  | {
      ok: true;
      source: AppendRow;
      sourceReference: AppendSource;
      lineage: Lineage;
      nextSetNo: number;
    } {
  if (!sameScope(ctx, ctx.snapshot) || !nonempty(ctx.user_id) || !uuid(ctx.session_id))
    return denied("scope_mismatch");
  if (captured && (!sameScope(ctx, captured) || captured.exercise_id !== ctx.exercise_id))
    return denied("scope_mismatch");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(ctx.today) ||
    ctx.scheduled_date !== ctx.today ||
    !["scheduled", "in_progress", "completed"].includes(ctx.status)
  )
    return denied("readonly");
  const rows = ctx.snapshot.rows
    .filter((row) => row.exercise_id === ctx.exercise_id)
    .sort((a, b) => a.set_no - b.set_no);
  if (!rows.length) return denied("source_removed");
  if (
    rows.some((row, index) => row.set_no !== index + 1) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    return denied("set_number_gap");
  if (rows.length >= 10) return denied("set_cap_reached");
  const entries = ctx.entries.filter((entry) => sameScope(ctx, entry.intent));
  const capturedParent = captured?.source.source_correlation_id
    ? entries.find((entry) => entry.provisional.id === captured.source.source_correlation_id)
    : undefined;
  if (
    captured?.source.source_correlation_id &&
    (!capturedParent ||
      capturedParent.execution.phase === "blocked" ||
      capturedParent.intent.transport.payload.exercise_id !== ctx.exercise_id ||
      capturedParent.lineage.root_source_id !== captured.lineage.root_source_id ||
      capturedParent.lineage.root_source_revision !== captured.lineage.root_source_revision ||
      capturedParent.lineage.public_snapshot !== captured.lineage.public_snapshot)
  )
    return denied("source_changed");
  const source = captured
    ? rows.find((row) => row.id === (capturedParent?.execution.canonical_id ?? captured.source_id))
    : rows[rows.length - 1];
  if (!source || (captured && ctx.tombstones.includes(captured.source_id)))
    return denied("source_removed");
  if (
    captured &&
    (snapshotKey(source) !== captured.lineage.public_snapshot ||
      (captured.source.source_planned_set_id &&
        source.source_revision !== captured.source.source_revision))
  )
    return denied("source_changed");
  const capturedRoot = captured && rows.find((row) => row.id === captured.lineage.root_source_id);
  if (
    captured &&
    (!capturedRoot || capturedRoot.source_revision !== captured.lineage.root_source_revision)
  )
    return denied("source_changed");
  if (!uuid(source.id)) return denied("missing_identity");
  if (ctx.tombstones.includes(source.id)) return denied("source_removed");
  const parent = entries.find((entry) => entry.provisional.id === source.id);
  if (parent && parent.execution.phase !== "pending")
    return denied(parent.execution.reason ?? "source_changed");
  if (
    parent &&
    (parent.intent.transport.payload.exercise_id !== ctx.exercise_id ||
      parent.intent.transport.entity_id !== ctx.session_id ||
      parent.intent.transport.payload.correlation_id !== source.id ||
      parent.provisional.set_no !== source.set_no ||
      snapshotKey(parent.provisional) !== snapshotKey(source))
  )
    return denied("source_changed");
  const root = parent ? rows.find((row) => row.id === parent.lineage.root_source_id) : source;
  if (!root || ctx.tombstones.includes(root.id)) return denied("source_removed");
  const permit = metadata(root);
  if (!permit) return denied("eligibility_unavailable");
  if (permit.status !== "allowed") return denied("unsafe_assistance_snapshot");
  if (
    parent &&
    (parent.lineage.root_source_revision !== root.source_revision ||
      parent.lineage.public_snapshot !== snapshotKey(root))
  )
    return denied("source_changed");
  // A local copy's lineage substitutes only for that copy's absent server metadata.
  for (const row of rows) {
    const pending = entries.find((entry) => entry.provisional.id === row.id);
    if (pending) {
      const pendingRoot = rows.find((member) => member.id === pending.lineage.root_source_id);
      const pendingPermit = pendingRoot && metadata(pendingRoot);
      if (
        !pendingRoot ||
        !pendingPermit ||
        pendingPermit.cohort_revision !== permit.cohort_revision ||
        pending.execution.phase !== "pending" ||
        pending.intent.transport.payload.exercise_id !== ctx.exercise_id ||
        pending.lineage.root_source_revision !== pendingRoot.source_revision ||
        pending.lineage.public_snapshot !== snapshotKey(pendingRoot) ||
        pending.lineage.public_snapshot !== snapshotKey(row) ||
        pending.provisional.set_no !== row.set_no ||
        ctx.tombstones.includes(row.id)
      )
        return denied("source_changed");
      for (const clientId of pending.lineage.parent_client_ids) {
        const ancestor = entries.find((entry) => entry.intent.transport.client_id === clientId);
        if (
          !ancestor ||
          ancestor.execution.phase === "blocked" ||
          ancestor.lineage.root_source_id !== pendingRoot.id ||
          ancestor.intent.transport.payload.exercise_id !== ctx.exercise_id
        )
          return denied("source_changed");
      }
    } else {
      const rowPermit = metadata(row);
      if (!rowPermit || rowPermit.cohort_revision !== permit.cohort_revision)
        return denied("eligibility_unavailable");
      // The selected root's allowed permit authorizes C(false); other rows need S(actual).
      if (
        !visibleCopySafe(row) ||
        row.rules_version !== root.rules_version ||
        row.assistance_provenance !== root.assistance_provenance ||
        (row.load_kind === "assistance") !== (root.load_kind === "assistance")
      )
        return denied("unsafe_assistance_snapshot");
    }
  }
  return {
    ok: true,
    source,
    nextSetNo: rows.length + 1,
    sourceReference: captured
      ? { ...captured.source }
      : parent
        ? { source_correlation_id: source.id }
        : { source_planned_set_id: source.id, source_revision: source.source_revision! },
    lineage: captured
      ? {
          ...captured.lineage,
          parent_client_ids: [...captured.lineage.parent_client_ids],
          cohort_revision: permit.cohort_revision,
        }
      : parent
        ? {
            ...parent.lineage,
            parent_client_ids: [
              ...parent.lineage.parent_client_ids,
              parent.intent.transport.client_id,
            ],
          }
        : {
            root_source_id: source.id,
            root_source_revision: source.source_revision!,
            cohort_revision: permit.cohort_revision,
            public_snapshot: snapshotKey(source),
            parent_client_ids: [],
          },
  };
}

/** Synchronous, health-value-free capture before the UI's first asynchronous operation. */
export function captureAppendSource(
  ctx: AppendContext,
): Denied | { ok: true; capture: CapturedAppendSource } {
  const result = assessAppend(ctx);
  if (!result.ok) return result;
  return {
    ok: true,
    capture: copyFrozen({
      user_id: ctx.user_id,
      session_id: ctx.session_id,
      exercise_id: ctx.exercise_id,
      source_id: result.source.id,
      source: result.sourceReference,
      lineage: result.lineage,
    }),
  };
}

export function createAppendEntry(
  ctx: AppendContext,
  identity: { client_id: string; correlation_id: string; updated_at: string },
  captured?: CapturedAppendSource,
): Denied | { ok: true; entry: AppendEntry } {
  const assessment = assessAppend(ctx, captured);
  if (!assessment.ok) return assessment;
  if (
    !uuid(identity.client_id) ||
    !uuid(identity.correlation_id) ||
    !Number.isFinite(Date.parse(identity.updated_at))
  )
    return denied("missing_identity");
  if (
    ctx.entries.some(
      (entry) =>
        entry.intent.transport.client_id === identity.client_id ||
        entry.intent.transport.payload.correlation_id === identity.correlation_id,
    ) ||
    ctx.snapshot.rows.some((row) => row.id === identity.correlation_id) ||
    ctx.tombstones.includes(identity.correlation_id)
  )
    return denied("correlation_mismatch");
  const provisional: AppendRow = {
    ...publicSnapshot(assessment.source),
    id: identity.correlation_id,
    exercise_id: ctx.exercise_id,
    set_no: assessment.nextSetNo,
    performed_set: null,
    source_revision: null,
    append_eligibility: null,
    correlation_id: identity.correlation_id,
  };
  return {
    ok: true,
    entry: copyFrozen({
      intent: {
        version: 1,
        user_id: ctx.user_id,
        session_id: ctx.session_id,
        transport: {
          client_id: identity.client_id,
          entity: "session_set",
          entity_id: ctx.session_id,
          op: "upsert",
          updated_at: identity.updated_at,
          payload: {
            exercise_id: ctx.exercise_id,
            correlation_id: identity.correlation_id,
            source: assessment.sourceReference,
          },
        },
      },
      provisional,
      lineage: assessment.lineage,
      execution: { phase: "pending", canonical_id: null, row: null, reason: null },
    }),
  };
}

export function acknowledgeAppend(
  entry: AppendEntry,
  ack: AppendScope & { client_id: string; correlation_id: string; planned_set: AppendRow },
): AppendEntry {
  const wire = entry.intent.transport;
  if (
    !sameScope(entry.intent, ack) ||
    wire.entity_id !== ack.session_id ||
    wire.client_id !== ack.client_id ||
    wire.payload.correlation_id !== ack.correlation_id ||
    ack.planned_set.exercise_id !== wire.payload.exercise_id ||
    !uuid(ack.planned_set.id) ||
    entry.execution.phase === "blocked" ||
    (entry.execution.canonical_id !== null && entry.execution.canonical_id !== ack.planned_set.id)
  )
    throw new Error("append acknowledgement identity mismatch");
  return Object.freeze({
    ...entry,
    execution: copyFrozen({
      phase: "applied" as const,
      canonical_id: ack.planned_set.id,
      row: ack.planned_set,
      reason: null,
    }),
  });
}

export function rejectAppend(entry: AppendEntry, reason: string, retryable: boolean): AppendEntry {
  if (!nonempty(reason) || (retryable && reason !== "unresolved_parent"))
    throw new Error("invalid append deferred reason");
  if (
    entry.execution.phase === "blocked" ||
    (entry.execution.phase === "applied" && reason !== "append_target_removed")
  )
    return entry;
  return Object.freeze({
    ...entry,
    execution: Object.freeze({
      ...entry.execution,
      phase: retryable ? ("pending" as const) : ("blocked" as const),
      reason,
    }),
  });
}

/** GET absence is not a deletion signal. Callers supply only confirmed tombstones in this scope. */
export function overlayAppends(
  scope: AppendScope,
  authoritative: readonly AppendRow[],
  allEntries: readonly AppendEntry[],
  tombstones: readonly string[],
) {
  const entries = allEntries.filter((entry) => sameScope(scope, entry.intent));
  const deleted = new Set(tombstones);
  const blocked: { entry: AppendEntry; reason: string }[] = [];
  const additions: AppendRow[] = [];
  const aliases = new Map<string, string>();
  const observedIdentities: { correlation_id: string; planned_set_id: string }[] = [];
  for (const row of authoritative) {
    if (row.id === row.correlation_id) continue;
    const entry = entries.find(
      (item) => item.intent.transport.payload.correlation_id === row.correlation_id,
    );
    if (!entry) continue;
    if (
      row.exercise_id !== entry.intent.transport.payload.exercise_id ||
      !uuid(row.id) ||
      (entry.execution.canonical_id !== null && entry.execution.canonical_id !== row.id)
    )
      throw new Error("authoritative correlation identity mismatch");
    if (row.id !== row.correlation_id) {
      aliases.set(row.correlation_id!, row.id);
      observedIdentities.push({ correlation_id: row.correlation_id!, planned_set_id: row.id });
    }
  }
  // Close tombstones over the pending dependency chain before visiting rows; input order is irrelevant.
  for (let pass = 0; pass < entries.length; pass++) {
    const size = deleted.size;
    for (const entry of entries) {
      const target = entry.execution.canonical_id ?? aliases.get(entry.provisional.id);
      const source = entry.intent.transport.payload.source;
      const parentId = source.source_correlation_id ?? source.source_planned_set_id;
      const parent = entries.find(
        (item) => item.intent.transport.payload.correlation_id === parentId,
      );
      if (
        entry.execution.phase === "blocked" ||
        deleted.has(entry.provisional.id) ||
        (target != null && deleted.has(target)) ||
        (entry.execution.phase === "pending" &&
          (deleted.has(parentId) ||
            deleted.has(entry.lineage.root_source_id) ||
            (parent?.execution.canonical_id != null && deleted.has(parent.execution.canonical_id))))
      ) {
        deleted.add(entry.provisional.id);
        if (target) deleted.add(target);
      }
    }
    if (deleted.size === size) break;
  }
  for (const entry of entries) {
    const correlation = entry.intent.transport.payload.correlation_id;
    const target = entry.execution.canonical_id ?? aliases.get(correlation) ?? correlation;
    if (target !== correlation) aliases.set(correlation, target);
    const source = entry.intent.transport.payload.source;
    const parentId = source.source_correlation_id ?? source.source_planned_set_id;
    const parent = entries.find(
      (item) => item.intent.transport.payload.correlation_id === parentId,
    );
    const reason =
      entry.execution.phase === "blocked"
        ? entry.execution.reason!
        : tombstones.includes(target) || tombstones.includes(correlation)
          ? "append_target_removed"
          : entry.execution.phase === "pending" &&
              (deleted.has(parentId) ||
                deleted.has(entry.lineage.root_source_id) ||
                (parent?.execution.canonical_id != null &&
                  deleted.has(parent.execution.canonical_id)) ||
                parent?.execution.phase === "blocked")
            ? "source_removed"
            : null;
    if (reason) {
      blocked.push({ entry, reason });
      deleted.add(target);
      deleted.add(correlation);
    } else additions.push(entry.execution.row ?? entry.provisional);
  }
  const rows: AppendRow[] = [];
  const seen = new Set<string>();
  for (const row of authoritative) {
    const canonical = aliases.get(row.id) ?? row.id;
    if (deleted.has(row.id) || deleted.has(canonical) || seen.has(canonical)) continue;
    const resolved = canonical === row.id ? row : additions.find((item) => item.id === canonical);
    if (resolved) {
      rows.push(resolved);
      seen.add(canonical);
    }
  }
  for (const row of [...additions].sort((a, b) => a.set_no - b.set_no)) {
    const canonical = aliases.get(row.id) ?? row.id;
    if (seen.has(canonical)) continue;
    if (seen.has(row.id) || deleted.has(row.id)) continue;
    let last = -1;
    rows.forEach((item, index) => {
      if (item.exercise_id === row.exercise_id) last = index;
    });
    rows.splice(last < 0 ? rows.length : last + 1, 0, row);
    seen.add(row.id);
  }
  return { rows, blocked, observedIdentities };
}

export type AppendDependencies = {
  session_id: string;
  client_ids: string[];
  performed_client_ids?: string[];
};
type DependentTransport = {
  client_id: string;
  entity: "performed_set" | "session";
  entity_id: string;
  op: "upsert" | "delete";
  updated_at: string;
  payload: Record<string, unknown>;
  append_dependencies?: AppendDependencies;
};
export type DependentIntent = AppendScope & {
  version: 1;
  transport: DependentTransport & { append_dependencies: AppendDependencies };
};
export type DependentExecution = { intent: DependentIntent; canonical_entity_id: string };
const canonicalIds = (ids: readonly string[]) => [...new Set(ids)].sort();

/** First committed envelope only. Remapping an execution reference never calls this constructor again. */
export function freezeDependentIntent(
  scope: AppendScope,
  mutation: DependentTransport,
  dependencies: AppendDependencies,
): DependentIntent {
  if (
    scope.session_id !== dependencies.session_id ||
    !dependencies.client_ids.length ||
    !uuid(mutation.client_id) ||
    !uuid(mutation.entity_id) ||
    !Number.isFinite(Date.parse(mutation.updated_at)) ||
    (mutation.entity === "session" &&
      (mutation.entity_id !== scope.session_id ||
        mutation.op !== "upsert" ||
        mutation.payload.status !== "completed")) ||
    (dependencies.performed_client_ids !== undefined &&
      (mutation.entity !== "session" || mutation.payload.status !== "completed")) ||
    [...dependencies.client_ids, ...(dependencies.performed_client_ids ?? [])].some(
      (value) => !uuid(value),
    )
  )
    throw new Error("invalid append dependency scope or identity");
  return copyFrozen({
    version: 1,
    user_id: scope.user_id,
    session_id: scope.session_id,
    transport: {
      client_id: mutation.client_id,
      entity: mutation.entity,
      entity_id: mutation.entity_id,
      op: mutation.op,
      updated_at: mutation.updated_at,
      payload: mutation.payload,
      append_dependencies: {
        session_id: scope.session_id,
        client_ids: canonicalIds(dependencies.client_ids),
        ...(dependencies.performed_client_ids === undefined
          ? {}
          : { performed_client_ids: canonicalIds(dependencies.performed_client_ids) }),
      },
    },
  });
}

export function mapDependentExecution(
  execution: DependentExecution,
  mapping: AppendScope & { correlation_id: string; planned_set_id: string },
): DependentExecution {
  if (
    !sameScope(execution.intent, mapping) ||
    execution.intent.transport.entity !== "performed_set" ||
    !uuid(mapping.planned_set_id) ||
    ![mapping.correlation_id, mapping.planned_set_id].includes(execution.canonical_entity_id)
  )
    throw new Error("dependent execution identity mismatch");
  return Object.freeze({ intent: execution.intent, canonical_entity_id: mapping.planned_set_id });
}

/** Call inside completion's creation transaction with all durable unacknowledged actuals, including in-flight ones. */
export function completionAppendDependencies(
  scope: AppendScope,
  entries: readonly AppendEntry[],
  pendingPerformed: readonly (AppendScope & { transport: DependentTransport })[],
): AppendDependencies | null {
  const owned = entries.filter((entry) => sameScope(scope, entry.intent));
  const client_ids = canonicalIds(owned.map((entry) => entry.intent.transport.client_id));
  if (!client_ids.length) return null;
  const performed_client_ids = canonicalIds(
    pendingPerformed
      .filter(
        (intent) =>
          sameScope(scope, intent) &&
          intent.transport.entity === "performed_set" &&
          (intent.transport.append_dependencies === undefined ||
            intent.transport.append_dependencies.session_id === scope.session_id) &&
          owned.some(
            (entry) =>
              intent.transport.entity_id === entry.provisional.id ||
              intent.transport.entity_id === entry.execution.canonical_id,
          ),
      )
      .map((intent) => intent.transport.client_id),
  );
  return copyFrozen({ session_id: scope.session_id, client_ids, performed_client_ids });
}
