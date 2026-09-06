import { sessionDb } from "./session-db";
import type { PlannedSet, SyncResponse } from "../../lib/api";

export const POSITION_PREFIX = "session-position:";
const ALIAS_PREFIX = "session-position-alias:";
export type SessionPosition = { exercise_id: string; planned_set_id: string; expanded: boolean };
export type PositionRecord = {
  v: 1;
  session_id: string;
  generation: number;
  position: SessionPosition | null;
};
export const positionKey = (sessionId: string) => `${POSITION_PREFIX}${sessionId}`;
const aliasKey = (sessionId: string, id: string) =>
  `${ALIAS_PREFIX}${JSON.stringify([sessionId, id])}`;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function parsePosition(raw: string | undefined, sessionId: string): PositionRecord | null {
  try {
    const record = JSON.parse(raw ?? "null") as PositionRecord | null;
    if (
      !record ||
      record.v !== 1 ||
      record.session_id !== sessionId ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 0
    )
      return null;
    const p = record.position;
    if (
      p !== null &&
      (!p ||
        !nonempty(p.exercise_id) ||
        !nonempty(p.planned_set_id) ||
        typeof p.expanded !== "boolean")
    )
      return null;
    return {
      v: 1,
      session_id: sessionId,
      generation: record.generation,
      position:
        p === null
          ? null
          : { exercise_id: p.exercise_id, planned_set_id: p.planned_set_id, expanded: p.expanded },
    };
  } catch {
    return null;
  }
}

export async function readPosition(userId: string, sessionId: string): Promise<PositionRecord> {
  return (
    parsePosition(
      (await sessionDb.syncMeta.get([userId, positionKey(sessionId)]))?.value,
      sessionId,
    ) ?? { v: 1, session_id: sessionId, generation: 0, position: null }
  );
}

/** Called inside the same transaction as the write; aliases never cross session/scope. */
export async function resolvePositionAlias(
  userId: string,
  sessionId: string,
  id: string,
): Promise<string> {
  const seen = new Set<string>();
  for (let depth = 0; depth < 8 && !seen.has(id); depth++) {
    seen.add(id);
    const raw = (await sessionDb.syncMeta.get([userId, aliasKey(sessionId, id)]))?.value;
    if (!raw) break;
    try {
      const alias = JSON.parse(raw) as { v?: unknown; to?: unknown };
      if (alias.v !== 1 || !nonempty(alias.to)) break;
      id = alias.to;
    } catch {
      break;
    }
  }
  return id;
}

export async function savePosition(
  userId: string,
  sessionId: string,
  position: SessionPosition,
  generation: number,
): Promise<PositionRecord | null> {
  return sessionDb.transaction("rw", sessionDb.syncMeta, async () => {
    const current = await readPosition(userId, sessionId);
    // A completion/terminal clear wins over writes still pending in an older document.
    if (current.generation !== generation) return null;
    const record: PositionRecord = {
      ...current,
      position: {
        ...position,
        planned_set_id: await resolvePositionAlias(userId, sessionId, position.planned_set_id),
      },
    };
    await sessionDb.syncMeta.put({
      user_id: userId,
      key: positionKey(sessionId),
      value: JSON.stringify(record),
    });
    return record;
  });
}

/** The caller owns the completion/cleanup transaction, including syncMeta. */
export async function clearPositionInTransaction(userId: string, sessionId: string): Promise<void> {
  const current = await readPosition(userId, sessionId);
  await sessionDb.syncMeta.put({
    user_id: userId,
    key: positionKey(sessionId),
    value: JSON.stringify({
      ...current,
      generation: current.generation + 1,
      position: null,
    }),
  });
}

/** Capture owning membership before mapping replaces provisional IDs. No UI listener is required. */
export async function remapPositionsInTransaction(
  userId: string,
  mappings: SyncResponse["planned_set_mappings"],
): Promise<void> {
  const mirrors = await sessionDb.sessions.where("user_id").equals(userId).toArray();
  const drafts = await sessionDb.drafts.where("user_id").equals(userId).toArray();
  const metadata = await sessionDb.syncMeta.where("user_id").equals(userId).toArray();
  for (const mapping of mappings) {
    const owners = new Set(
      drafts.filter((d) => d.planned_set_id === mapping.correlation_id).map((d) => d.session_id),
    );
    for (const mirror of mirrors) {
      const session = mirror.session as { planned_sets?: { id: string }[] } | null;
      if (session?.planned_sets?.some((set) => set.id === mapping.correlation_id))
        owners.add(mirror.session_id);
    }
    for (const row of metadata) {
      if (!row.key.startsWith(POSITION_PREFIX)) continue;
      const record = parsePosition(row.value, row.key.slice(POSITION_PREFIX.length));
      if (record?.position?.planned_set_id !== mapping.correlation_id) continue;
      owners.add(record.session_id);
      await sessionDb.syncMeta.put({
        ...row,
        value: JSON.stringify({
          ...record,
          position: {
            ...record.position,
            planned_set_id: mapping.planned_set_id,
          },
        }),
      });
    }
    for (const sessionId of owners)
      await sessionDb.syncMeta.put({
        user_id: userId,
        key: aliasKey(sessionId, mapping.correlation_id),
        value: JSON.stringify({ v: 1, to: mapping.planned_set_id }),
      });
  }
}

export function resolveSessionPosition(
  position: SessionPosition | null,
  sets: readonly PlannedSet[],
  completed: ReadonlyMap<string, boolean>,
): SessionPosition | null {
  const isComplete = (set: PlannedSet) =>
    completed.get(set.id) ?? set.performed_set?.completed === true;
  const target = sets.find(
    (set) => set.id === position?.planned_set_id && set.exercise_id === position.exercise_id,
  );
  if (target && position) return { ...position, expanded: isComplete(target) && position.expanded };
  const next =
    sets.find((set) => set.exercise_id === position?.exercise_id && !isComplete(set)) ??
    sets.find((set) => !isComplete(set));
  return next ? { exercise_id: next.exercise_id, planned_set_id: next.id, expanded: false } : null;
}
