import {
  sessionDb,
  type ReadModelKind,
  type ReadModelMirror,
} from "../components/session/session-db";

export const READ_MODEL_LIMITS: Record<ReadModelKind, number> = {
  dashboard: 1,
  e1rm: 8,
  volume: 4,
  completion: 4,
  "history-session": 48,
};

export type ReadModelEnvelope<T> = {
  data: T;
  source: "server" | "mirror";
  stale: boolean;
  syncedAt: string;
};

export type ReadThroughOptions<T> = {
  userId: string;
  kind: ReadModelKind;
  cacheKey: string;
  fetcher: () => Promise<T>;
  now?: () => Date;
};

export async function readThroughReadModel<T>(
  options: ReadThroughOptions<T>,
): Promise<ReadModelEnvelope<T>> {
  const now = options.now ?? (() => new Date());
  const requestStartedAt = now().getTime();
  try {
    const data = await options.fetcher();
    const syncedAt = now().toISOString();
    await mirrorServerSnapshot({
      user_id: options.userId,
      cache_key: options.cacheKey,
      kind: options.kind,
      data,
      request_started_at: requestStartedAt,
      synced_at: syncedAt,
    }).catch(() => undefined);
    return { data, source: "server", stale: false, syncedAt };
  } catch (error) {
    // Fetch rejects transport loss with TypeError. HTTP responses are ApiError, aborts are
    // AbortError, and malformed successful responses are SyntaxError; none may be hidden.
    if (!(error instanceof TypeError)) throw error;
    const mirrored = await sessionDb.readModels
      .get([options.userId, options.cacheKey])
      .catch(() => undefined);
    if (!mirrored) throw error;
    return {
      data: mirrored.data as T,
      source: "mirror",
      stale: true,
      syncedAt: mirrored.synced_at,
    };
  }
}

export async function clearUserReadModels(userId: string): Promise<void> {
  await sessionDb.readModels.where("user_id").equals(userId).delete();
}

async function mirrorServerSnapshot(snapshot: ReadModelMirror): Promise<void> {
  await sessionDb.transaction("rw", sessionDb.readModels, async () => {
    const existing = await sessionDb.readModels.get([snapshot.user_id, snapshot.cache_key]);
    if (existing && existing.request_started_at > snapshot.request_started_at) return;

    await sessionDb.readModels.put(snapshot);
    const rows = await sessionDb.readModels
      .where("[user_id+kind]")
      .equals([snapshot.user_id, snapshot.kind])
      .toArray();
    const excess = rows
      .sort(
        (left, right) =>
          left.synced_at.localeCompare(right.synced_at) ||
          left.request_started_at - right.request_started_at ||
          left.cache_key.localeCompare(right.cache_key),
      )
      .slice(0, Math.max(0, rows.length - READ_MODEL_LIMITS[snapshot.kind]));
    if (excess.length)
      await sessionDb.readModels.bulkDelete(excess.map((row) => [row.user_id, row.cache_key]));
  });
}
