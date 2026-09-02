"use client";

import { useEffect } from "react";
import { api, type SyncRequest, type SyncResponse } from "../../lib/api";
import {
  COMPLETION_DRAIN_PENDING,
  DEV_USER_SCOPE,
  MARKER_PREFIX,
  markerKeyFor,
  markRemediationPending,
  processRemediationMarkers,
  remediationStateOf,
  safeMappings,
  sessionDb,
  type OutboxMutation,
} from "./session-db";
import { commitRestTimerAliases, remapRestTimersInTransaction } from "./rest-timer-store";

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
  /** marker refetch 의 network seam. production 기본값은 `api.session` 이다. */
  fetchSession?: (sessionId: string) => Promise<unknown>;
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
  private readonly fetchSession: (sessionId: string) => Promise<unknown>;
  private running: Promise<SyncResponse | null> | null = null;
  private rerunRequested = false;

  constructor(options: SyncCoordinatorOptions = {}) {
    this.userId = options.userId ?? DEV_USER_SCOPE;
    this.owner = options.owner ?? ownerId();
    this.clock = options.clock ?? { now: Date.now };
    this.transport = options.transport ?? defaultTransport;
    this.beforeLocalCommit = options.beforeLocalCommit;
    this.duringMappingCommit = options.duringMappingCommit;
    this.fetchSession = options.fetchSession ?? ((sessionId) => api.session(sessionId));
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
      /**
       * **커밋이 성공한 뒤에만** 별칭을 연다. 롤백되면 승격 자체가 없던 일이므로 등록하지 않는다.
       * 이 뒤로 도착하는 늦은 저장은 correlation id 대신 서버 id 를 쓴다 — 트랜잭션이 이미
       * 지나가 손댈 수 없는 창을 이 한 줄이 덮는다.
       */
      commitRestTimerAliases(response.planned_set_mappings);
      if (response.planned_set_mappings.length > 0 && typeof window !== "undefined")
        window.dispatchEvent(
          new CustomEvent(PLANNED_SET_MAPPING_EVENT, {
            detail: response.planned_set_mappings,
          }),
        );
      if (draftsChanged && typeof window !== "undefined")
        window.dispatchEvent(new CustomEvent(SYNC_RESPONSE_EVENT, { detail: response }));
      /**
       * **"다음 sync 에서 authoritative refetch" 를 실제로 수행하는 곳이다.**
       * 트랜잭션 밖에서 돈다 — 네트워크 왕복을 IDB 트랜잭션 안에 넣으면 트랜잭션이 죽는다.
       * 실패해도 sync 자체를 실패시키지 않는다(marker 는 남아 다음 기회에 다시 시도한다).
       */
      await processRemediationMarkers(this.userId, this.fetchSession).catch(() => undefined);
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
        sessionDb.readModels,
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
        /** server 가 적용한 세션 종료. 여기가 governing §F 의 "server 성공 + outbox drain" 지점이다. */
        const completedSessions = new Set<string>();
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
          } else if (row.entity === "session") {
            completedSessions.add(row.entity_id);
          }
          await sessionDb.outbox.delete(clientId);
        }
        await this.cleanupCompletedRemediation(completedSessions);

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

  /**
   * governing §F: `session complete/abandon → server 성공 + outbox drain 뒤 marker·cache cleanup`.
   *
   * **marker 만 지우면 안 된다** — 미러에 남은 unsafe 처방이 그대로 다시 노출된다.
   * 그래서 marker 와 session·routine·read-model 캐시를 **같은 트랜잭션에서 함께** 지운다.
   * 종료 당일 재진입은 authoritative `GET` 이 복원한다.
   *
   * **remediation 대기 중인 세션에만 적용한다.** marker 가 없는 평범한 종료까지 캐시를 지우면
   * 오프라인에서 방금 끝낸 세션을 못 여는 새 회귀가 생긴다(governing 표는 marker lifecycle 표다).
   */
  /**
   * 이 세션에 속한 미전송 mutation 이 남아 있는가.
   *
   * **`entity_id === sessionId` 만 세면 안 된다.** production `performed_set` mutation 의
   * `entity_id` 는 세션 id 가 아니라 **`planned_set_id`** 다(`mutationFor()` 가 그렇게 만든다).
   * 세션 id 로만 세면 기록 mutation 이 잔뜩 남아 있어도 0 이 나와 캐시를 조기에 지운다
   * (독립 재리뷰 P1-2). 그래서 이 세션의 planned-set identity 와 상관시킨다.
   */
  private async hasPendingForSession(sessionId: string): Promise<boolean> {
    const rows = await sessionDb.outbox.where("user_id").equals(this.userId).toArray();
    if (rows.length === 0) return false;
    // 이 세션의 planned-set id: 로컬 draft 와 미러 스냅샷 양쪽에서 모은다.
    const planned = new Set<string>();
    for (const draft of await sessionDb.drafts
      .where("[user_id+session_id]")
      .equals([this.userId, sessionId])
      .toArray())
      planned.add(draft.planned_set_id);
    const mirror = await sessionDb.sessions.get([this.userId, sessionId]);
    if (isObject(mirror?.session) && Array.isArray(mirror.session.planned_sets)) {
      for (const set of mirror.session.planned_sets)
        if (isObject(set) && typeof set.id === "string") planned.add(set.id);
    }
    return rows.some((row) => row.entity_id === sessionId || planned.has(row.entity_id));
  }

  /**
   * completion cleanup 을 **sync 를 넘어 살아남게** 한다.
   *
   * 이번 response 에서 종료가 ack 됐는데 그 세션의 performed-set outbox 가 남아 있으면,
   * 보류 사실을 메모리 `Set` 이 아니라 **`syncMeta` 값**(`pending_completion_drain`)으로 굳힌다.
   * 그러지 않으면 다음 sync 에는 후보가 없고, 그 사이 일반 refetch 가 marker 를 지워
   * **cleanup 이 영영 다시 시도되지 않는다**(독립 재리뷰 P1).
   *
   * 그리고 매 response 마다 **durable 후보 전체를 다시 스캔**해 drain 을 재평가한다 —
   * 마지막 performed-set 이 이번에 ack 됐다면 completion response 가 없어도 여기서 끝난다.
   */
  private async cleanupCompletedRemediation(ackedCompletions: Set<string>): Promise<void> {
    // ① 이번에 ack 된 종료를 durable 후보로 승격한다(이미 marker 가 있던 세션만 — 기존 범위 유지).
    for (const sessionId of ackedCompletions) {
      const key = [this.userId, markerKeyFor(sessionId)] as [string, string];
      const state = remediationStateOf((await sessionDb.syncMeta.get(key))?.value);
      if (state !== "refetch" && state !== "completion") continue;
      await sessionDb.syncMeta.put({
        user_id: this.userId,
        key: markerKeyFor(sessionId),
        value: COMPLETION_DRAIN_PENDING,
      });
    }

    // ② durable 후보 전체를 다시 본다. 이번 response 에 종료가 없어도 재시도된다.
    const candidates = (await sessionDb.syncMeta.where("user_id").equals(this.userId).toArray())
      .filter((row) => remediationStateOf(row.value) === "completion")
      .map((row) => row.key.slice(MARKER_PREFIX.length));

    for (const sessionId of candidates) {
      // drain 이 끝나지 않았으면 정리하지 않는다 — 보낼 게 남았는데 캐시를 지우면 화면이 먼저 빈다.
      if (await this.hasPendingForSession(sessionId)) continue;
      await sessionDb.sessions.delete([this.userId, sessionId]);
      await sessionDb.routines.delete([this.userId, sessionId]);
      const models = await sessionDb.readModels
        .where("[user_id+kind]")
        .equals([this.userId, "history-session"])
        .toArray();
      for (const model of models) {
        if (model.cache_key.endsWith(`:${sessionId}`))
          await sessionDb.readModels.delete([model.user_id, model.cache_key]);
      }
      await sessionDb.syncMeta.delete([this.userId, markerKeyFor(sessionId)]);
    }
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

    /**
     * **휴식 타이머의 세트 정체성도 여기서 옮긴다.**
     *
     * 화면 이벤트에 맡기면 세션 화면이 없을 때 승격이 통째로 빠진다 — foreground sync 는
     * 전역에서 돌기 때문이다. 그러면 저장된 타이머가 correlation id 에 남고 다음 복구가
     * 그걸 "세션에 없는 세트"로 보고 지운다. 이 줄이 durable 경계다(롤백되면 함께 되돌아간다).
     */
    await remapRestTimersInTransaction(this.userId, mappings);

    // This hook proves Dexie rolls the already rewritten draft keys back if any later table fails.
    await this.duringMappingCommit?.();

    const pending = await sessionDb.outbox.where("user_id").equals(this.userId).toArray();
    for (const row of pending) {
      const mapping = byCorrelation.get(row.entity_id);
      if (mapping) await sessionDb.outbox.put({ ...row, entity_id: mapping.planned_set_id });
    }

    /**
     * **매핑도 미러 쓰기다 — 같은 fail-closed 경계를 지나야 한다.**
     * 위의 draft·outbox remap 은 이미 끝났다(그건 사용자의 기록이라 무조건 보존한다).
     * 여기서 거르는 것은 **처방 행**뿐이다: 안전하지 않은 매핑을 미러에 심으면
     * v4 가 지운 세션이 sync 경로로 되살아난다.
     */
    const safeById = new Map(
      safeMappings([...byCorrelation.values()]).map((mapping) => [mapping.correlation_id, mapping]),
    );
    const mirrors = await sessionDb.sessions.where("user_id").equals(this.userId).toArray();
    for (const mirror of mirrors) {
      if (!isObject(mirror.session) || !Array.isArray(mirror.session.planned_sets)) continue;
      let changed = false;
      let blocked = false;
      const localIds = new Set(mirror.local_ids ?? []);
      const planned_sets = mirror.session.planned_sets.map((set) => {
        if (!isObject(set) || typeof set.id !== "string") return set;
        const mapping = byCorrelation.get(set.id);
        if (!mapping) return set;
        const safe = safeById.get(set.id);
        if (!safe) {
          /**
           * 처방은 못 받지만 **identity 는 받는다.**
           *
           * draft·outbox 는 위에서 이미 server id 로 옮겼다. 여기서 행 id 를 correlation 으로
           *남겨 두면 `ExerciseCard` 가 `drafts[set.id]` 로 기록을 찾지 못해 **사용자가 방금 적은
           * 기록이 화면에서 사라진다**(독립 재리뷰 P1-2). 그래서 처방 필드는 로컬 baseline 그대로 두고
           * **id 만 원자적으로 바꾼다** — 네 소비자가 항상 같은 ID 를 본다.
           */
          blocked = true;
          changed = true;
          if (localIds.delete(set.id)) localIds.add(mapping.planned_set_id);
          return { ...set, id: mapping.planned_set_id };
        }
        changed = true;
        localIds.delete(set.id);
        return safe.planned_set;
      });
      if (changed)
        await sessionDb.sessions.put({
          ...mirror,
          session: { ...mirror.session, planned_sets },
          updated_at: new Date(this.clock.now()).toISOString(),
          ...(localIds.size > 0 ? { local_ids: [...localIds] } : { local_ids: undefined }),
        });
      if (blocked) await markRemediationPending(this.userId, mirror.session_id);
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
