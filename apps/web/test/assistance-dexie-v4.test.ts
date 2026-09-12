/**
 * F-4b — Dexie v4 무효화 + authoritative refetch.
 *
 * **낡은 미러가 `.08.1` 어시스트 처방을 그대로 보여주면 방향이 정반대다** — 숫자는 "기계가 덜어주는 kg"
 * 인데 문구는 "증량"이라, 사용자가 도움을 부하로 읽는다. 그래서 v4 는 영향 세션의 미러만 지우고
 * authoritative refetch 를 강제한다.
 *
 * **절대 건드리면 안 되는 것은 `drafts` 와 `outbox`** 다. 작성 중이던 입력과 미전송 큐가 날아가면
 * 사용자가 실제로 한 운동이 사라진다. 그래서 byte 단위로 같은지 본다.
 */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEV_USER_SCOPE,
  REMEDIATION_PENDING,
  clearRemediationMarker,
  commitAuthoritativeSession,
  invalidateStaleAssistanceMirrors,
  isRemediationPending,
  markerKeyFor,
  readThroughSession,
  StaleAssistanceSessionError,
  scanStaleAssistanceSessions,
  sessionDb,
} from "../components/session/session-db";

/**
 * **v3 스키마 그대로의 클라이언트**를 만든다. 여기에 데이터를 심고 닫은 뒤 v4 를 열어야
 * 진짜 upgrade 경로를 밟는다 — 처음부터 v4 로 열면 hook 은 빈 DB 위에서 돌고
 * 그 fixture 는 아무것도 검증하지 못한다(처음에 이렇게 썼다가 통과해 버렸다).
 */
async function withV3Client(seed: (db: Dexie) => Promise<void>): Promise<void> {
  const legacy = new Dexie("afc-session-v1");
  legacy.version(1).stores({
    drafts: "[user_id+session_id+planned_set_id], user_id, session_id, planned_set_id",
    outbox: "client_id, user_id, [user_id+entity_id], [user_id+updated_at]",
    sessions: "[user_id+session_id], user_id, session_id",
    routines: "[user_id+session_id], user_id, session_id",
    syncMeta: "[user_id+key], user_id",
    conflicts: "++id, user_id, client_id",
    leases: "[user_id+name], user_id",
  });
  legacy.version(2).stores({ catalogs: "user_id" });
  legacy.version(3).stores({
    readModels: "[user_id+cache_key], [user_id+kind], [user_id+synced_at]",
  });
  await legacy.open();
  expect(legacy.verno).toBe(3);
  await seed(legacy);
  legacy.close();
}

const USER = DEV_USER_SCOPE;
const OTHER_USER = "other-user";

/** F-4a 이후 서버가 주는 안전한 어시스트 행. */
function safeAssistedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ps-1",
    exercise_id: "e_assisted_pullup",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 12,
    target_rir: 2,
    rest_sec: 90,
    recommended_weight: 20,
    recommended_reps: 8,
    reason_code: "ASSISTANCE_DOWN_REP_TARGET_MET",
    confidence: 0.85,
    rules_version: "2026.08.2",
    load_kind: "assistance",
    recommendation_state: "ready",
    assistance_provenance: "native",
    recommended_action: null,
    assistance_safety_status: "safe",
    recommendation_gate: "ready",
    performed_set: null,
    ...overrides,
  };
}

/** F-4a 이전 서버가 준 미러 — assistance 축 자체가 없다. */
function preContractRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ps-legacy",
    exercise_id: "e_assisted_pullup",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 12,
    target_rir: 2,
    rest_sec: 90,
    recommended_weight: 20,
    recommended_reps: 8,
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    confidence: 0.85,
    rules_version: "2026.08.1",
    recommendation_gate: "ready",
    performed_set: null,
    ...overrides,
  };
}

function nonAssistedRow(overrides: Record<string, unknown> = {}) {
  return {
    ...safeAssistedRow(),
    id: "ps-plain",
    exercise_id: "e_bench_press",
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    rules_version: "2026.08.1",
    load_kind: "external",
    assistance_provenance: null,
    assistance_safety_status: null,
    ...overrides,
  };
}

function sessionPayload(id: string, plannedSets: unknown[]) {
  return { id, status: "scheduled", scheduled_date: "2026-08-14", planned_sets: plannedSets };
}

async function seedMirror(sessionId: string, plannedSets: unknown[], userId = USER) {
  await sessionDb.sessions.put({
    user_id: userId,
    session_id: sessionId,
    session: sessionPayload(sessionId, plannedSets),
    updated_at: "2026-08-13T00:00:00.000Z",
  });
  await sessionDb.routines.put({
    user_id: userId,
    session_id: sessionId,
    exercise_ids: ["e_assisted_pullup"],
    correlations: [],
    updated_at: "2026-08-13T00:00:00.000Z",
  });
  await sessionDb.readModels.put({
    user_id: userId,
    cache_key: `history-session:${sessionId}`,
    kind: "history-session",
    data: { session_id: sessionId },
    request_started_at: 0,
    synced_at: "2026-08-13T00:00:00.000Z",
  });
}

const DRAFT = {
  user_id: USER,
  session_id: "s-stale",
  planned_set_id: "ps-1",
  actual_weight: 22.5,
  actual_reps: 10,
  actual_rir: 2,
  actual_time_sec: null,
  pain_score: null,
  completed: true,
  client_id: "00000000-0000-4000-8000-0000000000aa",
  updated_at: "2026-08-13T09:00:00.000Z",
};

const OUTBOX = {
  client_id: "00000000-0000-4000-8000-0000000000bb",
  user_id: USER,
  entity: "performed_set" as const,
  entity_id: "ps-1",
  op: "upsert" as const,
  updated_at: "2026-08-13T09:00:00.000Z",
  payload: { actual_weight: 22.5, actual_reps: 10, actual_rir: 2, completed: true },
  attempts: 0,
};

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

describe("v4 스캔 — 영향 세션 식별", () => {
  it("legacy weighted 어시스트 행이 있는 세션을 찾는다", async () => {
    // F-4a 서버가 이 행을 raw 로 판정하면 **반드시 `unsafe`** 다. verdict 를 `safe` 로 둔 채
    // legacy 필드만 심으면 **서버가 절대 만들지 않는 payload** 라 fixture 가 거짓이 된다.
    await seedMirror("s-stale", [
      safeAssistedRow({
        rules_version: "2026.08.1",
        reason_code: "WEIGHT_UP_REP_TARGET_MET",
        assistance_provenance: null,
        assistance_safety_status: "unsafe",
      }),
    ]);

    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([
      { user_id: USER, session_id: "s-stale" },
    ]);
  });

  it("assistance 축이 아예 없는 구버전 미러도 영향 세션이다 — 증명할 수 없으면 안전하지 않다", async () => {
    await seedMirror("s-pre", [preContractRow()]);

    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([
      { user_id: USER, session_id: "s-pre" },
    ]);
  });

  it("F-4a 이후의 안전한 어시스트 세션은 건드리지 않는다", async () => {
    await seedMirror("s-safe", [safeAssistedRow()]);

    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([]);
  });

  it("어시스트가 없는 `.08.1` 세션은 영향받지 않는다 — 전면 무효화가 아니다", async () => {
    await seedMirror("s-plain", [nonAssistedRow()]);

    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([]);
  });

  it("이미 수행된 legacy 행은 `.08.1` 이어도 안전하다 — 사실은 버전을 올릴 수 없다", async () => {
    await seedMirror("s-performed", [
      safeAssistedRow({
        rules_version: "2026.08.1",
        assistance_provenance: "legacy_performed",
        performed_set: { actual_weight: 20, actual_reps: 12, completed: true },
      }),
    ]);

    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([]);
  });
});

describe("v3 → v4 upgrade — 삭제 범위와 보존", () => {
  /** v3 에 데이터를 심고 v4 를 연다. skipped-hook fixture 이기도 하다. */
  async function upgradeFromV3(seed: (db: Dexie) => Promise<void>): Promise<void> {
    await sessionDb.delete();
    await withV3Client(seed);
    await sessionDb.open();
    // hook 을 건너뛰면 여기서 v3 로 남는다.
    expect(sessionDb.verno).toBe(4);
  }

  async function seedLegacy(db: Dexie, rows: { id: string; sets: unknown[]; user?: string }[]) {
    await db.table("drafts").put(DRAFT);
    await db.table("outbox").put(OUTBOX);
    for (const row of rows) {
      const user = row.user ?? USER;
      await db.table("sessions").put({
        user_id: user,
        session_id: row.id,
        session: sessionPayload(row.id, row.sets),
        updated_at: "2026-08-13T00:00:00.000Z",
      });
      await db.table("routines").put({
        user_id: user,
        session_id: row.id,
        exercise_ids: ["e_assisted_pullup"],
        correlations: [],
        updated_at: "2026-08-13T00:00:00.000Z",
      });
      await db.table("readModels").put({
        user_id: user,
        cache_key: `history-session:${row.id}`,
        kind: "history-session",
        data: { session_id: row.id },
        request_started_at: 0,
        synced_at: "2026-08-13T00:00:00.000Z",
      });
    }
  }

  it("영향 세션의 sessions·routines·readModels 만 지우고 marker 를 남긴다", async () => {
    await upgradeFromV3((db) =>
      seedLegacy(db, [
        { id: "s-stale", sets: [preContractRow()] },
        { id: "s-safe", sets: [safeAssistedRow()] },
      ]),
    );

    expect(await sessionDb.sessions.get([USER, "s-stale"])).toBeUndefined();
    expect(await sessionDb.routines.get([USER, "s-stale"])).toBeUndefined();
    expect(await sessionDb.readModels.get([USER, "history-session:s-stale"])).toBeUndefined();
    // 안전한 세션은 그대로 남는다 — 전면 무효화가 아니다.
    expect(await sessionDb.sessions.get([USER, "s-safe"])).toBeDefined();
    expect(await sessionDb.routines.get([USER, "s-safe"])).toBeDefined();
    expect(await sessionDb.readModels.get([USER, "history-session:s-safe"])).toBeDefined();

    expect(await isRemediationPending(USER, "s-stale")).toBe(true);
    expect(await isRemediationPending(USER, "s-safe")).toBe(false);
  });

  it("drafts 와 outbox 는 byte 단위로 동일하다", async () => {
    const before = { drafts: "", outbox: "" };
    await upgradeFromV3(async (db) => {
      await seedLegacy(db, [{ id: "s-stale", sets: [preContractRow()] }]);
      before.drafts = JSON.stringify(await db.table("drafts").toArray());
      before.outbox = JSON.stringify(await db.table("outbox").toArray());
    });

    expect(JSON.stringify(await sessionDb.drafts.toArray())).toBe(before.drafts);
    expect(JSON.stringify(await sessionDb.outbox.toArray())).toBe(before.outbox);
    // 비공허성: 실제로 보존할 행이 있었다.
    expect(await sessionDb.drafts.count()).toBe(1);
    expect(await sessionDb.outbox.count()).toBe(1);
  });

  it("다른 사용자의 미러도 각자 scope 로 처리된다", async () => {
    await upgradeFromV3((db) =>
      seedLegacy(db, [{ id: "s-stale", sets: [preContractRow()], user: OTHER_USER }]),
    );

    expect(await sessionDb.sessions.get([OTHER_USER, "s-stale"])).toBeUndefined();
    expect(await isRemediationPending(OTHER_USER, "s-stale")).toBe(true);
  });

  it("hook 을 한 번 더 돌려도 상태가 그대로다 — idempotent", async () => {
    await upgradeFromV3((db) =>
      seedLegacy(db, [
        { id: "s-stale", sets: [preContractRow()] },
        { id: "s-safe", sets: [safeAssistedRow()] },
      ]),
    );
    const after = () =>
      sessionDb.transaction(
        "r",
        [sessionDb.drafts, sessionDb.outbox, sessionDb.sessions, sessionDb.syncMeta],
        async () =>
          JSON.stringify({
            drafts: await sessionDb.drafts.toArray(),
            outbox: await sessionDb.outbox.toArray(),
            sessions: await sessionDb.sessions.toArray(),
            markers: await sessionDb.syncMeta.toArray(),
          }),
      );
    const first = await after();

    await sessionDb.transaction(
      "rw",
      [sessionDb.sessions, sessionDb.routines, sessionDb.readModels, sessionDb.syncMeta],
      (tx) => invalidateStaleAssistanceMirrors(tx),
    );

    expect(await after()).toBe(first);
  });
});

describe("marker 해제 — 200 이 아니라 safe predicate 통과다", () => {
  beforeEach(async () => {
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: markerKeyFor("s-stale"),
      value: REMEDIATION_PENDING,
    });
  });

  it("safe payload 면 미러를 쓰고 marker 를 지운다", async () => {
    const payload = sessionPayload("s-stale", [safeAssistedRow()]);

    expect(await commitAuthoritativeSession(USER, "s-stale", payload)).toBe(true);
    expect(await sessionDb.sessions.get([USER, "s-stale"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-stale")).toBe(false);
  });

  /**
   * rolling deploy 중 legacy weighted 처방이 200 으로 오는 두 경우를 **서버 세대별로** 나눠 본다.
   * 하나로 뭉치면 어느 쪽이 막혔는지 알 수 없다.
   */
  it.each([
    // 신버전 서버: raw 로 판정해 `unsafe` 를 실어 보낸다.
    ["F-4a 서버가 unsafe 로 표시", { assistance_safety_status: "unsafe" }],
    // 구버전 서버: 축 자체가 없다 → 증명 불가 → fail closed.
    ["F-4a 이전 서버라 축이 없음", { assistance_safety_status: undefined, load_kind: undefined }],
  ])("legacy weighted 처방이 200 으로 와도 저장하지 않는다 — %s", async (_label, overrides) => {
    const row = safeAssistedRow({
      rules_version: "2026.08.1",
      reason_code: "WEIGHT_UP_REP_TARGET_MET",
      assistance_provenance: null,
      ...overrides,
    }) as Record<string, unknown>;
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete row[key];

    expect(
      await commitAuthoritativeSession(USER, "s-stale", sessionPayload("s-stale", [row])),
    ).toBe(false);
    // 저장하면 그대로 화면에 나온다 — 도움 kg 을 부하로 읽는 그 사고다.
    expect(await sessionDb.sessions.get([USER, "s-stale"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-stale")).toBe(true);
  });

  it("거절은 원자적이다 — 미러 쓰기와 marker 해제가 함께 일어난다", async () => {
    const unsafe = sessionPayload("s-stale", [preContractRow()]);
    await commitAuthoritativeSession(USER, "s-stale", unsafe);
    const safe = sessionPayload("s-stale", [safeAssistedRow()]);

    await commitAuthoritativeSession(USER, "s-stale", safe);

    expect(await sessionDb.sessions.get([USER, "s-stale"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-stale")).toBe(false);
  });

  it("terminal cleanup(404/410)은 marker 를 지우는 유일한 다른 경로다", async () => {
    await clearRemediationMarker(USER, "s-stale");
    expect(await isRemediationPending(USER, "s-stale")).toBe(false);
  });

  it("다음 읽기가 authoritative refetch 다 — 통과하면 marker 가 풀리고 화면이 나온다", async () => {
    const payload = sessionPayload("s-stale", [safeAssistedRow()]);

    await expect(readThroughSession(USER, "s-stale", async () => payload)).resolves.toEqual(
      payload,
    );
    expect(await isRemediationPending(USER, "s-stale")).toBe(false);
  });

  it("legacy 응답이면 렌더하지 않고 marker 를 유지한다", async () => {
    const payload = sessionPayload("s-stale", [preContractRow()]);

    await expect(readThroughSession(USER, "s-stale", async () => payload)).rejects.toBeInstanceOf(
      StaleAssistanceSessionError,
    );
    expect(await sessionDb.sessions.get([USER, "s-stale"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-stale")).toBe(true);
  });

  it("오프라인이면 미러 폴백도 막는다 — 무효화한 이유가 그대로 살아 있다", async () => {
    // sync 가 그 사이 미러를 다시 채웠더라도, marker 가 있는 한 그 값을 화면에 쓰지 않는다.
    await seedMirror("s-stale", [preContractRow()]);

    await expect(
      readThroughSession(USER, "s-stale", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("offline");
  });

  it("marker 가 없는 세션은 기존 오프라인 폴백 그대로다 — 회귀 없음", async () => {
    await seedMirror("s-safe", [safeAssistedRow()]);

    await expect(
      readThroughSession(USER, "s-safe", () => Promise.reject(new Error("offline"))),
    ).resolves.toMatchObject({ id: "s-safe" });
  });

  it("로컬 pending outbox 가 있어도 draft·outbox·plannedSetId 는 보존된다", async () => {
    await sessionDb.drafts.put(DRAFT);
    await sessionDb.outbox.put(OUTBOX);
    const draftsBefore = JSON.stringify(await sessionDb.drafts.toArray());
    const outboxBefore = JSON.stringify(await sessionDb.outbox.toArray());

    // 서버는 아직 이 수행 사실을 모른다 → unperformed_remediation 으로 판정되는 payload.
    const payload = sessionPayload("s-stale", [
      safeAssistedRow({
        recommendation_state: "load_calibration_needed",
        recommended_weight: null,
        reason_code: "ASSISTANCE_CALIBRATION_NEEDED",
        assistance_provenance: "remediated",
      }),
    ]);
    expect(await commitAuthoritativeSession(USER, "s-stale", payload)).toBe(true);

    expect(JSON.stringify(await sessionDb.drafts.toArray())).toBe(draftsBefore);
    expect(JSON.stringify(await sessionDb.outbox.toArray())).toBe(outboxBefore);
    expect((await sessionDb.drafts.toArray())[0].planned_set_id).toBe("ps-1");
  });
});

describe("서버 raw verdict 를 fail-closed 로 소비한다", () => {
  it("assistance_safety_status=unsafe 면 로컬 재계산과 무관하게 거절한다", async () => {
    // 로컬 predicate 로는 safe 로 보이는 행이다 — 서버 판정만이 유일한 차이다.
    const payload = sessionPayload("s-verdict", [
      safeAssistedRow({ assistance_safety_status: "unsafe" }),
    ]);

    expect(await commitAuthoritativeSession(USER, "s-verdict", payload)).toBe(false);
    expect(await sessionDb.sessions.get([USER, "s-verdict"])).toBeUndefined();
  });

  it("같은 행이 safe 면 통과한다 — 비공허성", async () => {
    const payload = sessionPayload("s-verdict", [safeAssistedRow()]);
    expect(await commitAuthoritativeSession(USER, "s-verdict", payload)).toBe(true);
  });

  it("unsafe 행이 있는 미러는 v4 스캔이 잡는다", async () => {
    await seedMirror("s-verdict", [safeAssistedRow({ assistance_safety_status: "unsafe" })]);
    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([
      { user_id: USER, session_id: "s-verdict" },
    ]);
  });
});

describe("더 오래된 클라이언트도 hook 을 밟는다", () => {
  it("v1 에서 곧장 올라와도 v4 무효화가 실행된다", async () => {
    await sessionDb.delete();
    // v1 스키마만 아는 클라이언트(readModels·catalogs 조차 없다).
    const ancient = new Dexie("afc-session-v1");
    ancient.version(1).stores({
      drafts: "[user_id+session_id+planned_set_id], user_id, session_id, planned_set_id",
      outbox: "client_id, user_id, [user_id+entity_id], [user_id+updated_at]",
      sessions: "[user_id+session_id], user_id, session_id",
      routines: "[user_id+session_id], user_id, session_id",
      syncMeta: "[user_id+key], user_id",
      conflicts: "++id, user_id, client_id",
      leases: "[user_id+name], user_id",
    });
    await ancient.open();
    expect(ancient.verno).toBe(1);
    await ancient.table("drafts").put(DRAFT);
    await ancient.table("sessions").put({
      user_id: USER,
      session_id: "s-ancient",
      session: sessionPayload("s-ancient", [preContractRow()]),
      updated_at: "2026-08-13T00:00:00.000Z",
    });
    ancient.close();

    await sessionDb.open();

    expect(sessionDb.verno).toBe(4);
    expect(await sessionDb.sessions.get([USER, "s-ancient"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-ancient")).toBe(true);
    // 중간 버전을 건너뛰어도 drafts 는 그대로다.
    expect(await sessionDb.drafts.count()).toBe(1);
  });
});

/**
 * **권위 판정은 서버의 `assistance_safety_status` 다.**
 *
 * D-39 표시 게이트는 완료 3회 전까지 `recommendation_state`·`reason_code`·`recommended_weight` 를
 * null 로 가린다. `load_kind` 는 가리지 않는다. 그래서 **가려진 값으로 verdict 를 재계산하면
 * 정상 세션이 전부 unsafe 로 뒤집힌다** — 실제로 E2E 45건이 이 이유로 깨졌다.
 * 서버는 게이트 **이전의 raw 행**으로 판정하므로 그 결과를 그대로 받는다.
 */
describe("게이트된 payload — 서버 verdict 가 권위다", () => {
  /** no_history·early 게이트가 걸린 어시스트 행. 처방 축은 전부 null 이다. */
  function gatedAssistedRow(overrides: Record<string, unknown> = {}) {
    return safeAssistedRow({
      recommendation_state: null,
      reason_code: null,
      recommended_weight: null,
      recommendation_gate: "no_history",
      assistance_safety_status: "safe",
      ...overrides,
    });
  }

  it.each([["no_history"], ["early"]])("%s 게이트 payload 는 정상 렌더·캐시된다", async (gate) => {
    const payload = sessionPayload("s-gated", [gatedAssistedRow({ recommendation_gate: gate })]);

    expect(await commitAuthoritativeSession(USER, "s-gated", payload)).toBe(true);
    expect(await sessionDb.sessions.get([USER, "s-gated"])).toBeDefined();
  });

  it("게이트된 미러는 v4 무효화 대상이 아니다", async () => {
    await seedMirror("s-gated", [gatedAssistedRow()]);
    expect(await scanStaleAssistanceSessions(sessionDb)).toEqual([]);
  });

  it("게이트된 화면도 읽기 경로를 통과한다", async () => {
    const payload = sessionPayload("s-gated", [gatedAssistedRow()]);
    await expect(readThroughSession(USER, "s-gated", async () => payload)).resolves.toEqual({
      ...payload,
      planned_sets: [{ ...gatedAssistedRow(), recommendation_state: "unavailable" }],
    });
  });

  it.each([
    ["unsafe", "unsafe"],
    ["없음", undefined],
    ["null", null],
    ["모르는 값", "maybe"],
  ])("verdict 가 %s 인 어시스트 행은 계속 차단한다", async (_label, verdict) => {
    const row = gatedAssistedRow();
    if (verdict === undefined) delete (row as Record<string, unknown>).assistance_safety_status;
    else (row as Record<string, unknown>).assistance_safety_status = verdict;

    expect(
      await commitAuthoritativeSession(USER, "s-blocked", sessionPayload("s-blocked", [row])),
    ).toBe(false);
  });

  it("어시스트가 아닌 행은 verdict 가 null 이어도 통과한다 — 이 축과 무관하다", async () => {
    const payload = sessionPayload("s-plain", [nonAssistedRow({ assistance_safety_status: null })]);
    expect(await commitAuthoritativeSession(USER, "s-plain", payload)).toBe(true);
  });
});
