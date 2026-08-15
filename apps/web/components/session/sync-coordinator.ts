"use client";

import { useEffect } from "react";
import { api, type SyncRequest, type SyncResponse } from "../../lib/api";
import { DEV_USER_SCOPE, sessionDb, type OutboxMutation } from "./session-db";

const LEASE_NAME = "foreground-sync";
const LEASE_MS = 15_000;
const TRANSPORT_TIMEOUT_MS = 10_000;
export const PLANNED_SET_MAPPING_EVENT = "afc:planned-set-mapping";
export const SYNC_RESPONSE_EVENT = "afc:sync-response";

export type SyncClock = { now: () => number };
export type SyncTransport = (body: SyncRequest) => Promise<SyncResponse>;
export type SyncCoordinatorOptions = {
  userId?: string;
  owner?: string;
  clock?: SyncClock;
  transport?: SyncTransport;
  /** Test-only fault injection point after a received HTTP response and before its IDB commit. */
  beforeLocalCommit?: () => Promise<void> | void;
  /** Test-only fault point inside the mapping transaction after draft keys changed. */
  duringMappingCommit?: () => Promise<void> | void;
};

function ownerId(): string {
  return `tab-${Math.random().toString(36).slice(2)}`;
}

/** Foreground outbox coordinator. Instances cooperate through the per-user IndexedDB lease. */
export class SyncCoordinator {
  private readonly userId: string;
  private readonly owner: string;
  private readonly clock: SyncClock;
  private readonly transport: SyncTransport;
  private readonly beforeLocalCommit?: () => Promise<void> | void;
  private readonly duringMappingCommit?: () => Promise<void> | void;
  private running: Promise<SyncResponse | null> | null = null;
  private rerunRequested = false;

  constructor(options: SyncCoordinatorOptions = {}) {
    this.userId = options.userId ?? DEV_USER_SCOPE;
    this.owner = options.owner ?? ownerId();
    this.clock = options.clock ?? { now: Date.now };
    this.transport = options.transport ?? defaultTransport;
    this.beforeLocalCommit = options.beforeLocalCommit;
    this.duringMappingCommit = options.duringMappingCommit;
  }

  request(ensureLatest = false): Promise<SyncResponse | null> {
    if (this.running) {
      if (ensureLatest) this.rerunRequested = true;
    } else {
      this.running = this.runRequested().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runRequested(): Promise<SyncResponse | null> {
    for (;;) {
      this.rerunRequested = false;
      try {
        const result = await this.sync();
        if (!this.rerunRequested) return result;
      } catch (error) {
        if (!this.rerunRequested) throw error;
      }
    }
  }

  private async acquireLease(): Promise<boolean> {
    const now = this.clock.now();
    return sessionDb.transaction("rw", sessionDb.leases, async () => {
      const key = [this.userId, LEASE_NAME] as [string, string];
      const current = await sessionDb.leases.get(key);
      if (current && current.owner !== this.owner && Date.parse(current.expires_at) > now)
        return false;
      await sessionDb.leases.put({
        user_id: this.userId,
        name: LEASE_NAME,
        owner: this.owner,
        expires_at: new Date(now + LEASE_MS).toISOString(),
      });
      return true;
    });
  }

  private async renewLease(): Promise<boolean> {
    const now = this.clock.now();
    return sessionDb.transaction("rw", sessionDb.leases, async () => {
      const key = [this.userId, LEASE_NAME] as [string, string];
      const current = await sessionDb.leases.get(key);
      if (!current || current.owner !== this.owner) return false;
      await sessionDb.leases.put({
        ...current,
        expires_at: new Date(now + LEASE_MS).toISOString(),
      });
      return true;
    });
  }

  private startHeartbeat(): () => void {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = async () => {
      if (!active) return;
      try {
        if (!(await this.renewLease())) {
          active = false;
          return;
        }
      } catch {
        // The commit transaction fences ownership again. A transient heartbeat failure
        // must not acknowledge rows unless this tab still owns the lease.
      }
      if (active) timer = setTimeout(beat, LEASE_MS / 3);
    };
    timer = setTimeout(beat, LEASE_MS / 3);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }

  private async releaseLease(): Promise<void> {
    await sessionDb.transaction("rw", sessionDb.leases, async () => {
      const key = [this.userId, LEASE_NAME] as [string, string];
      const current = await sessionDb.leases.get(key);
      if (current?.owner === this.owner) await sessionDb.leases.delete(key);
    });
  }

  private async sync(): Promise<SyncResponse | null> {
    if (!(await this.acquireLease())) return null;
    const stopHeartbeat = this.startHeartbeat();
    try {
      const [cursor, rows] = await Promise.all([
        sessionDb.syncMeta.get([this.userId, "cursor"]),
        sessionDb.outbox.where("user_id").equals(this.userId).toArray(),
      ]);
      const mutations = rows
        .sort(
          (a, b) =>
            a.updated_at.localeCompare(b.updated_at) || a.client_id.localeCompare(b.client_id),
        )
        .map(toWireMutation);
      const response = await this.transport({
        ...(cursor?.value ? { since: cursor.value } : {}),
        mutations,
      });
      await this.beforeLocalCommit?.();
      const draftsChanged = await this.commitResponse(response);
      if (response.planned_set_mappings.length > 0 && typeof window !== "undefined")
        window.dispatchEvent(
          new CustomEvent(PLANNED_SET_MAPPING_EVENT, {
            detail: response.planned_set_mappings,
          }),
        );
      if (draftsChanged && typeof window !== "undefined")
        window.dispatchEvent(new CustomEvent(SYNC_RESPONSE_EVENT, { detail: response }));
      return response;
    } finally {
      stopHeartbeat();
      await this.releaseLease().catch(() => undefined);
    }
  }

  private async commitResponse(response: SyncResponse): Promise<boolean> {
    let draftsChanged = false;
    await sessionDb.transaction(
      "rw",
      [
        sessionDb.outbox,
        sessionDb.conflicts,
        sessionDb.syncMeta,
        sessionDb.drafts,
        sessionDb.sessions,
        sessionDb.routines,
        sessionDb.leases,
      ],
      async () => {
        const lease = await sessionDb.leases.get([this.userId, LEASE_NAME]);
        if (
          !lease ||
          lease.owner !== this.owner ||
          Date.parse(lease.expires_at) <= this.clock.now()
        )
          throw new Error("foreground sync lease lost before acknowledgement");
        const applied = new Set(response.applied);
        const conflicts = new Map(
          response.conflicts.map((conflict) => [conflict.client_id, conflict]),
        );
        await this.applyPlannedSetMappings(response.planned_set_mappings);
        for (const clientId of [...applied, ...conflicts.keys()]) {
          const row = await sessionDb.outbox.get(clientId);
          if (!row || row.user_id !== this.userId) continue;
          if (conflicts.has(clientId)) {
            await sessionDb.conflicts.add({
              user_id: this.userId,
              client_id: clientId,
              kind: conflicts.get(clientId)!.reason,
              payload: row,
            });
          }
          await sessionDb.outbox.delete(clientId);
        }

        for (const change of response.changes) {
          if (await this.applyChange(change)) draftsChanged = true;
        }
        await sessionDb.syncMeta.put({
          user_id: this.userId,
          key: "cursor",
          value: response.next_cursor,
        });
      },
    );
    return draftsChanged;
  }

  private async applyPlannedSetMappings(
    mappings: SyncResponse["planned_set_mappings"],
  ): Promise<void> {
    if (mappings.length === 0) return;
    const byCorrelation = new Map(mappings.map((mapping) => [mapping.correlation_id, mapping]));

    for (const mapping of mappings) {
      const drafts = await sessionDb.drafts
        .where("planned_set_id")
        .equals(mapping.correlation_id)
        .toArray();
      for (const draft of drafts) {
        if (draft.user_id !== this.userId) continue;
        await sessionDb.drafts.delete([draft.user_id, draft.session_id, draft.planned_set_id]);
        await sessionDb.drafts.put({ ...draft, planned_set_id: mapping.planned_set_id });
      }
    }

    // This hook proves Dexie rolls the already rewritten draft keys back if any later table fails.
    await this.duringMappingCommit?.();

    const pending = await sessionDb.outbox.where("user_id").equals(this.userId).toArray();
    for (const row of pending) {
      const mapping = byCorrelation.get(row.entity_id);
      if (mapping) await sessionDb.outbox.put({ ...row, entity_id: mapping.planned_set_id });
    }

    const mirrors = await sessionDb.sessions.where("user_id").equals(this.userId).toArray();
    for (const mirror of mirrors) {
      if (!isObject(mirror.session) || !Array.isArray(mirror.session.planned_sets)) continue;
      let changed = false;
      const planned_sets = mirror.session.planned_sets.map((set) => {
        if (!isObject(set) || typeof set.id !== "string") return set;
        const mapping = byCorrelation.get(set.id);
        if (!mapping) return set;
        changed = true;
        return mapping.planned_set;
      });
      if (changed)
        await sessionDb.sessions.put({
          ...mirror,
          session: { ...mirror.session, planned_sets },
          updated_at: new Date(this.clock.now()).toISOString(),
        });
    }

    const routines = await sessionDb.routines.where("user_id").equals(this.userId).toArray();
    for (const routine of routines) {
      let changed = false;
      const correlations = (routine.correlations ?? []).map((item) => {
        const mapping = byCorrelation.get(item.correlation_id);
        if (!mapping) return item;
        changed = true;
        return { ...item, planned_set_id: mapping.planned_set_id };
      });
      if (changed) await sessionDb.routines.put({ ...routine, correlations });
    }
  }

  private async applyChange(change: SyncResponse["changes"][number]): Promise<boolean> {
    // An unacknowledged local write is newer knowledge than a pull row; leave it alone.
    if (
      await sessionDb.outbox
        .where("[user_id+entity_id]")
        .equals([this.userId, change.entity_id])
        .count()
    )
      return false;
    if (change.entity === "performed_set") {
      // Draft primary keys include session ID, so identify the matching local draft through its index.
      const draft = (
        await sessionDb.drafts.where("planned_set_id").equals(change.entity_id).toArray()
      ).find((row) => row.user_id === this.userId);
      if (change.op === "delete") {
        if (draft)
          await sessionDb.drafts.put({
            ...draft,
            completed: false,
            updated_at: new Date(this.clock.now()).toISOString(),
          });
        return draft != null;
      }
      if (!change.data) return false;
      if (draft) {
        await sessionDb.drafts.put({
          ...draft,
          ...change.data,
          completed: true,
          updated_at: new Date(this.clock.now()).toISOString(),
        });
        return true;
      }
      const mirrors = await sessionDb.sessions.where("user_id").equals(this.userId).toArray();
      const owning = mirrors.find(
        (mirror) =>
          isObject(mirror.session) &&
          Array.isArray(mirror.session.planned_sets) &&
          mirror.session.planned_sets.some((set) => isObject(set) && set.id === change.entity_id),
      );
      if (!owning) return false;
      const data = change.data as Record<string, unknown>;
      await sessionDb.drafts.put({
        user_id: this.userId,
        session_id: owning.session_id,
        planned_set_id: change.entity_id,
        actual_weight: numberOrNull(data.actual_weight),
        actual_reps: numberOrNull(data.actual_reps),
        actual_rir: numberOrNull(data.actual_rir),
        actual_time_sec: numberOrNull(data.actual_time_sec),
        pain_score: numberOrNull(data.pain_score),
        completed: true,
        // A pulled row never enters the outbox as-is; the next local edit replaces this UUID.
        client_id: change.entity_id,
        updated_at: new Date(this.clock.now()).toISOString(),
      });
      return true;
    }
    if (change.entity === "session" && change.data) {
      const current = await sessionDb.sessions.get([this.userId, change.entity_id]);
      if (current && typeof current.session === "object" && current.session !== null)
        await sessionDb.sessions.put({
          ...current,
          session: { ...(current.session as Record<string, unknown>), ...change.data },
          updated_at: new Date(this.clock.now()).toISOString(),
        });
      return false;
    }
    if (change.entity === "session_routine" && change.data) {
      const exercise_ids = (change.data as { exercise_ids?: unknown }).exercise_ids;
      if (Array.isArray(exercise_ids) && exercise_ids.every((id) => typeof id === "string")) {
        const current = await sessionDb.routines.get([this.userId, change.entity_id]);
        await sessionDb.routines.put({
          user_id: this.userId,
          session_id: change.entity_id,
          exercise_ids,
          correlations: current?.correlations ?? [],
          updated_at: new Date(this.clock.now()).toISOString(),
        });
      }
    }
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toWireMutation(row: OutboxMutation): SyncRequest["mutations"][number] {
  return {
    client_id: row.client_id,
    entity: row.entity,
    entity_id: row.entity_id,
    op: row.op,
    updated_at: row.updated_at,
    payload: row.payload,
  };
}

async function defaultTransport(body: SyncRequest): Promise<SyncResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS);
  try {
    return await api.sync(body, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

let foreground: SyncCoordinator | null = null;
let leaseRetry: ReturnType<typeof setTimeout> | null = null;

function scheduleLeaseRetry(): void {
  if (leaseRetry) return;
  // A tab can disappear before its owner-only finally block runs. Keep local success
  // immediate, then retry after the crashed owner's bounded lease expires.
  leaseRetry = setTimeout(() => {
    leaseRetry = null;
    void requestForegroundSync().catch(() => undefined);
  }, LEASE_MS + 50);
}

export function requestForegroundSync(): Promise<SyncResponse | null> {
  foreground ??= new SyncCoordinator();
  return foreground.request(true).then((result) => {
    if (result === null) scheduleLeaseRetry();
    return result;
  });
}

/** Required foreground triggers. The singleton coalesces trigger bursts and cleans all listeners. */
export function useForegroundSync(): void {
  useEffect(() => {
    void requestForegroundSync().catch(() => undefined);
    const trigger = () => void requestForegroundSync().catch(() => undefined);
    const visible = () => {
      if (document.visibilityState === "visible") trigger();
    };
    window.addEventListener("online", trigger);
    window.addEventListener("focus", trigger);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", trigger);
      window.removeEventListener("focus", trigger);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
}
