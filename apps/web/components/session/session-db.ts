import Dexie, { type Table } from "dexie";
import type { Exercise, Session } from "../../lib/api";
import type { SetDraft } from "./session-store";

export const DEV_USER_SCOPE = "dev-user";

export type StoredDraft = SetDraft & { user_id: string; session_id: string };

export type OutboxMutation = {
  client_id: string;
  user_id: string;
  entity: "performed_set" | "session_routine" | "session";
  entity_id: string;
  op: "upsert" | "delete";
  updated_at: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type SessionMirror = { user_id: string; session_id: string; session: unknown; updated_at: string };
type CatalogMirror = { user_id: string; catalog: Exercise[]; updated_at: string };
type RoutineSnapshot = {
  user_id: string;
  session_id: string;
  exercise_ids: string[];
  correlations: RoutineCorrelation[];
  updated_at: string;
};
export type RoutineCorrelation = {
  correlation_id: string;
  exercise_id: string;
  set_no: number;
  planned_set_id?: string;
};
type SyncMeta = { user_id: string; key: string; value: string };
type ConflictAudit = {
  id?: number;
  user_id: string;
  client_id: string;
  kind: string;
  payload: unknown;
};
type Lease = { user_id: string; name: string; owner: string; expires_at: string };

class SessionDatabase extends Dexie {
  drafts!: Table<StoredDraft, unknown>;
  outbox!: Table<OutboxMutation, string>;
  sessions!: Table<SessionMirror, unknown>;
  catalogs!: Table<CatalogMirror, string>;
  routines!: Table<RoutineSnapshot, unknown>;
  syncMeta!: Table<SyncMeta, unknown>;
  conflicts!: Table<ConflictAudit, number>;
  leases!: Table<Lease, unknown>;

  constructor() {
    super("afc-session-v1");
    this.version(1).stores({
      drafts: "[user_id+session_id+planned_set_id], user_id, session_id, planned_set_id",
      outbox: "client_id, user_id, [user_id+entity_id], [user_id+updated_at]",
      sessions: "[user_id+session_id], user_id, session_id",
      routines: "[user_id+session_id], user_id, session_id",
      syncMeta: "[user_id+key], user_id",
      conflicts: "++id, user_id, client_id",
      leases: "[user_id+name], user_id",
    });
    this.version(2).stores({ catalogs: "user_id" });
  }
}

export const sessionDb = new SessionDatabase();

function mutationFor(draft: StoredDraft, op: "upsert" | "delete"): OutboxMutation {
  return {
    client_id: draft.client_id,
    user_id: draft.user_id,
    entity: "performed_set",
    entity_id: draft.planned_set_id,
    op,
    updated_at: draft.updated_at,
    payload:
      op === "delete"
        ? {}
        : {
            actual_weight: draft.actual_weight,
            actual_reps: draft.actual_reps,
            // Missing RIR and RIR 0 have opposite training meanings. Keep an unentered
            // value absent on the wire instead of serializing it as null.
            ...(draft.actual_rir == null ? {} : { actual_rir: draft.actual_rir }),
            actual_time_sec: draft.actual_time_sec,
            pain_score: draft.pain_score,
            completed: true,
          },
    attempts: 0,
  };
}

/** The local entity and its new mutation are never visible separately. */
export async function commitDraft(
  userId: string,
  sessionId: string,
  draft: SetDraft,
  op: "upsert" | "delete" | null,
): Promise<void> {
  await commitDraftBatch(userId, sessionId, [{ draft, op }]);
}

/** One UI action may update several sets (exercise-level pain); it still commits all-or-nothing. */
export async function commitDraftBatch(
  userId: string,
  sessionId: string,
  changes: { draft: SetDraft; op: "upsert" | "delete" | null }[],
): Promise<void> {
  await sessionDb.transaction("rw", sessionDb.drafts, sessionDb.outbox, async () => {
    for (const change of changes) {
      const stored: StoredDraft = {
        ...change.draft,
        user_id: userId,
        session_id: sessionId,
      };
      await sessionDb.drafts.put(stored);
      if (change.op) await sessionDb.outbox.put(mutationFor(stored, change.op));
    }
  });
}

export async function loadDrafts(
  userId: string,
  sessionId: string,
): Promise<Record<string, SetDraft>> {
  const rows = await sessionDb.drafts
    .where("[user_id+session_id]")
    .equals([userId, sessionId])
    .toArray();
  return Object.fromEntries(
    rows.map(({ user_id: _userId, session_id: _sessionId, ...draft }) => [
      draft.planned_set_id,
      draft,
    ]),
  );
}

export async function mirrorSession(
  userId: string,
  sessionId: string,
  session: unknown,
): Promise<void> {
  await sessionDb.sessions.put({
    user_id: userId,
    session_id: sessionId,
    session,
    updated_at: new Date().toISOString(),
  });
}

export async function readMirroredSession<T>(userId: string, sessionId: string): Promise<T | null> {
  return ((await sessionDb.sessions.get([userId, sessionId]))?.session as T | undefined) ?? null;
}

export async function readThroughSession<T>(
  userId: string,
  sessionId: string,
  fetchSession: () => Promise<T>,
): Promise<T> {
  try {
    const fetched = await fetchSession();
    // A cache write failure must not turn a successful online read into a screen error.
    await mirrorSession(userId, sessionId, fetched).catch(() => undefined);
    return fetched;
  } catch (error) {
    const mirrored = await readMirroredSession<T>(userId, sessionId);
    if (mirrored) return mirrored;
    throw error;
  }
}

/** Exercise metadata is not health data, but it is scoped with the local user cache nonetheless. */
export async function mirrorCatalog(userId: string, catalog: Exercise[]): Promise<void> {
  await sessionDb.catalogs.put({ user_id: userId, catalog, updated_at: new Date().toISOString() });
}

export async function readThroughCatalog(
  userId: string,
  fetchCatalog: () => Promise<Exercise[]>,
): Promise<Exercise[]> {
  try {
    const catalog = await fetchCatalog();
    await mirrorCatalog(userId, catalog).catch(() => undefined);
    return catalog;
  } catch (error) {
    const mirrored = await sessionDb.catalogs.get(userId);
    if (mirrored) return mirrored.catalog;
    throw error;
  }
}

/** Local-only primitives for the contract-supported session_routine and session mutations. */
export async function commitRoutineSnapshot(
  userId: string,
  sessionId: string,
  exerciseIds: string[],
  clientId: string,
  updatedAt: string,
  correlations: RoutineCorrelation[] = [],
  session?: Session,
): Promise<void> {
  await sessionDb.transaction(
    "rw",
    sessionDb.routines,
    sessionDb.outbox,
    sessionDb.sessions,
    async () => {
      const previous = await sessionDb.routines.get([userId, sessionId]);
      const merged = new Map(
        (previous?.correlations ?? [])
          .filter((item) => exerciseIds.includes(item.exercise_id))
          .map((item) => [item.correlation_id, item]),
      );
      for (const item of correlations) merged.set(item.correlation_id, item);
      const snapshotCorrelations = [...merged.values()].sort(
        (a, b) =>
          exerciseIds.indexOf(a.exercise_id) - exerciseIds.indexOf(b.exercise_id) ||
          a.set_no - b.set_no,
      );
      await sessionDb.routines.put({
        user_id: userId,
        session_id: sessionId,
        exercise_ids: exerciseIds,
        correlations: snapshotCorrelations,
        updated_at: updatedAt,
      });
      if (session)
        await sessionDb.sessions.put({
          user_id: userId,
          session_id: sessionId,
          session,
          updated_at: updatedAt,
        });
      await sessionDb.outbox.put({
        client_id: clientId,
        user_id: userId,
        entity: "session_routine",
        entity_id: sessionId,
        op: "upsert",
        updated_at: updatedAt,
        payload: {
          exercise_ids: exerciseIds,
          ...(snapshotCorrelations.length
            ? {
                correlations: snapshotCorrelations.map(
                  ({ planned_set_id: _serverId, ...item }) => item,
                ),
              }
            : {}),
        },
        attempts: 0,
      });
    },
  );
}

export async function commitSessionCompletion(
  userId: string,
  sessionId: string,
  payload: Record<string, unknown>,
  clientId: string,
  updatedAt: string,
): Promise<void> {
  await sessionDb.transaction("rw", sessionDb.sessions, sessionDb.outbox, async () => {
    const current = await sessionDb.sessions.get([userId, sessionId]);
    if (current && typeof current.session === "object" && current.session != null) {
      await sessionDb.sessions.put({
        ...current,
        session: { ...(current.session as Record<string, unknown>), status: "completed" },
        updated_at: updatedAt,
      });
    }
    await sessionDb.outbox.put({
      client_id: clientId,
      user_id: userId,
      entity: "session",
      entity_id: sessionId,
      op: "upsert",
      updated_at: updatedAt,
      payload: { ...payload, status: "completed" },
      attempts: 0,
    });
  });
}

export async function requestPersistentStorage(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.storage?.persist)
    await navigator.storage.persist();
}
