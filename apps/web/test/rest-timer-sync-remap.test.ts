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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it("correlation 과 서버 id 가 같으면 레코드를 다시 쓰지 않는다", async () => {
    await saveRestTimer(USER, SESSION, SERVER_SET, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    const before = (await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value;
    const writes: string[] = [];
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((async (row: never) => {
      writes.push((row as { key: string }).key);
      return realPut(row);
    }) as never);

    // 서버가 이미 authoritative 인 id 를 그대로 돌려준 경우.
    await runSync(mappingResponse(SERVER_SET));

    expect(writes.filter((key) => key.startsWith("rest-timer:"))).toEqual([]);
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

/**
 * **늦은 저장이 폐기된 correlation id 를 되살리는 경합.**
 *
 * 세트 완료 클릭은 ① 업무 쓰기를 기다리고 ② 그 다음 타이머를 저장한다. 그 사이에 매핑이
 * 커밋되면 트랜잭션은 아직 없는 레코드를 옮길 수 없고, 화면 listener 는 unmount 됐을 수 있다.
 * 그래서 저장 경로가 쓰기 직전에 **별칭**을 해석한다 — 순서와 무관하게 canonical id 만 남는다.
 */
describe("늦은 저장 ↔ 매핑 커밋 경합", () => {
  it("저장이 큐에서 대기하는 사이 매핑이 커밋되면 **서버 id 로 저장된다**", async () => {
    // 앞선 쓰기를 붙잡아 correlation 저장을 큐에 세워 둔다.
    const gate = deferred<void>();
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    let held = false;
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((async (row: never) => {
      const key = (row as { key: string }).key;
      if (!held && key.startsWith("rest-timer:")) {
        held = true;
        await gate.promise;
      }
      return realPut(row);
    }) as never);

    const blocker = saveRestTimer(USER, SESSION, "blocker", TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    // 사용자가 correlation 세트를 끝내 저장을 큐에 넣는다(아직 실행되지 않는다).
    const queued = saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    // 화면 없이 sync 가 매핑을 커밋한다.
    await runSync(mappingResponse());

    gate.resolve();
    await Promise.all([blocker, queued]);

    const saved = await loadRestTimer(USER, SESSION, Date.now());
    expect(saved!.plannedSetId).toBe(SERVER_SET);
    // 폐기된 correlation id 가 durable row 로 남지 않는다.
    expect((await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]))!.value).not.toContain(
      CORRELATION,
    );
  });

  it("매핑 **뒤에** 시작한 저장도 서버 id 를 쓴다", async () => {
    await runSync(mappingResponse());

    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(SERVER_SET);
  });

  it("**롤백되면 별칭도 열리지 않는다** — 다음 sync 가 다시 옮길 수 있어야 한다", async () => {
    await expect(
      runSync(mappingResponse(), {
        duringMappingCommit: () => Promise.reject(new Error("commit failed")),
      }),
    ).rejects.toThrow();

    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(CORRELATION);
  });

  it("매핑과 무관한 세트의 저장은 그대로 제 id 를 쓴다", async () => {
    await runSync(mappingResponse());

    await saveRestTimer(USER, OTHER_SESSION, "unrelated", TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    expect((await loadRestTimer(USER, OTHER_SESSION, Date.now()))!.plannedSetId).toBe("unrelated");
  });

  it("같은 매핑이 두 번 와도 결과가 같다", async () => {
    await runSync(mappingResponse());
    await runSync(mappingResponse());

    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(SERVER_SET);
  });
});

/**
 * **리뷰가 지목한 정확한 순서.** 매핑 트랜잭션이 *열린 뒤* 저장이 옛 id 를 해석하고 put 을
 * 요청한다. 메모리 별칭으로는 이 창을 못 덮었다 — 별칭은 커밋 뒤에 열리는데 레코드는 이미
 * 옛 id 로 확정돼 있었다. durable 별칭 + 같은 트랜잭션 조회가 두 순서를 모두 덮는다.
 */
describe("durable 별칭 — 트랜잭션 순서", () => {
  const aliasKey = `rest-timer-alias:${CORRELATION}`;
  const durableRow = () => sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)]);

  it("**매핑 tx 를 연 채 저장을 시작**해도 최종 행은 서버 id 다", async () => {
    const hold = deferred<void>();
    const saving: Promise<boolean>[] = [];

    // 매핑 트랜잭션 한가운데서 저장을 시작한다. 이 저장의 put 은 매핑 뒤에 줄을 선다.
    await runSync(mappingResponse(), {
      duringMappingCommit: () => {
        saving.push(
          saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
            totalSec: 90,
            endsAt: Date.now() + 60_000,
          }),
        );
        hold.resolve();
        return hold.promise;
      },
    });
    await Promise.all(saving);

    const row = await durableRow();
    expect(row).toBeDefined();
    // durable 행에 폐기된 correlation 문자열이 남으면 안 된다.
    expect(row!.value).not.toContain(CORRELATION);
    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(SERVER_SET);
  });

  it("**다른 Dexie 인스턴스**에서 저장해도 별칭을 읽는다 — 메모리 fence 없이 성립", async () => {
    await runSync(mappingResponse());

    // 별칭이 durable 하므로 새 연결도 같은 답을 얻는다.
    sessionDb.close();
    await sessionDb.open();

    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(SERVER_SET);
  });

  it("별칭은 커밋 트랜잭션에 함께 쓰인다", async () => {
    await runSync(mappingResponse());

    const alias = await sessionDb.syncMeta.get([USER, aliasKey]);
    expect(alias).toBeDefined();
    expect(JSON.parse(alias!.value)).toMatchObject({ v: 1, to: SERVER_SET });
  });

  it("**롤백되면 별칭도 없다**", async () => {
    await expect(
      runSync(mappingResponse(), {
        duringMappingCommit: () => Promise.reject(new Error("commit failed")),
      }),
    ).rejects.toThrow();

    expect(await sessionDb.syncMeta.get([USER, aliasKey])).toBeUndefined();
  });

  it("손상·모르는 버전 별칭은 무시한다 — 원래 id 를 쓴다(fail-closed)", async () => {
    await sessionDb.syncMeta.put({ user_id: USER, key: aliasKey, value: "not json" });
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(CORRELATION);

    await sessionDb.syncMeta.put({
      user_id: USER,
      key: aliasKey,
      value: JSON.stringify({ v: 99, to: SERVER_SET, at: Date.now() }),
    });
    await saveRestTimer(USER, SESSION, CORRELATION, TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    expect((await loadRestTimer(USER, SESSION, Date.now()))!.plannedSetId).toBe(CORRELATION);
  });

  it("**순환은 방문 집합이 잡는다** — 홉 상한에 기대지 않는다", async () => {
    const now = Date.now();
    // a→b→a 순환. 방문 집합이 없으면 상한(8회)까지 돌아 짝수 홉이라 'a' 로 끝난다.
    // 방문 집합이 있으면 두 번째 홉에서 멈춰 'b' 로 끝난다 — 그 차이를 못박는다.
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: "rest-timer-alias:a",
      value: JSON.stringify({ v: 1, to: "b", at: now }),
    });
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: "rest-timer-alias:b",
      value: JSON.stringify({ v: 1, to: "a", at: now }),
    });

    await saveRestTimer(USER, SESSION, "a", TITLE, { totalSec: 90, endsAt: now + 60_000 }, now);

    expect((await loadRestTimer(USER, SESSION, now))!.plannedSetId).toBe("b");
  });

  it("별칭 순환이 있어도 멈추고 결정론적으로 끝난다", async () => {
    const now = Date.now();
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: `rest-timer-alias:a`,
      value: JSON.stringify({ v: 1, to: "b", at: now }),
    });
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: `rest-timer-alias:b`,
      value: JSON.stringify({ v: 1, to: "a", at: now }),
    });

    // 저장 시각을 명시한다 — 기본값(Date.now())을 쓰면 아래 load 의 now 보다 미래가 되어
    // future 가드에 걸린다(관용 0). 그건 계약이 맞고 fixture 가 틀린 것이다.
    await saveRestTimer(USER, SESSION, "a", TITLE, { totalSec: 90, endsAt: now + 60_000 }, now);

    expect(["a", "b"]).toContain((await loadRestTimer(USER, SESSION, now))!.plannedSetId);
  });

  it("보존 기간이 지난 별칭은 다음 매핑에서 정리된다", async () => {
    const stale = Date.now() - 11 * 60 * 1000;
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: `rest-timer-alias:old`,
      value: JSON.stringify({ v: 1, to: "server-old", at: stale }),
    });

    await runSync(mappingResponse());

    expect(await sessionDb.syncMeta.get([USER, `rest-timer-alias:old`])).toBeUndefined();
    // 방금 쓴 별칭은 남는다.
    expect(await sessionDb.syncMeta.get([USER, aliasKey])).toBeDefined();
  });

  it("F-4b marker 와 타이머 레코드는 별칭 정리에 영향받지 않는다", async () => {
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: `assistance-remediation:${SESSION}`,
      value: "pending_refetch",
    });
    await saveRestTimer(USER, OTHER_SESSION, "keep", TITLE, {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    await runSync(mappingResponse());

    expect((await sessionDb.syncMeta.get([USER, `assistance-remediation:${SESSION}`]))!.value).toBe(
      "pending_refetch",
    );
    expect((await loadRestTimer(USER, OTHER_SESSION, Date.now()))!.plannedSetId).toBe("keep");
  });
});
