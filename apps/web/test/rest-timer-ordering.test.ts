/**
 * T2 fixup — **순서**와 **정체성**.
 *
 * 원래 구현은 save/clear 를 전부 fire-and-forget 으로 던졌다. 같은 런타임에서 save 가 느리고
 * clear 가 먼저 커밋되면 **늦게 도착한 save 가 타이머를 되살린다** — 사용자가 닫은 휴식이
 * stale 창(10분) 동안 reload 마다 다시 뜬다. IndexedDB 가 FIFO 일 거라고 가정하면 안 된다.
 *
 * 복구 쪽도 같은 부류다. `useRef(false)` 는 세션을 구분하지 못해서, 한 컴포넌트가 A→B 로
 * 옮겨 가면 B 를 영영 복구하지 않거나 **A 의 타이머를 B 화면에 얹는다.**
 *
 * 그래서 여기서는 **실제 deferred promise 로 Dexie 를 붙잡아** 순서를 강제로 뒤집어 본다.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_USER_SCOPE, sessionDb } from "../components/session/session-db";
import {
  restoreEligibilityOf,
  isRestorable,
  clearRestTimer,
  clearRestTimerForPlannedSet,
  remapRestTimerPlannedSet,
  restTimerKeyFor,
  createRestoreCoordinator,
  loadRestTimer,
  restTimerQueueDepth,
  restoreRestTimer,
  saveRestTimer,
} from "../components/session/rest-timer-store";
import { startRest } from "../lib/rest-timer";

const USER = DEV_USER_SCOPE;
const A = "s-a";
const B = "s-b";
const SET = "ps-1";
const TITLE = "벤치프레스 2세트 후 휴식";
const T0 = 1_700_000_000_000;

/** 손으로 결말을 정하는 promise. 이걸로 Dexie 쓰기를 원하는 지점에 붙잡아 둔다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 마이크로태스크 큐를 비운다 — 직렬화가 실제로 걸렸는지 보려면 필요하다. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P1-1 순서 — 같은 세션의 save/clear 는 호출 순서대로 커밋된다", () => {
  it("느린 save 뒤에 clear 를 부르면 **clear 가 마지막**이다 — 늦은 save 가 되살리지 못한다", async () => {
    const gate = deferred<void>();
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    // **붙잡되 실제로는 쓴다.** 쓰기를 통째로 대체하면 되살릴 것이 없어 경합이 재현되지 않는다.
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementationOnce((async (row: never) => {
      await gate.promise;
      return realPut(row);
    }) as never);

    const saving = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    const clearing = clearRestTimer(USER, A);
    await flush();

    gate.resolve();
    await Promise.all([saving, clearing]);

    // 직렬화가 없으면 clear 가 먼저 지나가고 **늦은 save 가 레코드를 되살린다.**
    expect(await loadRestTimer(USER, A, T0 + 1_000)).toBeNull();
    expect(await sessionDb.syncMeta.count()).toBe(0);
  });

  it("save A → save B → clear 는 그 순서로 **커밋**된다", async () => {
    const committed: string[] = [];
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    const realDelete = sessionDb.syncMeta.delete.bind(sessionDb.syncMeta);
    const gate = deferred<void>();
    let first = true;

    vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((async (row: never) => {
      // 첫 쓰기만 붙잡는다 — 뒤엣것들이 앞지를 기회를 만든다.
      if (first) {
        first = false;
        await gate.promise;
      }
      const result = await realPut(row);
      // **끝난 순서**를 적는다. 부른 순서를 적으면 커밋 역전을 못 본다.
      committed.push(`put:${JSON.parse((row as { value: string }).value).ends_at}`);
      return result;
    }) as never);
    vi.spyOn(sessionDb.syncMeta, "delete").mockImplementation((async (key: never) => {
      const result = await realDelete(key);
      committed.push("delete");
      return result;
    }) as never);

    const ops = [
      saveRestTimer(USER, A, SET, TITLE, { totalSec: 90, endsAt: T0 + 90_000 }, T0),
      saveRestTimer(USER, A, SET, TITLE, { totalSec: 120, endsAt: T0 + 120_000 }, T0),
      clearRestTimer(USER, A),
    ];
    await flush();
    gate.resolve();
    await Promise.all(ops);

    expect(committed).toEqual([`put:${T0 + 90_000}`, `put:${T0 + 120_000}`, "delete"]);
    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("앞 작업이 실패해도 다음 clear 는 반드시 실행된다", async () => {
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementationOnce(
      () => Promise.reject(new Error("QuotaExceeded")) as never,
    );

    const saving = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    const clearing = clearRestTimer(USER, A);

    await expect(saving).resolves.toBe(false);
    // 앞 save 가 실패해도 clear 는 돌았고 성공을 보고한다.
    await expect(clearing).resolves.toBe(true);

    // 실패한 save 가 큐를 막지 않았다 — 그 뒤 정상 저장도 된다.
    vi.restoreAllMocks();
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    expect(await loadRestTimer(USER, A, T0)).not.toBeNull();
  });

  it("clear 가 실패해도 그 다음 clear 는 실행된다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    vi.spyOn(sessionDb.syncMeta, "delete").mockImplementationOnce(
      () => Promise.reject(new Error("TransactionInactive")) as never,
    );

    await clearRestTimer(USER, A);
    await clearRestTimer(USER, A);

    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("다른 세션은 서로를 막지 않는다", async () => {
    const gate = deferred<void>();
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementationOnce((async (row: never) => {
      await gate.promise;
      return realPut(row);
    }) as never);

    const blocked = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    // B 는 A 가 붙잡혀 있어도 제 갈 길을 간다 — 큐는 세션마다 따로다.
    await saveRestTimer(USER, B, SET, TITLE, startRest(60, T0), T0);

    // B 의 읽기도 A 에 막히지 않는다.
    expect(await loadRestTimer(USER, B, T0)).not.toBeNull();
    // A 는 아직 커밋되지 않았다(큐 밖에서 직접 확인 — 같은 세션 읽기는 큐 뒤로 줄을 선다).
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(A)])).toBeUndefined();

    gate.resolve();
    await blocked;
    expect(await loadRestTimer(USER, A, T0)).not.toBeNull();
  });

  it("모든 작업이 끝나면 큐 찌꺼기가 남지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    await saveRestTimer(USER, B, SET, TITLE, startRest(90, T0), T0);
    await clearRestTimer(USER, A);
    await clearRestTimer(USER, B);
    await flush();

    expect(restTimerQueueDepth()).toBe(0);
  });

  it("직렬화가 drafts/outbox/sessions 를 건드리지 않는다", async () => {
    await sessionDb.drafts.put({
      user_id: USER,
      session_id: A,
      planned_set_id: SET,
      completed: true,
    } as never);
    const before = JSON.stringify([
      await sessionDb.drafts.toArray(),
      await sessionDb.outbox.toArray(),
      await sessionDb.sessions.toArray(),
    ]);

    await Promise.all([
      saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0),
      clearRestTimer(USER, A),
      saveRestTimer(USER, A, SET, TITLE, startRest(30, T0), T0),
      clearRestTimer(USER, A),
    ]);

    expect(
      JSON.stringify([
        await sessionDb.drafts.toArray(),
        await sessionDb.outbox.toArray(),
        await sessionDb.sessions.toArray(),
      ]),
    ).toBe(before);
  });
});

describe("P2 stale load vs 새 save — 낡은 판정이 새 타이머를 지우지 못한다", () => {
  it("낡은 레코드를 읽는 도중 저장된 정상 타이머가 살아남는다", async () => {
    // 이미 stale 인 레코드(어제 것)를 심어 둔다. 복구는 이걸 지우려 할 것이다.
    await saveRestTimer(USER, A, SET, TITLE, { totalSec: 90, endsAt: T0 - 86_400_000 }, T0);

    const gate = deferred<void>();
    const realGet = sessionDb.syncMeta.get.bind(sessionDb.syncMeta);
    // 첫 읽기를 붙잡아 둔다 — 판정과 삭제 사이에 새 저장이 끼어들 틈을 만든다.
    vi.spyOn(sessionDb.syncMeta, "get").mockImplementationOnce((async (key: never) => {
      const value = await realGet(key);
      await gate.promise;
      return value;
    }) as never);

    const loading = loadRestTimer(USER, A, T0);
    // 그 사이 사용자가 새 세트를 끝내 정상 타이머를 저장한다.
    const saving = saveRestTimer(USER, A, SET, TITLE, { totalSec: 120, endsAt: T0 + 120_000 }, T0);
    gate.resolve();

    expect(await loading).toBeNull();
    await saving;

    // **새 타이머가 남아 있어야 한다.** 낡은 판정의 삭제가 이걸 지우면 사용자가 방금 시작한
    // 휴식이 사라진다.
    const after = await loadRestTimer(USER, A, T0 + 1_000);
    expect(after).not.toBeNull();
    expect(after!.timer.endsAt).toBe(T0 + 120_000);
  });

  it("손상 레코드도 마찬가지다 — 그 사이 저장된 정상값을 지우지 않는다", async () => {
    await sessionDb.syncMeta.put({ user_id: USER, key: restTimerKeyFor(A), value: "not json" });

    const gate = deferred<void>();
    const realGet = sessionDb.syncMeta.get.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "get").mockImplementationOnce((async (key: never) => {
      const value = await realGet(key);
      await gate.promise;
      return value;
    }) as never);

    const loading = loadRestTimer(USER, A, T0);
    const saving = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    gate.resolve();

    expect(await loading).toBeNull();
    await saving;

    expect(await loadRestTimer(USER, A, T0 + 1_000)).not.toBeNull();
  });
});

describe("P2 완료 취소 — 그 세트만 지운다", () => {
  it("일치하는 세트면 지운다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);

    await clearRestTimerForPlannedSet(USER, A, SET);

    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("다른 세트면 남긴다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);

    await clearRestTimerForPlannedSet(USER, A, "ps-other");

    expect(await loadRestTimer(USER, A, T0)).not.toBeNull();
  });

  it("저장된 것이 없어도 던지지 않는다", async () => {
    await expect(clearRestTimerForPlannedSet(USER, A, SET)).resolves.toBe(true);
  });
});

describe("P1-3 세트 id 승격 — 저장된 타이머도 따라간다", () => {
  it("일치하는 세트를 서버 id 로 옮긴다", async () => {
    await saveRestTimer(USER, A, "corr-1", TITLE, startRest(90, T0), T0);

    await expect(remapRestTimerPlannedSet(USER, A, "corr-1", "server-1")).resolves.toBe(true);

    const moved = await loadRestTimer(USER, A, T0);
    expect(moved!.plannedSetId).toBe("server-1");
    // 나머지는 그대로다.
    expect(moved!.timer).toEqual({ totalSec: 90, endsAt: T0 + 90_000 });
    expect(moved!.title).toBe(TITLE);
  });

  it("다른 세트의 타이머는 건드리지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);

    await expect(remapRestTimerPlannedSet(USER, A, "corr-1", "server-1")).resolves.toBe(false);

    expect((await loadRestTimer(USER, A, T0))!.plannedSetId).toBe(SET);
  });

  it("저장된 것이 없으면 아무 일도 없다", async () => {
    await expect(remapRestTimerPlannedSet(USER, A, "corr-1", "server-1")).resolves.toBe(false);
  });

  it("같은 id 로의 승격은 무시한다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);

    await expect(remapRestTimerPlannedSet(USER, A, SET, SET)).resolves.toBe(false);
  });

  it("승격은 세션 큐 안에서 일어난다 — 앞선 저장 뒤에 적용된다", async () => {
    const gate = deferred<void>();
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementationOnce((async (row: never) => {
      await gate.promise;
      return realPut(row);
    }) as never);

    const saving = saveRestTimer(USER, A, "corr-1", TITLE, startRest(90, T0), T0);
    const remapping = remapRestTimerPlannedSet(USER, A, "corr-1", "server-1");
    gate.resolve();
    await saving;

    // 승격이 저장보다 먼저 돌았다면 읽을 레코드가 없어 false 였을 것이다.
    await expect(remapping).resolves.toBe(true);
    expect((await loadRestTimer(USER, A, T0))!.plannedSetId).toBe("server-1");
  });
});

describe("P1-2 정체성 — 단조 세대로 판정한다", () => {
  it("같은 세션은 한 번만 시작한다", () => {
    const coordinator = createRestoreCoordinator();

    expect(coordinator.begin(A)).not.toBeNull();
    expect(coordinator.begin(A)).toBeNull();
  });

  it("세션이 바뀌면 다시 시작한다 — 영구 skip 하지 않는다", () => {
    const coordinator = createRestoreCoordinator();

    expect(coordinator.begin(A)).not.toBeNull();
    expect(coordinator.begin(B)).not.toBeNull();
  });

  it("A→B→A 재진입에서 **첫 A 표는 되살아나지 않는다**", () => {
    const coordinator = createRestoreCoordinator();

    const firstA = coordinator.begin(A)!;
    coordinator.begin(B);
    const secondA = coordinator.begin(A)!;

    // 세션 문자열만 보면 둘 다 A 라 통과해 버린다. 세대가 그걸 가른다.
    expect(coordinator.isCurrent(firstA)).toBe(false);
    expect(coordinator.isCurrent(secondA)).toBe(true);
    expect(secondA.generation).toBeGreaterThan(firstA.generation);
  });

  it("invalidate 하면 진행 중인 표가 전부 무효다", () => {
    const coordinator = createRestoreCoordinator();
    const token = coordinator.begin(A)!;

    coordinator.invalidate();

    expect(coordinator.isCurrent(token)).toBe(false);
  });

  it("invalidate 뒤에는 같은 세션도 새 표로 다시 시작할 수 있다", () => {
    const coordinator = createRestoreCoordinator();
    const first = coordinator.begin(A)!;
    coordinator.invalidate();

    const second = coordinator.begin(A);

    expect(second).not.toBeNull();
    expect(coordinator.isCurrent(second!)).toBe(true);
    expect(coordinator.isCurrent(first)).toBe(false);
  });

  it("세대는 되돌아가지 않는다", () => {
    const coordinator = createRestoreCoordinator();
    const seen: number[] = [];

    for (const id of [A, B, A, B]) seen.push(coordinator.begin(id)!.generation);
    coordinator.invalidate();
    seen.push(coordinator.begin(A)!.generation);

    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("P1-2 stale async — 늦게 온 A 의 결과를 B 화면에 얹지 않는다", () => {
  /** 진행 중 세션에서 그 세트들이 **서버가 아는 완료**인 payload. */
  const setsOf = (ids: string[]) => ({
    status: "in_progress",
    planned_sets: ids.map((id) => ({ id, performed_set: { actual_reps: 8 } })),
  });

  it("A 로드가 늦게 끝나고 그 사이 B 로 옮겨 갔으면 버린다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];

    const gate = deferred<void>();
    const realGet = sessionDb.syncMeta.get.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "get").mockImplementationOnce((async (key: never) => {
      await gate.promise;
      return realGet(key);
    }) as never);

    const tokenA = coordinator.begin(A)!;
    const restoringA = restoreRestTimer(coordinator, tokenA, setsOf([SET]), T0, (restored) =>
      applied.push(`A:${restored.plannedSetId}`),
    );

    // 사용자가 다른 세션으로 옮겼다. 그 다음에야 A 의 읽기가 끝난다.
    coordinator.begin(B);
    gate.resolve();
    await restoringA;

    expect(applied).toEqual([]);
  });

  it("B 는 제 타이머로 정확히 복구된다", async () => {
    await saveRestTimer(USER, B, SET, TITLE, startRest(120, T0), T0);
    const coordinator = createRestoreCoordinator();
    const applied: { plannedSetId: string; endsAt: number }[] = [];

    const tokenB = coordinator.begin(B)!;
    await restoreRestTimer(coordinator, tokenB, setsOf([SET]), T0 + 40_000, (restored) =>
      applied.push({ plannedSetId: restored.plannedSetId, endsAt: restored.timer.endsAt }),
    );

    expect(applied).toEqual([{ plannedSetId: SET, endsAt: T0 + 120_000 }]);
  });

  it("그 세트가 지금 세션에 없으면 올리지 않고 지운다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];
    const token = coordinator.begin(A)!;

    await restoreRestTimer(coordinator, token, setsOf(["ps-other"]), T0, () => applied.push("x"));

    expect(applied).toEqual([]);
    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("저장된 것이 없으면 아무것도 하지 않는다", async () => {
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];
    const token = coordinator.begin(A)!;

    await restoreRestTimer(coordinator, token, setsOf([SET]), T0, () => applied.push("x"));

    expect(applied).toEqual([]);
  });
});

/**
 * **복구 자격은 서버가 아는 사실이다.**
 *
 * 세트가 목록에 있다는 것만으로 복구하면, 완료를 취소했는데 저장분 삭제가 실패한 경우
 * 취소한 세트의 휴식이 다시 떠서 기록 편집을 가린다. 종료한 세션도 마찬가지다.
 */
describe("복구 자격 — 완료 사실과 세션 상태", () => {
  const activeSession = {
    status: "in_progress",
    planned_sets: [
      { id: "done-1", performed_set: { actual_reps: 8 } },
      { id: "not-done", performed_set: null },
    ],
  };

  it("완료된 세트만 자격이 있다", () => {
    const eligibility = restoreEligibilityOf(activeSession);
    expect(isRestorable(eligibility, "done-1")).toBe(true);
    // 완료를 취소한 세트 — 서버가 더는 완료로 알지 않는다.
    expect(isRestorable(eligibility, "not-done")).toBe(false);
    // 목록에 아예 없는 세트.
    expect(isRestorable(eligibility, "gone")).toBe(false);
  });

  it("**종료된 세션은 어떤 타이머도 복구하지 않는다**", () => {
    const eligibility = restoreEligibilityOf({ ...activeSession, status: "completed" });
    expect(isRestorable(eligibility, "done-1")).toBe(false);
  });

  it("정상 진행 중 세션의 완료 세트는 계속 복구된다 — 자격이 기능을 죽이지 않는다", async () => {
    await saveRestTimer(USER, A, "done-1", TITLE, startRest(90, T0), T0);
    const coordinator = createRestoreCoordinator();
    const token = coordinator.begin(A)!;
    const applied: string[] = [];

    await restoreRestTimer(coordinator, token, activeSession, T0, (restored) =>
      applied.push(restored.plannedSetId),
    );

    expect(applied).toEqual(["done-1"]);
  });

  it("완료가 취소된 세트의 저장분은 복구되지 않고 지워진다", async () => {
    await saveRestTimer(USER, A, "not-done", TITLE, startRest(90, T0), T0);
    const coordinator = createRestoreCoordinator();
    const token = coordinator.begin(A)!;
    const applied: string[] = [];

    await restoreRestTimer(coordinator, token, activeSession, T0, () => applied.push("x"));

    expect(applied).toEqual([]);
    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("payload 가 비어 있어도 던지지 않는다", () => {
    expect(restoreEligibilityOf({}).completedPlannedSetIds.size).toBe(0);
    expect(restoreEligibilityOf({ planned_sets: null }).sessionCompleted).toBe(false);
  });
});

/**
 * **로컬 의사와 타이머는 같은 스냅샷이어야 한다.**
 *
 * 둘을 따로 읽으면 그 사이에 **다른 탭**이 원자적으로 커밋한 결과와 섞인다. 세대 무효화는
 * 같은 화면 인스턴스의 이벤트만 막으므로 다른 연결의 커밋을 막지 못한다. 실제로 두 방향이 났다 —
 * 오래된 "로컬 행 없음" 스냅샷 + 새 타이머 조합이 **정상 오프라인 완료 타이머를 지웠고**,
 * 로컬 읽기 실패를 "행 없음"으로 낮춰서 **취소한 세트의 타이머를 복구했다.**
 */
describe("복구 스냅샷 — 로컬 의사와 타이머를 한 트랜잭션에서 본다", () => {
  const staleServer = {
    status: "in_progress",
    planned_sets: [{ id: SET, performed_set: null }],
  };
  const doneOnServer = {
    status: "in_progress",
    planned_sets: [{ id: SET, performed_set: { actual_reps: 8 } }],
  };

  /**
   * **다른 탭의 연결.** Dexie 인스턴스를 재사용하면 진행 중인 트랜잭션 zone 에 딸려 들어가
   * 경합 자체가 사라진다 — 그래서 IndexedDB 연결을 따로 연다.
   */
  const foreign: IDBDatabase[] = [];
  const openForeignConnection = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("afc-session-v1");
      request.onsuccess = () => {
        foreign.push(request.result);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });

  // 열린 연결이 남으면 다음 테스트의 `deleteDatabase` 가 블록된다(실측: beforeEach 타임아웃).
  afterEach(() => {
    for (const connection of foreign.splice(0)) connection.close();
  });

  /**
   * `commitDraftBatch` 와 같은 원자성으로 draft 와 타이머를 **한 트랜잭션**에 넣는다.
   * 완료를 기다리지 않는다 — 트랜잭션 **생성 순서**가 곧 커밋 순서라 그것만으로 결정론적이다.
   */
  function foreignCommit(connection: IDBDatabase, completed: boolean, timer: unknown): void {
    const transaction = connection.transaction(["drafts", "syncMeta"], "readwrite");
    transaction.objectStore("drafts").put({
      user_id: USER,
      session_id: A,
      planned_set_id: SET,
      weight: 60,
      reps: 8,
      rir: 2,
      time_sec: null,
      completed,
      updated_at: "2026-08-14T08:00:00.000Z",
    });
    if (timer !== null) transaction.objectStore("syncMeta").put(timer);
  }

  const timerRow = (endsAt: number, savedAt: number) => ({
    user_id: USER,
    key: restTimerKeyFor(A),
    value: JSON.stringify({
      v: 2,
      session_id: A,
      planned_set_id: SET,
      title: TITLE,
      total_sec: 90,
      ends_at: endsAt,
      saved_at: savedAt,
    }),
  });

  /** 타이머를 읽으러 가는 **바로 그 순간**에 다른 연결의 커밋을 끼워 넣는다. */
  function interleaveAtTimerRead(run: () => void): void {
    const realGet = sessionDb.syncMeta.get.bind(sessionDb.syncMeta);
    let fired = false;
    vi.spyOn(sessionDb.syncMeta, "get").mockImplementation(((key: [string, string]) => {
      if (!fired && Array.isArray(key) && key[1] === restTimerKeyFor(A)) {
        fired = true;
        run();
      }
      return realGet(key as never);
    }) as never);
  }

  it("두 읽기 사이의 원자적 완료+저장이 **정상 타이머를 지우지 못한다**", async () => {
    const connection = await openForeignConnection();
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];

    // 로컬 의사를 읽은 뒤, 타이머를 읽기 직전에 다른 탭이 완료 + 저장을 한 번에 커밋한다.
    interleaveAtTimerRead(() => foreignCommit(connection, true, timerRow(T0 + 90_000, T0)));

    const token = coordinator.begin(A)!;
    // 서버는 아직 이 완료를 모른다(`performed_set: null`) — 로컬 의사만이 사실이다.
    await restoreRestTimer(coordinator, token, staleServer, T0 + 1_000, (restored) =>
      applied.push(restored.plannedSetId),
    );
    await flush();
    vi.restoreAllMocks();

    // 이 시점의 durable 사실: 완료됐고 타이머가 있다. 복구 탭이 그걸 지웠으면 안 된다.
    expect((await sessionDb.drafts.toArray())[0]?.completed).toBe(true);
    expect(await loadRestTimer(USER, A, T0 + 1_000)).not.toBeNull();

    // 다음 복구가 그 타이머를 올린다 — 잃어버린 것이 없다.
    coordinator.invalidate();
    const retry = coordinator.begin(A)!;
    await restoreRestTimer(coordinator, retry, staleServer, T0 + 1_000, (restored) =>
      applied.push(restored.plannedSetId),
    );
    expect(applied).toEqual([SET]);
  });

  it("로컬 의사 읽기 실패는 **'행 없음'이 아니라 unknown** 이다 — 취소한 타이머를 올리지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    // durable 완료취소. 서버 미러는 아직 stale 한 `performed_set` 을 들고 있다.
    await sessionDb.drafts.put({
      user_id: USER,
      session_id: A,
      planned_set_id: SET,
      weight: 60,
      reps: 8,
      rir: 2,
      time_sec: null,
      completed: false,
      updated_at: "2026-08-14T08:00:00.000Z",
    } as never);

    vi.spyOn(sessionDb.drafts, "where").mockImplementationOnce((() => {
      throw new Error("drafts read failed");
    }) as never);

    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];
    const token = coordinator.begin(A)!;
    await restoreRestTimer(coordinator, token, doneOnServer, T0 + 1_000, (restored) =>
      applied.push(restored.plannedSetId),
    );

    // 아무것도 올리지 않는다. 그리고 **근거 없이 지우지도 않는다** — 다음 시도가 판단한다.
    expect(applied).toEqual([]);
    expect(await loadRestTimer(USER, A, T0 + 1_000)).not.toBeNull();

    // 읽기가 회복되면 durable 완료취소가 이긴다: 올리지 않고 그때 정리한다.
    vi.restoreAllMocks();
    coordinator.invalidate();
    const retry = coordinator.begin(A)!;
    await restoreRestTimer(coordinator, retry, doneOnServer, T0 + 1_000, (restored) =>
      applied.push(restored.plannedSetId),
    );
    expect(applied).toEqual([]);
    expect(await loadRestTimer(USER, A, T0 + 1_000)).toBeNull();
  });

  it("로컬 행이 아예 없으면 서버 사실로 수렴한다 — 오버레이가 기능을 죽이지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];
    const token = coordinator.begin(A)!;

    await restoreRestTimer(coordinator, token, doneOnServer, T0 + 1_000, (restored) =>
      applied.push(restored.plannedSetId),
    );

    expect(applied).toEqual([SET]);
  });

  it("자격 없는 타이머를 지울 때 **그 사이 도착한 새 타이머**는 지우지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    const connection = await openForeignConnection();
    // 다른 탭이 새 타이머를 저장한다. 우리가 지우려는 것은 옛 바이트뿐이다.
    // `ends_at` 은 `saved_at + total_sec` 를 넘지 못한다 — 넘으면 손상으로 거절된다.
    interleaveAtTimerRead(() => foreignCommit(connection, true, timerRow(T0 + 91_000, T0 + 1_000)));

    const coordinator = createRestoreCoordinator();
    const token = coordinator.begin(A)!;
    // 서버·로컬 모두 완료를 모르는 상태로 판단하게 둔다 → 옛 타이머는 자격이 없다.
    await restoreRestTimer(coordinator, token, staleServer, T0 + 2_000, () => undefined);
    await flush();
    vi.restoreAllMocks();

    const survivor = await loadRestTimer(USER, A, T0 + 2_000);
    expect(survivor).not.toBeNull();
    expect(survivor!.timer.endsAt).toBe(T0 + 91_000);
  });

  it("복구는 `drafts`·`outbox` 를 한 바이트도 바꾸지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0), T0);
    await sessionDb.drafts.put({
      user_id: USER,
      session_id: A,
      planned_set_id: SET,
      weight: 60,
      reps: 8,
      rir: 2,
      time_sec: null,
      completed: true,
      updated_at: "2026-08-14T08:00:00.000Z",
    } as never);
    const before = JSON.stringify([
      await sessionDb.drafts.toArray(),
      await sessionDb.outbox.toArray(),
    ]);

    const coordinator = createRestoreCoordinator();
    const token = coordinator.begin(A)!;
    await restoreRestTimer(coordinator, token, staleServer, T0 + 1_000, () => undefined);

    expect(
      JSON.stringify([await sessionDb.drafts.toArray(), await sessionDb.outbox.toArray()]),
    ).toBe(before);
  });
});
