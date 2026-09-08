import type { BrowserContext, Page } from "@playwright/test";
import type { Session } from "../../lib/api";
import type { OutboxMutation, StoredDraft } from "../../components/session/session-db";
import type { AppendState } from "../../components/session/session-set-append-db";
import { WEB_ORIGIN } from "../helpers";

const owned = new WeakSet<BrowserContext>();
export function ownAppendContext(context: BrowserContext) {
  owned.add(context);
}

/** Existing synthetic origin only; all related records come from one completed readonly transaction. */
export async function appendObservation(page: Page, sessionId: string) {
  if (!owned.has(page.context()) || new URL(page.url()).origin !== WEB_ORIGIN)
    throw new Error(
      "Append observation requires the registered fresh owned context and exact origin.",
    );
  return page.evaluate(async (id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error("Invalid owned session identity.");
    const opening = indexedDB.open("afc-session-v1");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onupgradeneeded = () => {
        opening.transaction?.abort();
        reject(new Error("Read observation cannot create or upgrade IndexedDB."));
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => resolve(opening.result);
    });
    try {
      const stores = ["sessions", "routines", "drafts", "outbox", "syncMeta"];
      const tx = db.transaction(stores, "readonly");
      const completed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("Observation aborted"));
        tx.onerror = () => reject(tx.error);
      });
      const values = await Promise.all(
        stores.map(
          (store) =>
            new Promise<Record<string, unknown>[]>((resolve, reject) => {
              const read = tx.objectStore(store).index("user_id").getAll("dev-user");
              read.onsuccess = () => resolve(read.result as Record<string, unknown>[]);
              read.onerror = () => reject(read.error);
            }),
        ),
      );
      await completed;
      const [allSessions, allRoutines, allDrafts, allOutbox, meta] = values;
      const sessions = allSessions.filter((row) => row.session_id === id);
      const mirror = (sessions[0]?.session ?? null) as Session | null;
      const drafts = allDrafts.filter((row) => row.session_id === id) as StoredDraft[];
      const parse = <T>(key: string): T | null => {
        const record = meta.find((row) => row.key === key);
        return record ? (JSON.parse(String(record.value)) as T) : null;
      };
      const append = parse<AppendState>(`session-set-append:${id}`);
      const identities = new Set([
        ...(mirror?.planned_sets.map((row) => row.id) ?? []),
        ...drafts.map((row) => row.planned_set_id),
        ...(append?.entries.flatMap((entry) => [
          entry.provisional.id,
          entry.execution.canonical_id,
        ]) ?? []),
      ]);
      const outbox = (allOutbox as OutboxMutation[]).filter(
        (row) =>
          row.entity_id === id ||
          row.append_dependencies?.session_id === id ||
          identities.has(row.entity_id) ||
          identities.has(row.canonical_entity_id ?? null),
      );
      return {
        sessionId: id,
        transactionCompleted: true,
        observedAt: Date.now(),
        mirror,
        sessions,
        routines: allRoutines.filter((row) => row.session_id === id),
        drafts,
        outbox,
        append,
        position: parse<{
          v: number;
          session_id: string;
          generation: number;
          position: { exercise_id: string; planned_set_id: string; expanded: boolean } | null;
        }>(`session-position:${id}`),
        timer: parse<{
          v: number;
          session_id: string;
          planned_set_id: string;
          total_sec: number;
          ends_at: number;
        }>(`rest-timer:${id}`),
        cursor: meta.find((row) => row.key === "cursor")?.value ?? null,
        focusedId: document.activeElement?.id ?? null,
        visibleRows: Array.from(document.querySelectorAll("[data-planned-set-id]")).map((row) => ({
          id: row.getAttribute("data-planned-set-id"),
          active: row.getAttribute("data-session-current"),
          expanded: row.getAttribute("data-expanded"),
        })),
        serviceWorker: navigator.serviceWorker.controller?.scriptURL ?? null,
        online: navigator.onLine,
      };
    } finally {
      db.close();
    }
  }, sessionId);
}

export type AppendObservation = Awaited<ReturnType<typeof appendObservation>>;

/** Local retry/alias bookkeeping is not part of the immutable HTTP mutation. */
export function originalTransport(row: OutboxMutation) {
  return {
    client_id: row.client_id,
    entity: row.entity,
    entity_id: row.entity_id,
    op: row.op,
    payload: row.payload,
    updated_at: row.updated_at,
    ...(row.append_dependencies ? { append_dependencies: row.append_dependencies } : {}),
  };
}
