import Dexie, { type Table, type Transaction } from "dexie";
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

/**
 * 세션 미러. `local_ids` 는 **로컬 전용 봉투(envelope)** 다 — 이 세션 payload 안에서
 * 로컬이 만든 임시 행의 id 목록이고, 서버로 나가지 않는다.
 * 출처를 행이 스스로 주장하지 못하게 하려고 payload 밖에 둔다(독립 재리뷰 P2-1).
 */
type SessionMirror = {
  user_id: string;
  session_id: string;
  session: unknown;
  updated_at: string;
  local_ids?: string[];
};
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
export type ReadModelKind = "dashboard" | "e1rm" | "volume" | "completion" | "history-session";
export type ReadModelMirror = {
  user_id: string;
  cache_key: string;
  kind: ReadModelKind;
  data: unknown;
  request_started_at: number;
  synced_at: string;
};

class SessionDatabase extends Dexie {
  drafts!: Table<StoredDraft, unknown>;
  outbox!: Table<OutboxMutation, string>;
  sessions!: Table<SessionMirror, unknown>;
  catalogs!: Table<CatalogMirror, string>;
  routines!: Table<RoutineSnapshot, unknown>;
  syncMeta!: Table<SyncMeta, unknown>;
  conflicts!: Table<ConflictAudit, number>;
  leases!: Table<Lease, unknown>;
  readModels!: Table<ReadModelMirror, unknown>;

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
    this.version(3).stores({
      readModels: "[user_id+cache_key], [user_id+kind], [user_id+synced_at]",
    });
    /**
     * v4 — **새 store 를 만들지 않는다.** 스키마는 그대로 두고 데이터만 무효화한다.
     *
     * `.stores({})` 를 함께 부르는 이유: 스키마 선언 없이 `upgrade` 만 단 버전은
     * v3 에서 곧장 올라온 클라이언트에서 건너뛸 수 있다. 빈 선언이라도 있어야
     * Dexie 가 이 버전을 실제 upgrade 단계로 취급한다(test/assistance-dexie-v4 skipped-hook).
     */
    this.version(4)
      .stores({})
      .upgrade(async (tx) => {
        await invalidateStaleAssistanceMirrors(tx);
      });
  }
}

export const sessionDb = new SessionDatabase();

/** `syncMeta` marker 값. 이 키가 있으면 authoritative refetch 전에는 렌더하지 않는다. */
export const REMEDIATION_PENDING = "pending_refetch";

/**
 * **completion 이 소유한 대기 상태.** 세션 종료가 서버에 적용됐지만 그 세션의 performed-set outbox 가
 * 아직 남아 drain 을 못 끝낸 상태다. 새 store 를 만들지 않고 **같은 `syncMeta` 키의 값**으로 구분한다.
 *
 * 일반 `pending_refetch` 와 반드시 구분해야 한다 — 구분하지 않으면 그 사이의 일반 refetch 가
 * safe 200 하나로 marker 를 지워 **cleanup 이 영영 다시 시도되지 않는다**(독립 재리뷰 P1).
 */
export const COMPLETION_DRAIN_PENDING = "pending_completion_drain";

export const MARKER_PREFIX = "assistance-remediation:";

export function markerKeyFor(sessionId: string): string {
  return `${MARKER_PREFIX}${sessionId}`;
}

/** marker 값의 **exact 허용집합**. 모르는 값은 `unknown` 이고, 그건 안전이 아니라 fail closed 다. */
export type RemediationState = "none" | "refetch" | "completion" | "unknown";

export function remediationStateOf(value: string | undefined): RemediationState {
  if (value === undefined) return "none";
  if (value === REMEDIATION_PENDING) return "refetch";
  if (value === COMPLETION_DRAIN_PENDING) return "completion";
  return "unknown";
}

export async function remediationStateFor(
  userId: string,
  sessionId: string,
): Promise<RemediationState> {
  return remediationStateOf(
    (await sessionDb.syncMeta.get([userId, markerKeyFor(sessionId)]))?.value,
  );
}

/**
 * **세션이 사라진 경우만 terminal 이다.** authenticated 404/410 은 그 세션이 더 없다는 뜻이라
 * marker 를 남겨 두면 영영 고아가 된다. 401·5xx·오프라인은 terminal 이 아니다 —
 * 인증이 끊기거나 서버가 잠깐 죽은 것을 "안전해졌다"로 읽으면 그게 fail open 이다.
 */
function isTerminalStatus(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 410;
}

/**
 * pending marker 를 하나씩 authoritative 로 다시 받아온다.
 * **`GET` 성공이 아니라 safe predicate 통과와 원자 commit 이 해제 조건**이다.
 *
 * `fetchSession` 을 주입받는 이유: 이 모듈은 네트워크를 모른다(sync coordinator 가 `api.session` 을 넘긴다).
 */
export async function processRemediationMarkers(
  userId: string,
  fetchSession: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  const rows = await sessionDb.syncMeta.where("user_id").equals(userId).toArray();
  // **일반 refetch 는 `refetch` 상태만 건드린다.** completion 이 소유한 후보는 drain 이 끝나기 전에
  // marker 를 해제하거나 미러를 확정하면 안 되고, unknown 은 손대지 않는다(fail closed).
  const pending = rows.filter(
    (row) => row.key.startsWith(MARKER_PREFIX) && remediationStateOf(row.value) === "refetch",
  );
  for (const row of pending) {
    const sessionId = row.key.slice(MARKER_PREFIX.length);
    try {
      // 안전하지 않으면 `commitAuthoritativeSession` 이 false 를 주고 marker 는 그대로 남는다.
      await commitAuthoritativeSession(userId, sessionId, await fetchSession(sessionId));
    } catch (error) {
      // 서버에서 사라진 세션이면 **캐시까지 함께** 지운다 — marker 만 지우면 남은 미러가 폴백으로 돌아온다.
      if (isTerminalStatus(error)) await cleanupSessionCache(userId, sessionId);
      // 그 밖의 실패(오프라인·5xx·401)는 marker 를 유지한다 — 다음 기회에 다시 시도한다.
    }
  }
}

/**
 * openapi `PlannedSet.load_kind` 의 **exact 허용집합**이다. required 필드라 빠질 수 없고,
 * 모르는 값(오타·미래 값)을 "assistance 가 아니니 괜찮다"로 넘기면 그게 곧 fail open 이다.
 */
const LOAD_KINDS = new Set(["external", "bodyweight", "assistance", "not_applicable"]);

/**
 * 세션 payload 의 계획 행. **구조가 계약과 다르면 `null`** 이다 —
 * `planned_sets` 가 없거나 배열이 아닐 때 빈 배열로 넘기면 `every()` 가 true 가 되어
 * malformed payload 가 통째로 "안전"이 된다.
 */
function plannedRowsOf(session: unknown): Record<string, unknown>[] | null {
  if (typeof session !== "object" || session === null) return null;
  const sets = (session as { planned_sets?: unknown }).planned_sets;
  if (!Array.isArray(sets)) return null;
  if (!sets.every((row) => typeof row === "object" && row !== null && !Array.isArray(row)))
    return null;
  return sets as Record<string, unknown>[];
}

/**
 * 한 행이 렌더·캐시해도 되는 행인가.
 *
 * **판정 권위는 서버의 `assistance_safety_status` 하나다.** 클라이언트가 다시 계산하지 않는다 —
 * 서버는 표시 게이트를 적용하기 **전의 raw 행**으로 판정하는데, 클라이언트가 보는 wire 값은
 * 이미 게이트를 지나 `recommendation_state`·`reason_code`·`recommended_weight` 가 null 이다.
 * 그 값으로 재계산하면 **정상 세션이 전부 unsafe 로 뒤집힌다**(실측: E2E 45건).
 *
 * `load_kind` 는 게이트되지 않는 구조 축이라 그대로 믿는다.
 */
/**
 * **로컬이 만든 임시 행의 허용 shape.** 오프라인 편집이 살아 있으려면 이 행이 통과해야 하지만,
 * 클라이언트는 카탈로그로 어시스트 여부를 알 수 없어(wire `Exercise` 에 `load_semantics` 가 없다)
 * **어떤 처방도 주장할 수 없다.** 그래서 무게 하나만 보지 않고 처방 축 전체를 검사한다 —
 * weight 만 보면 reason/state 가 모순인 행이 통과한다.
 */
function isLocalBaselineRow(row: Record<string, unknown>): boolean {
  if (typeof row.id !== "string" || row.id === "") return false;
  if (typeof row.exercise_id !== "string" || row.exercise_id === "") return false;
  if (!Number.isInteger(row.set_no) || (row.set_no as number) < 1) return false;
  const weight = row.recommended_weight;
  if (!(weight === null || weight === 0)) return false;
  // 로컬은 처방 축을 만들지 않는다: 안전 상태·action·verdict·load_kind 를 주장하면 그 자체가 위반이다.
  if (row.recommendation_state != null) return false;
  if (row.recommended_action != null) return false;
  if (row.assistance_safety_status != null) return false;
  if (row.assistance_provenance != null) return false;
  if (row.load_kind != null) return false;
  return row.reason_code === "BASELINE" || row.reason_code == null;
}

export function isSafeRow(row: Record<string, unknown>, localIds?: ReadonlySet<string>): boolean {
  // **출처는 payload 가 주장하지 못한다.** 로컬 여부는 호출 context(local envelope)만 결정한다 —
  // 행에 담긴 `provisional: true` 를 믿으면 server/unknown payload 가 그 한 줄로
  // required `load_kind`·raw verdict·구조 검사를 전부 우회한다(독립 재리뷰 P2-1).
  if (localIds !== undefined && typeof row.id === "string" && localIds.has(row.id))
    return isLocalBaselineRow(row);
  // 서버 행은 `load_kind` 가 required 다. exact whitelist 밖이면 전부 거절이다 —
  // 없음·null·오타·미래 값을 "assistance 가 아니니 통과"로 두면 그게 fail open 이다.
  if (typeof row.load_kind !== "string" || !LOAD_KINDS.has(row.load_kind)) return false;
  // 어시스트가 아닌 행에는 이 축이 없다(서버가 null 을 준다).
  if (row.load_kind !== "assistance") return true;
  // 어시스트 행은 **정확히 `safe`** 여야 한다. `unsafe`·없음·null·모르는 값은 전부 거절이다.
  return row.assistance_safety_status === "safe";
}

/**
 * payload 를 그대로 렌더·저장해도 되는가.
 * 어시스트 행이 하나도 없으면 safe 다 — 다른 종목까지 무효화하지 않는다.
 *
 * `localIds` 는 **이 호출이 로컬 생성분임을 아는 쪽**만 넘긴다. 서버 응답 경로는 넘기지 않으므로
 * 서버가 보낸 어떤 행도 로컬 규칙으로 빠져나갈 수 없다.
 */
export function isSafeSessionPayload(session: unknown, localIds?: ReadonlySet<string>): boolean {
  const rows = plannedRowsOf(session);
  return rows !== null && rows.every((row) => isSafeRow(row, localIds));
}

/** sync 가 돌려준 매핑 중 **화면·미러에 써도 되는 것만** 남긴다. */
export function safeMappings<T extends { planned_set?: unknown }>(mappings: T[]): T[] {
  return mappings.filter((mapping) => {
    const planned = mapping.planned_set;
    if (typeof planned !== "object" || planned === null || Array.isArray(planned)) return false;
    return isSafeRow(planned as Record<string, unknown>);
  });
}

/**
 * 이 세션은 authoritative refetch 전까지 신뢰할 수 없다고 표시한다.
 *
 * **marker 를 못 쓰면 조용히 넘어가면 안 된다.** marker 가 없으면 `isRemediationPending()` 이
 * false 를 주고, 다음 오프라인 읽기가 **남아 있던 stale 미러를 그대로 반환**한다 —
 * fail-closed 설계가 quota/IDB 쓰기 실패 한 번으로 무너진다(독립 재리뷰 P1-3).
 *
 * 그래서 marker 를 남기지 못하면 **그 세션 미러를 지워** 폴백 자체를 없애고,
 * 그것마저 실패하면 오류를 전파한다. `drafts`·`outbox` 는 어느 경로에서도 건드리지 않는다.
 */
export async function markRemediationPending(userId: string, sessionId: string): Promise<void> {
  try {
    await sessionDb.syncMeta.put({
      user_id: userId,
      key: markerKeyFor(sessionId),
      value: REMEDIATION_PENDING,
    });
  } catch (markerError) {
    // 순서가 중요하다: **먼저 폴백 원천을 제거**하고 그다음 오류를 알린다.
    await sessionDb.sessions.delete([userId, sessionId]);
    throw markerError;
  }
}

export type MirrorKey = { user_id: string; session_id: string };

/** 무효화 대상 세션. 사용자 scope 를 유지한 채 돌려준다. */
export async function scanStaleAssistanceSessions(
  db: Pick<SessionDatabase, "sessions">,
): Promise<MirrorKey[]> {
  const affected: MirrorKey[] = [];
  await db.sessions.each((row) => {
    // 저장된 봉투로 로컬 행을 식별한다 — payload 의 주장이 아니라 우리가 남긴 기록이다.
    if (!isSafeSessionPayload(row.session, new Set(row.local_ids ?? [])))
      affected.push({ user_id: row.user_id, session_id: row.session_id });
  });
  return affected;
}

/**
 * v4 upgrade 본체. **지우는 것은 `sessions`·`routines`·`readModels` 세 store 뿐이다.**
 * `drafts` 와 `outbox` 는 열지도 않는다 — 실수로도 건드릴 수 없게 트랜잭션 밖에 둔다.
 */
export async function invalidateStaleAssistanceMirrors(tx: Transaction): Promise<void> {
  const sessions = tx.table("sessions") as unknown as SessionDatabase["sessions"];
  const routines = tx.table("routines") as unknown as SessionDatabase["routines"];
  const readModels = tx.table("readModels") as unknown as SessionDatabase["readModels"];
  const syncMeta = tx.table("syncMeta") as unknown as SessionDatabase["syncMeta"];

  const affected = await scanStaleAssistanceSessions({ sessions });
  for (const key of affected) {
    const pair = [key.user_id, key.session_id] as [string, string];
    await sessions.delete(pair);
    await routines.delete(pair);
    // 이 세션에서 파생된 read model 만 지운다(대시보드 전체를 비우지 않는다).
    const stale = await readModels
      .where("[user_id+kind]")
      .equals([key.user_id, "history-session"])
      .toArray();
    for (const model of stale) {
      if (model.cache_key.endsWith(`:${key.session_id}`))
        await readModels.delete([model.user_id, model.cache_key]);
    }
    await syncMeta.put({
      user_id: key.user_id,
      key: markerKeyFor(key.session_id),
      value: REMEDIATION_PENDING,
    });
  }
}

/**
 * marker 가 있으면 로컬 미러를 믿지 않는다. **·· 모두 pending 이다** —
 * 모르는 값을 "아마 괜찮겠지"로 넘기면 그게 fail open 이다.
 */
export async function isRemediationPending(userId: string, sessionId: string): Promise<boolean> {
  return (await remediationStateFor(userId, sessionId)) !== "none";
}

/**
 * marker 를 지우는 **다른 하나의 경로**: authenticated 404/410 terminal cleanup.
 * 그 외에는 `commitAuthoritativeSession` 의 predicate 통과로만 지운다.
 */
export async function clearRemediationMarker(userId: string, sessionId: string): Promise<void> {
  await sessionDb.syncMeta.delete([userId, markerKeyFor(sessionId)]);
}

/**
 * **세션 하나의 로컬 캐시를 통째로 정리한다** — `sessions`·`routines`·관련 `readModels`·marker 를
 * 한 트랜잭션에서 함께 지운다.
 *
 * marker 만 지우면 남은 미러가 다시 폴백으로 돌아온다. 서버에서 사라진 세션(404/410)이나
 * 정리가 끝난 세션에서 그 미러를 돌려주면 **없는 세션을 계속 보여주는 것**이다.
 * `drafts`·`outbox` 는 건드리지 않는다 — 사용자의 기록은 이 정리 대상이 아니다.
 */
export async function cleanupSessionCache(userId: string, sessionId: string): Promise<void> {
  await sessionDb.transaction(
    "rw",
    [sessionDb.sessions, sessionDb.routines, sessionDb.readModels, sessionDb.syncMeta],
    async () => {
      const pair = [userId, sessionId] as [string, string];
      await sessionDb.sessions.delete(pair);
      await sessionDb.routines.delete(pair);
      const models = await sessionDb.readModels
        .where("[user_id+kind]")
        .equals([userId, "history-session"])
        .toArray();
      for (const model of models) {
        if (model.cache_key.endsWith(`:${sessionId}`))
          await sessionDb.readModels.delete([model.user_id, model.cache_key]);
      }
      await sessionDb.syncMeta.delete([userId, markerKeyFor(sessionId)]);
    },
  );
}

/**
 * authoritative 응답을 받아 **safe predicate 를 통과한 경우에만** 미러를 쓰고 marker 를 지운다.
 *
 * `GET` 200 만으로 지우면 rolling deploy 중 구버전 서버의 legacy weighted 처방이 그대로 남는다.
 * 미러 쓰기와 marker 해제는 **같은 로컬 트랜잭션**이라 절반만 반영되지 않는다.
 */
export async function commitAuthoritativeSession(
  userId: string,
  sessionId: string,
  session: unknown,
): Promise<boolean> {
  if (!isSafeSessionPayload(session)) return false;
  // completion 후보·unknown 상태에서는 **safe 200 이어도** 미러를 확정하지 않는다 —
  // 서버가 아직 못 받은 기록이 있는데 authoritative 로 굳히면 그 기록이 화면에서 사라진다.
  const state = await remediationStateFor(userId, sessionId);
  if (state === "completion" || state === "unknown") return false;
  await sessionDb.transaction("rw", sessionDb.sessions, sessionDb.syncMeta, async () => {
    await sessionDb.sessions.put({
      user_id: userId,
      session_id: sessionId,
      session,
      updated_at: new Date().toISOString(),
    });
    await sessionDb.syncMeta.delete([userId, markerKeyFor(sessionId)]);
  });
  return true;
}

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

/**
 * **모든 미러 쓰기의 단일 경계다.** 안전하지 않은 payload 는 쓰지 않고 marker 를 세운 뒤 `false` 를 준다.
 *
 * 거절해도 **기존 미러를 지우지는 않는다** — 이미 보고 있던 안전한 화면을 빼앗을 이유가 없다.
 * 대신 marker 가 서므로 다음 읽기가 authoritative refetch 를 강제한다.
 */
export async function mirrorSession(
  userId: string,
  sessionId: string,
  session: unknown,
  localIds?: ReadonlySet<string>,
): Promise<boolean> {
  if (!isSafeSessionPayload(session, localIds)) {
    await markRemediationPending(userId, sessionId);
    return false;
  }
  await sessionDb.sessions.put({
    user_id: userId,
    session_id: sessionId,
    session,
    updated_at: new Date().toISOString(),
    // 로컬 봉투는 **로컬 생성분이 있을 때만** 붙는다. authoritative 응답이 오면 자연히 사라진다.
    ...(localIds && localIds.size > 0 ? { local_ids: [...localIds] } : {}),
  });
  return true;
}

export async function readMirroredSession<T>(userId: string, sessionId: string): Promise<T | null> {
  return ((await sessionDb.sessions.get([userId, sessionId]))?.session as T | undefined) ?? null;
}

/**
 * remediation 대기 중인 세션에서 authoritative 응답이 predicate 를 통과하지 못했다.
 * **화면을 그리는 대신 실패로 만든다** — 방향이 반대인 처방을 보여주는 것보다 낫다.
 */
export class StaleAssistanceSessionError extends Error {
  constructor() {
    super("어시스트 처방을 다시 받아오는 중이다.");
    this.name = "StaleAssistanceSessionError";
  }
}

export async function readThroughSession<T>(
  userId: string,
  sessionId: string,
  fetchSession: () => Promise<T>,
): Promise<T> {
  try {
    const fetched = await fetchSession();
    // **safe predicate 를 통과해야만** 렌더한다. `GET` 200 은 근거가 아니다 —
    // rolling deploy 중 구버전 서버도 200 으로 legacy weighted 처방을 준다.
    if (!isSafeSessionPayload(fetched)) {
      // **marker 경계는 하나뿐이다.** 여기서 `syncMeta.put(...).catch(() => undefined)` 로 따로 쓰면
      // marker 실패가 삼켜지고, 다음 오프라인 읽기가 남아 있던 stale 미러를 그대로 돌려준다
      // (독립 재리뷰 P1-1). `markRemediationPending` 은 실패 시 미러를 지우고 오류를 전파한다.
      await markRemediationPending(userId, sessionId);
      throw new StaleAssistanceSessionError();
    }
    // **캐시 쓰기 실패가 성공한 온라인 읽기를 화면 오류로 바꾸면 안 된다** — 판정과 저장은 다른 축이다.
    await commitAuthoritativeSession(userId, sessionId, fetched).catch(() => undefined);
    return fetched;
  } catch (error) {
    if (error instanceof StaleAssistanceSessionError) throw error;
    // 세션이 사라졌으면(404/410) marker 를 남길 이유가 없다 — 유일한 terminal cleanup 경로다.
    if (isTerminalStatus(error)) {
      await cleanupSessionCache(userId, sessionId).catch(() => undefined);
      throw error;
    }
    // 오프라인·5xx: marker 가 있으면 미러 폴백도 막는다(무효화한 이유가 그대로 살아 있다).
    if (await isRemediationPending(userId, sessionId)) throw error;
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
  /** 이 커밋이 방금 만든 **로컬 임시 행 id**. payload 가 아니라 호출자가 알려준다. */
  localIds?: ReadonlySet<string>,
): Promise<void> {
  let unsafeSnapshot = false;
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
      // **편집 의도(outbox·correlation)는 무조건 남긴다.** 거절되는 것은 처방 미러뿐이다 —
      // 여기서 outbox 를 함께 버리면 사용자가 실제로 한 편집이 사라진다.
      if (session) {
        /**
         * **봉투는 누적된다.** 이번 호출이 만든 id 만 넘기면, 아직 sync 되지 않은 **앞선 오프라인 편집**의
         * 임시 행이 "서버가 `load_kind` 를 빠뜨린 행"으로 오인돼 스냅샷 전체가 unsafe 가 된다 —
         * 두 번째 add/swap 부터 미러가 갱신되지 않고 재진입이 막힌다(독립 재리뷰 P1-3).
         *
         * 그래서 기존 `local_ids` 와 신규 id 를 합친 뒤, **지금 스냅샷에 실제로 남아 있는 id 만** 남긴다
         * (삭제된 종목의 id 를 계속 들고 있으면 봉투가 무한히 커진다).
         */
        const previous = await sessionDb.sessions.get([userId, sessionId]);
        const present = new Set(
          (plannedRowsOf(session) ?? [])
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string"),
        );
        const merged = new Set(
          [...(previous?.local_ids ?? []), ...(localIds ?? [])].filter((id) => present.has(id)),
        );
        if (isSafeSessionPayload(session, merged))
          await sessionDb.sessions.put({
            user_id: userId,
            session_id: sessionId,
            session,
            updated_at: updatedAt,
            ...(merged.size > 0 ? { local_ids: [...merged] } : {}),
          });
        else unsafeSnapshot = true;
      }
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
  // marker 는 트랜잭션 밖에서 세운다 — 편집 커밋 자체를 실패시키지 않는다.
  if (unsafeSnapshot) await markRemediationPending(userId, sessionId);
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
