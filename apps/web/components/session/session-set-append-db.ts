import type { Session, SyncResponse } from "../../lib/api";
import { isSafeRow, isRemediationPending, sessionDb, type OutboxMutation } from "./session-db";
import {
  acknowledgeAppend,
  createAppendEntry,
  freezeDependentIntent,
  completionAppendDependencies,
  rejectAppend,
  overlayAppends,
  type AppendEntry,
  type AppendRow,
  type AppendScope,
  type CapturedAppendSource,
} from "./session-set-append";
import {
  readPosition,
  savePosition,
  remapPositionsInTransaction,
  clearPositionInTransaction,
} from "./session-position";
import { remapRestTimersInTransaction, restTimerKeyFor } from "./rest-timer-store";

export const APPEND_PREFIX = "session-set-append:";
export class AppendCreationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const key = (sessionId: string) => `${APPEND_PREFIX}${sessionId}`;
export async function readAppendCompletions(scope: AppendScope) {
  return (await sessionDb.outbox.where("user_id").equals(scope.user_id).toArray())
    .filter(
      (row) =>
        row.entity === "session" &&
        row.entity_id === scope.session_id &&
        row.append_dependencies?.session_id === scope.session_id,
    )
    .map((row) => ({ client_id: row.client_id, blocked: row.sync_status === "blocked" }));
}
export type AppendState = {
  v: 1;
  generation: number;
  entries: AppendEntry[];
  tombstones: string[];
};

export async function readAppendState(scope: AppendScope): Promise<AppendState> {
  const raw = (await sessionDb.syncMeta.get([scope.user_id, key(scope.session_id)]))?.value;
  if (raw === undefined) return { v: 1, generation: 0, entries: [], tombstones: [] };
  const state = JSON.parse(raw) as AppendState;
  if (
    state.v !== 1 ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 0 ||
    !Array.isArray(state.entries) ||
    !Array.isArray(state.tombstones) ||
    state.tombstones.some((id) => typeof id !== "string") ||
    state.entries.some(
      (entry) =>
        entry.intent.version !== 1 ||
        entry.intent.user_id !== scope.user_id ||
        entry.intent.session_id !== scope.session_id ||
        entry.intent.transport.entity !== "session_set" ||
        entry.intent.transport.entity_id !== scope.session_id ||
        entry.provisional.id !== entry.intent.transport.payload.correlation_id,
    )
  )
    throw new Error("invalid append envelope");
  return state;
}

async function putState(scope: AppendScope, state: AppendState) {
  await sessionDb.syncMeta.put({
    user_id: scope.user_id,
    key: key(scope.session_id),
    value: JSON.stringify(state),
  });
}

export async function bumpAppendGenerationInTransaction(scope: AppendScope) {
  const state = await readAppendState(scope);
  if (!state.entries.length) return;
  state.generation++;
  await putState(scope, state);
}

/** This path is only for a local envelope: row flags cannot grant append lineage. */
export function isSafeAppendMirror(
  rows: readonly AppendRow[],
  localIds: readonly string[],
  appendIds: readonly string[],
  state: AppendState,
): boolean {
  return rows.every((row) => {
    if (!appendIds.includes(row.id))
      return isSafeRow(row as unknown as Record<string, unknown>, new Set(localIds));
    const entry = state.entries.find(
      (item) => item.provisional.id === row.id && item.execution.phase === "pending",
    );
    return (
      !!entry &&
      JSON.stringify(row) === JSON.stringify(entry.provisional) &&
      !state.tombstones.includes(row.id) &&
      isSafeRow(row as unknown as Record<string, unknown>)
    );
  });
}

export async function commitSessionSetAppend(
  scope: AppendScope,
  input: {
    exercise_id: string;
    today: string;
    generation: number;
    client_id: string;
    correlation_id: string;
    updated_at: string;
    captured?: CapturedAppendSource;
  },
): Promise<AppendEntry> {
  return sessionDb.transaction(
    "rw",
    [sessionDb.sessions, sessionDb.outbox, sessionDb.syncMeta],
    async () => {
      if (await isRemediationPending(scope.user_id, scope.session_id))
        throw new AppendCreationError("eligibility_unavailable");
      const mirror = await sessionDb.sessions.get([scope.user_id, scope.session_id]);
      const session = mirror?.session as Session | undefined;
      if (!session || session.id !== scope.session_id || !Array.isArray(session.planned_sets))
        throw new AppendCreationError("source_removed");
      const state = await readAppendState(scope);
      if (
        !isSafeAppendMirror(
          session.planned_sets,
          mirror?.local_ids ?? [],
          mirror?.append_ids ?? [],
          state,
        )
      )
        throw new AppendCreationError("unsafe_assistance_snapshot");
      if ((await readPosition(scope.user_id, scope.session_id)).generation !== input.generation)
        throw new AppendCreationError("position_generation_changed");
      const result = createAppendEntry(
        {
          ...scope,
          exercise_id: input.exercise_id,
          today: input.today,
          scheduled_date: session.scheduled_date,
          status: session.status,
          snapshot: { ...scope, rows: session.planned_sets },
          entries: state.entries,
          tombstones: state.tombstones,
        },
        input,
        input.captured,
      );
      if (!result.ok) throw new AppendCreationError(result.reason);
      const entry = result.entry;
      // add(), not put(): a reused UUID can never replace another immutable transport intent.
      await sessionDb.outbox.add({
        ...entry.intent.transport,
        user_id: scope.user_id,
        attempts: 0,
      });
      state.entries.push(entry);
      state.generation++;
      await putState(scope, state);
      await sessionDb.sessions.put({
        ...mirror!,
        session: {
          ...session,
          planned_sets: overlayAppends(scope, session.planned_sets, state.entries, state.tombstones)
            .rows,
        },
        append_ids: [...(mirror?.append_ids ?? []), entry.provisional.id],
        updated_at: input.updated_at,
      });
      if (
        !(await savePosition(
          scope.user_id,
          scope.session_id,
          {
            exercise_id: input.exercise_id,
            planned_set_id: entry.provisional.id,
            expanded: false,
          },
          input.generation,
        ))
      )
        throw new Error("position_generation_changed");
      return entry;
    },
  );
}

/** Called in the draft transaction. Execution identity may move; existing transport never does. */
function assertSameDependentIntent(
  existing: OutboxMutation,
  incoming: OutboxMutation,
  identities: readonly string[],
) {
  const payloadKey = (payload: Record<string, unknown>) =>
    JSON.stringify(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  if (
    existing.user_id !== incoming.user_id ||
    existing.entity !== incoming.entity ||
    !identities.includes(existing.entity_id) ||
    existing.op !== incoming.op ||
    existing.updated_at !== incoming.updated_at ||
    payloadKey(existing.payload) !== payloadKey(incoming.payload)
  )
    throw new Error("immutable append intent mismatch");
}

export async function appendDependentMutation(
  scope: AppendScope,
  mutation: OutboxMutation,
): Promise<OutboxMutation> {
  const state = await readAppendState(scope);
  const entry = state.entries.find((item) =>
    [item.provisional.id, item.execution.canonical_id].includes(mutation.entity_id),
  );
  if (!entry || mutation.entity !== "performed_set") return mutation;
  const existing = await sessionDb.outbox.get(mutation.client_id);
  if (existing) {
    assertSameDependentIntent(existing, mutation, [
      entry.provisional.id,
      ...(entry.execution.canonical_id ? [entry.execution.canonical_id] : []),
    ]);
    if (existing.append_dependencies?.session_id !== scope.session_id)
      throw new Error("immutable append intent scope mismatch");
    return existing;
  }
  const intent = freezeDependentIntent(
    scope,
    { ...mutation, entity: "performed_set" },
    {
      session_id: scope.session_id,
      client_ids: [...entry.lineage.parent_client_ids, entry.intent.transport.client_id],
    },
  );
  return {
    ...intent.transport,
    user_id: scope.user_id,
    attempts: mutation.attempts,
    ...(entry.execution.phase === "blocked"
      ? { sync_status: "blocked" as const, sync_reason: entry.execution.reason ?? undefined }
      : {}),
  };
}

/** Creation transaction owns the finite barrier; retrying an existing C never reads a new barrier. */
export async function appendCompletionMutation(
  scope: AppendScope,
  mutation: OutboxMutation,
): Promise<OutboxMutation> {
  const state = await readAppendState(scope);
  if (!state.entries.length) return mutation;
  const existing = await sessionDb.outbox.get(mutation.client_id);
  if (existing) {
    assertSameDependentIntent(existing, mutation, [scope.session_id]);
    return existing;
  }
  const actuals = (await sessionDb.outbox.where("user_id").equals(scope.user_id).toArray())
    .filter(
      (row): row is OutboxMutation & { entity: "performed_set" } => row.entity === "performed_set",
    )
    .map((row) => ({ ...scope, transport: row }));
  const dependencies = completionAppendDependencies(scope, state.entries, actuals)!;
  const intent = freezeDependentIntent(scope, { ...mutation, entity: "session" }, dependencies);
  const blocked =
    state.entries.some((entry) => entry.execution.phase === "blocked") ||
    actuals.some(
      (row) =>
        dependencies.performed_client_ids?.includes(row.transport.client_id) &&
        row.transport.sync_status === "blocked",
    );
  return {
    ...intent.transport,
    user_id: scope.user_id,
    attempts: mutation.attempts,
    ...(blocked ? { sync_status: "blocked" as const, sync_reason: "dependent_conflict" } : {}),
  };
}

export async function clearAppendAuditInTransaction(userId: string, clientId: string) {
  const audits = await sessionDb.conflicts.where("client_id").equals(clientId).toArray();
  for (const audit of audits)
    if (audit.user_id === userId) await sessionDb.conflicts.delete(audit.id!);
}

async function confirmRemovedActualTarget(row: OutboxMutation, scope: AppendScope) {
  if (
    row.user_id !== scope.user_id ||
    row.entity !== "performed_set" ||
    row.append_dependencies?.session_id !== scope.session_id
  )
    return;
  const state = await readAppendState(scope);
  const entry = state.entries.find(
    (entry) =>
      entry.execution.canonical_id !== null &&
      [entry.provisional.id, entry.execution.canonical_id].includes(row.entity_id) &&
      row.append_dependencies!.client_ids.includes(entry.intent.transport.client_id),
  );
  if (!entry) return;
  await confirmAppendDeletionInTransaction(scope, [
    {
      planned_set_id: entry.execution.canonical_id,
      correlation_id: entry.provisional.id,
      exercise_id: entry.intent.transport.payload.exercise_id,
    },
  ]);
}

/** Returns true only for the additive append/dependency branch; legacy conflicts keep their policy. */
export async function preserveAppendConflictInTransaction(
  row: OutboxMutation,
  conflict: SyncResponse["conflicts"][number],
): Promise<boolean> {
  if (row.entity !== "session_set" && !row.append_dependencies) return false;
  const retryable = conflict.reason === "unresolved_parent" && conflict.retryable === true;
  if (conflict.retryable === false && row.append_dependencies) {
    const scope = { user_id: row.user_id, session_id: row.append_dependencies.session_id };
    if (conflict.reason === "append_target_removed") await confirmRemovedActualTarget(row, scope);
    if (
      row.entity === "session" &&
      conflict.reason === "dependent_conflict" &&
      conflict.cause_reason === "append_target_removed" &&
      conflict.cause_client_id &&
      row.append_dependencies.performed_client_ids?.includes(conflict.cause_client_id)
    ) {
      const cause = await sessionDb.outbox.get(conflict.cause_client_id);
      if (cause) await confirmRemovedActualTarget(cause, scope);
    }
  }
  const phase = row.sync_status === "blocked" || !retryable ? "blocked" : "pending";
  await sessionDb.outbox.put({
    ...row,
    sync_status: phase,
    sync_reason: conflict.reason,
    ...(conflict.cause_client_id ? { cause_client_id: conflict.cause_client_id } : {}),
    ...(conflict.cause_reason ? { cause_reason: conflict.cause_reason } : {}),
  });
  const audits = (
    await sessionDb.conflicts.where("client_id").equals(row.client_id).toArray()
  ).filter((audit) => audit.user_id === row.user_id);
  await sessionDb.conflicts.put({
    ...(audits[0]?.id ? { id: audits[0].id } : {}),
    user_id: row.user_id,
    client_id: row.client_id,
    kind: conflict.reason,
    payload: row,
  });
  for (const duplicate of audits.slice(1)) await sessionDb.conflicts.delete(duplicate.id!);
  if (row.entity === "session_set") {
    const scope = { user_id: row.user_id, session_id: row.entity_id };
    const state = await readAppendState(scope);
    const index = state.entries.findIndex(
      (entry) => entry.intent.transport.client_id === row.client_id,
    );
    if (index >= 0) {
      const previous = state.entries[index];
      state.entries[index] = rejectAppend(previous, conflict.reason, retryable);
      if (!retryable && conflict.reason === "append_target_removed")
        state.tombstones = [
          ...new Set([
            ...state.tombstones,
            previous.provisional.id,
            ...(previous.execution.canonical_id ? [previous.execution.canonical_id] : []),
          ]),
        ];
      if (!retryable && conflict.reason === "source_removed") {
        const source = previous.intent.transport.payload.source;
        state.tombstones = [
          ...new Set([
            ...state.tombstones,
            source.source_correlation_id ?? source.source_planned_set_id,
          ]),
        ];
      }
      if (!retryable) state.generation++;
      await putState(scope, state);
    }
  }
  return true;
}

export async function completeAppendSessionInTransaction(row: OutboxMutation) {
  if (row.entity !== "session" || !row.append_dependencies) return;
  const current = await sessionDb.sessions.get([row.user_id, row.entity_id]);
  if (current)
    await sessionDb.sessions.put({
      ...current,
      session: { ...(current.session as Session), status: "completed" },
      updated_at: row.updated_at,
    });
  await clearPositionInTransaction(row.user_id, row.entity_id);
  await sessionDb.syncMeta.delete([row.user_id, restTimerKeyFor(row.entity_id)]);
}

/** Only a successful mutation/change's scoped identities can enter this namespace. */
export async function confirmAppendDeletionInTransaction(scope: AppendScope, tombstones: unknown) {
  if (!Array.isArray(tombstones)) throw new Error("invalid routine tombstones");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const identities: string[] = [];
  for (const value of tombstones) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.planned_set_id !== "string" ||
      !uuid.test(value.planned_set_id) ||
      !(
        value.correlation_id === null ||
        (typeof value.correlation_id === "string" && uuid.test(value.correlation_id))
      ) ||
      typeof value.exercise_id !== "string" ||
      !value.exercise_id
    )
      throw new Error("invalid routine tombstone identity");
    identities.push(value.planned_set_id);
    if (value.correlation_id) identities.push(value.correlation_id);
  }
  if (!identities.length) return;
  const state = await readAppendState(scope);
  if (identities.every((id) => state.tombstones.includes(id))) return;
  state.tombstones = [...new Set([...state.tombstones, ...identities])];
  state.generation++;
  await putState(scope, state);
}

/** A confirmed terminal parent blocks its immutable descendants without generating new intents. */
export async function reconcileBlockedAppendsInTransaction(userId: string) {
  const envelopes = (await sessionDb.syncMeta.where("user_id").equals(userId).toArray()).filter(
    (row) => row.key.startsWith(APPEND_PREFIX),
  );
  for (const envelope of envelopes) {
    const scope = { user_id: userId, session_id: envelope.key.slice(APPEND_PREFIX.length) };
    const state = await readAppendState(scope);
    const mirror = await sessionDb.sessions.get([userId, scope.session_id]);
    const session = mirror?.session as Session | undefined;
    const removed = overlayAppends(
      scope,
      session?.planned_sets ?? [],
      state.entries,
      state.tombstones,
    ).blocked;
    let changed = false;
    state.entries = state.entries.map((entry) => {
      const removal = removed.find((item) => item.entry === entry);
      if (!removal || entry.execution.phase === "blocked") return entry;
      changed = true;
      return rejectAppend(entry, removal.reason, false);
    });
    const blocked = new Set(
      state.entries
        .filter((entry) => entry.execution.phase === "blocked")
        .map((entry) => entry.intent.transport.client_id),
    );
    for (let pass = 0; pass < state.entries.length; pass++) {
      const size = blocked.size;
      state.entries = state.entries.map((entry) => {
        if (
          entry.execution.phase !== "pending" ||
          !entry.lineage.parent_client_ids.some((id) => blocked.has(id))
        )
          return entry;
        changed = true;
        blocked.add(entry.intent.transport.client_id);
        return rejectAppend(entry, "dependent_conflict", false);
      });
      if (size === blocked.size) break;
    }
    if (!blocked.size && !state.tombstones.length) continue;
    if (changed) state.generation++;
    const outbox = await sessionDb.outbox.where("user_id").equals(userId).toArray();
    for (const row of outbox) {
      const own = state.entries.find((entry) => entry.intent.transport.client_id === row.client_id);
      const parents =
        row.append_dependencies?.session_id === scope.session_id
          ? row.append_dependencies.client_ids
          : (own?.lineage.parent_client_ids ?? []);
      const cause = parents.find((id) => blocked.has(id));
      const causeEntry = state.entries.find((entry) => entry.intent.transport.client_id === cause);
      if (row.sync_status !== "blocked" && (cause || blocked.has(row.client_id)))
        await sessionDb.outbox.put({
          ...row,
          sync_status: "blocked",
          sync_reason: cause
            ? "dependent_conflict"
            : (own?.execution.reason ?? "dependent_conflict"),
          ...(cause
            ? { cause_client_id: cause, cause_reason: causeEntry?.execution.reason ?? undefined }
            : {}),
        });
    }
    await putState(scope, state);
    if (!session || !Array.isArray(session.planned_sets)) continue;
    const result = overlayAppends(scope, session.planned_sets, state.entries, state.tombstones);
    const ids = new Set(result.rows.map((row) => row.id));
    await sessionDb.sessions.put({
      ...mirror!,
      session: { ...session, planned_sets: result.rows },
      append_ids: (mirror?.append_ids ?? []).filter((id) => ids.has(id)),
      ...(mirror?.local_ids ? { local_ids: mirror.local_ids.filter((id) => ids.has(id)) } : {}),
    });
  }
}

/** GET correlation is sufficient for identity, but is never a receipt for outbox acknowledgement. */
async function observeIdentity(scope: AppendScope, mappings: SyncResponse["planned_set_mappings"]) {
  if (!mappings.length) return;
  await remapPositionsInTransaction(scope.user_id, mappings);
  await remapRestTimersInTransaction(scope.user_id, mappings);
  for (const mapping of mappings) {
    const drafts = await sessionDb.drafts
      .where("planned_set_id")
      .equals(mapping.correlation_id)
      .toArray();
    for (const draft of drafts) {
      if (draft.user_id !== scope.user_id || draft.session_id !== scope.session_id) continue;
      const canonical = await sessionDb.drafts.get([
        scope.user_id,
        scope.session_id,
        mapping.planned_set_id,
      ]);
      await sessionDb.drafts.delete([scope.user_id, scope.session_id, mapping.correlation_id]);
      if (
        !canonical ||
        draft.updated_at > canonical.updated_at ||
        (draft.updated_at === canonical.updated_at && draft.client_id > canonical.client_id)
      )
        await sessionDb.drafts.put({ ...draft, planned_set_id: mapping.planned_set_id });
    }
    const outbox = await sessionDb.outbox
      .where("[user_id+entity_id]")
      .equals([scope.user_id, mapping.correlation_id])
      .toArray();
    for (const row of outbox)
      if (row.append_dependencies?.session_id === scope.session_id)
        await sessionDb.outbox.put({ ...row, canonical_entity_id: mapping.planned_set_id });
  }
}

/** Caller holds the sessions/drafts/outbox/syncMeta transaction. Original API safety runs first. */
export async function overlayAppendReadInTransaction(
  scope: AppendScope,
  fetched: Session,
  startedGeneration?: number | null,
): Promise<{ session: Session; append_ids?: string[]; local_ids?: string[] }> {
  const state = await readAppendState(scope);
  const current = await sessionDb.sessions.get([scope.user_id, scope.session_id]);
  const pendingRoutine =
    state.entries.length > 0 &&
    (
      await sessionDb.outbox
        .where("[user_id+entity_id]")
        .equals([scope.user_id, scope.session_id])
        .toArray()
    ).some((row) => row.entity === "session_routine");
  if (
    current &&
    (pendingRoutine ||
      (startedGeneration === null && state.entries.length > 0) ||
      (startedGeneration !== null &&
        startedGeneration !== undefined &&
        startedGeneration !== state.generation))
  )
    return {
      session: current.session as Session,
      append_ids: current.append_ids,
      local_ids: current.local_ids,
    };
  if (!state.entries.length && !state.tombstones.length) return { session: fetched };
  const result = overlayAppends(scope, fetched.planned_sets, state.entries, state.tombstones);
  const mappings: SyncResponse["planned_set_mappings"] = [];
  for (const observed of result.observedIdentities) {
    const index = state.entries.findIndex(
      (entry) => entry.provisional.id === observed.correlation_id,
    );
    const entry = state.entries[index];
    if (result.blocked.some((blocked) => blocked.entry === entry)) continue;
    const row = fetched.planned_sets.find((row) => row.id === observed.planned_set_id)!;
    state.entries[index] = {
      ...entry,
      execution: { ...entry.execution, canonical_id: row.id, row },
    };
    mappings.push({ ...observed, planned_set: row });
  }
  await observeIdentity(scope, mappings);
  await putState(scope, state);
  return {
    session: { ...fetched, planned_sets: result.rows as Session["planned_sets"] },
    append_ids: result.rows
      .filter((row) => state.entries.some((entry) => entry.provisional.id === row.id))
      .map((row) => row.id),
  };
}

/** Same coordinator transaction as position/draft/timer remapping and outbox removal. */
export async function acknowledgeAppendsInTransaction(
  userId: string,
  response: SyncResponse,
): Promise<void> {
  const envelopes = (await sessionDb.syncMeta.where("user_id").equals(userId).toArray()).filter(
    (row) => row.key.startsWith(APPEND_PREFIX),
  );
  for (const envelope of envelopes) {
    const scope = { user_id: userId, session_id: envelope.key.slice(APPEND_PREFIX.length) };
    const state = await readAppendState(scope);
    let changed = false;
    for (const clientId of response.applied) {
      const pending = await sessionDb.outbox.get(clientId);
      if (
        pending?.user_id === userId &&
        pending.entity === "session_routine" &&
        pending.entity_id === scope.session_id
      )
        changed = true;
    }
    for (let index = 0; index < state.entries.length; index++) {
      const entry = state.entries[index];
      if (!response.applied.includes(entry.intent.transport.client_id)) continue;
      const mapping = response.planned_set_mappings.find(
        (item) => item.correlation_id === entry.provisional.id,
      );
      if (
        !mapping ||
        mapping.planned_set.id !== mapping.planned_set_id ||
        !isSafeRow(mapping.planned_set as unknown as Record<string, unknown>)
      )
        throw new Error("append receipt missing safe canonical mapping");
      state.entries[index] = acknowledgeAppend(entry, {
        ...scope,
        client_id: entry.intent.transport.client_id,
        ...mapping,
      });
      changed = true;
    }
    if (changed) {
      state.generation++;
      await putState(scope, state);
    }
  }
}
