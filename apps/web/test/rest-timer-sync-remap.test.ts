/**
 * **오프라인 세트 id 승격의 durable 경계는 sync 커밋 트랜잭션이다.**
 *
 * 화면 이벤트에 맡기면 안 되는 이유가 실측으로 분명하다 — foreground sync 는 전역
 * `AuthenticatedSync` 에서 돌기 때문에 세션 화면이 없어도 실행된다. 그때 listener 가 없으면
 * 저장된 타이머는 correlation id 에 머물고, 다음 복구가 authoritative 세트 목록과 안 맞는다고
 * 판단해 **타이머를 지운다.** 커밋 직후 탭이 닫혀도 같은 영구 불일치가 남는다.
 *
 * 그래서 여기서는 **실제 `SyncCoordinator` 를 돌린다.** 화면을 렌더하지 않고, 이벤트도 듣지 않는다.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_USER_SCOPE, sessionDb } from "../components/session/session-db";
import { SyncCoordinator } from "../components/session/sync-coordinator";
import {
  loadRestTimer,
  restTimerKeyFor,
  saveRestTimer,
} from "../components/session/rest-timer-store";
import type { SyncResponse } from "../lib/api";

const USER = DEV_USER_SCOPE;
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const OTHER_SESSION = "00000000-0000-4000-8000-0000000000bb";
const CORRELATION = "00000000-0000-4000-8000-0000000000c1";
const SERVER_SET = "00000000-0000-4000-8000-0000000000d1";
const TITLE = "벤치프레스 1세트 후 휴식";

function plannedSet(id: string) {
  return {
    id,
    exercise_id: "e_bench_press",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 10,
    target_rir: 2,
    rest_sec: 90,
    recommended_weight: 60,
    recommended_reps: 9,
    reason_code: "WEIGHT_UP_REP_TARGET_MET",
    confidence: 0.85,
    rules_version: "2026.08.1",
    load_kind: "external",
    recommendation_state: "ready",
    assistance_provenance: null,
    recommended_action: null,
    assistance_safety_status: null,
    recommendation_gate: "ready",
    performed_set: null,
  };
}

const mappingResponse = (correlationId = CORRELATION): SyncResponse =>
  ({
    applied: [],
    conflicts: [],
    changes: [],
    planned_set_mappings: [
      {
        correlation_id: correlationId,
        planned_set_id: SERVER_SET,
        planned_set: plannedSet(SERVER_SET),
      },
    ],
    next_cursor: "v1.cursor",
  }) as unknown as SyncResponse;

/** 사용자의 기록. 승격이 이걸 한 바이트도 건드리면 안 된다. */
async function seedUserData() {
  await sessionDb.drafts.put({
    user_id: USER,
    session_id: SESSION,
    planned_set_id: "keep-me",
    weight: 60,
    reps: 8,
    rir: 2,
    time_sec: null,
    completed: true,
    updated_at: "2026-08-14T08:00:00.000Z",
  } as never);
  await sessionDb.sessions.put({
    user_id: USER,
    session_id: SESSION,
    session: { id: SESSION, status: "in_progress", planned_sets: [] },
    updated_at: "2026-08-14T08:00:00.000Z",
  } as never);
}

const userDataBytes = async () =>
  JSON.stringify([
    await sessionDb.drafts.toArray(),
    await sessionDb.outbox.toArray(),
    await sessionDb.sessions.toArray(),
  ]);

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sessionDb.delete();
});

const runSync = (response: SyncResponse, options: Record<string, unknown> = {}) =>
  new SyncCoordinator({ transport: () => Promise.resolve(response), ...options }).request();

describe("전역 커밋 — 화면이 없어도 승격된다", () => {
  it("SessionScreen 을 렌더하지 않아도 저장된 타이머가 서버 id 로 옮겨간다", async () => {
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    // 화면 없음. 이벤트 listener 도 없다. sync 만 돈다.
    await runSync(mappingResponse());

    const moved = await loadRestTimer(USER, SESSION, Date.now());
    expect(moved).not.toBeNull();
    expect(moved!.plannedSetId).toBe(SERVER_SET);
  });

  it("여러 세션의 타이머를 각자 제 correlation 으로만 옮긴다", async () => {
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    await saveRestTimer(USER, OTHER_SESSION, "other-corr", TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    await runSync(mappingResponse());

    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(SERVER_SET);
    // 매핑에 없는 세트는 그대로다.
    expect((await loadRestTimer(USER, OTHER_SESSION, Date.now()))!.plannedSetId).toBe("other-corr");
  });

  it("매핑 대상이 아닌 타이머는 건드리지 않는다", async () => {
    await saveRestTimer(USER, SESSION, "unrelated-set", TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    const before = (await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value;

    await runSync(mappingResponse());

    expect((await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value).toBe(before);
  });

  it("타이머가 없어도 sync 는 정상 완료한다", async () => {
    await expect(runSync(mappingResponse())).resolves.toBeDefined();
  });

  it("매핑이 없으면 아무것도 하지 않는다", async () => {
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    const before = (await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value;

    await runSync({
      applied: [],
      conflicts: [],
      changes: [],
      planned_set_mappings: [],
      next_cursor: "v1.cursor",
    } as unknown as SyncResponse);

    expect((await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value).toBe(before);
  });
});

describe("전역 커밋 — 트랜잭션 경계", () => {
  it("커밋이 롤백되면 승격도 함께 되돌아간다", async () => {
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    // 매핑 커밋 도중 실패시킨다 — Dexie 가 트랜잭션 전체를 되돌린다.
    await expect(
      runSync(mappingResponse(), {
        duringMappingCommit: () => Promise.reject(new Error("commit failed")),
      }),
    ).rejects.toThrow();

    // 승격이 살아남으면 안 된다. correlation id 그대로여야 다음 sync 가 다시 옮길 수 있다.
    const after = await loadRestTimer(USER, SESSION, Date.now());
    expect(after!.plannedSetId).toBe(CORRELATION);
  });

  it("승격은 `drafts`·`outbox`·`sessions` 를 바꾸지 않는다", async () => {
    await seedUserData();
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    const before = await userDataBytes();

    await runSync(mappingResponse());

    expect(await userDataBytes()).toBe(before);
  });

  it("F-4b marker 네임스페이스를 건드리지 않는다", async () => {
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: `assistance-remediation:${SESSION}`,
      value: "pending_refetch",
    });
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    await runSync(mappingResponse());

    expect((await sessionDb.syncMeta.get([USER, `assistance-remediation:${SESSION}`]))!.value).toBe(
      "pending_refetch",
    );
  });

  it("손상된 타이머 레코드가 있어도 sync 를 깨뜨리지 않는다", async () => {
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: restTimerKeyFor(SESSION),
      value: "not json",
    });

    await expect(runSync(mappingResponse())).resolves.toBeDefined();
    // 손상값은 승격 대상이 아니다 — 그대로 남고 복구 단계가 걸러낸다.
    expect((await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value).toBe(
      "not json",
    );
  });
});
