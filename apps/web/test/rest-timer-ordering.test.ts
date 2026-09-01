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
  clearRestTimer,
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

    const saving = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
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
      saveRestTimer(USER, A, SET, TITLE, { totalSec: 90, endsAt: T0 + 90_000 }),
      saveRestTimer(USER, A, SET, TITLE, { totalSec: 120, endsAt: T0 + 120_000 }),
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

    const saving = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    const clearing = clearRestTimer(USER, A);

    await expect(saving).resolves.toBe(false);
    await expect(clearing).resolves.toBeUndefined();

    // 실패한 save 가 큐를 막지 않았다 — 그 뒤 정상 저장도 된다.
    vi.restoreAllMocks();
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    expect(await loadRestTimer(USER, A, T0)).not.toBeNull();
  });

  it("clear 가 실패해도 그 다음 clear 는 실행된다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
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

    const blocked = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    // B 는 A 가 붙잡혀 있어도 제 갈 길을 간다 — 큐는 세션마다 따로다.
    await saveRestTimer(USER, B, SET, TITLE, startRest(60, T0));

    expect(await loadRestTimer(USER, B, T0)).not.toBeNull();
    // A 는 아직 붙잡혀 있다.
    expect(await loadRestTimer(USER, A, T0)).toBeNull();

    gate.resolve();
    await blocked;
    expect(await loadRestTimer(USER, A, T0)).not.toBeNull();
  });

  it("모든 작업이 끝나면 큐 찌꺼기가 남지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    await saveRestTimer(USER, B, SET, TITLE, startRest(90, T0));
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
      saveRestTimer(USER, A, SET, TITLE, startRest(90, T0)),
      clearRestTimer(USER, A),
      saveRestTimer(USER, A, SET, TITLE, startRest(30, T0)),
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

describe("P1-2 정체성 — 복구는 지금 보고 있는 세션 것만", () => {
  it("같은 세션은 한 번만 시도한다", () => {
    const coordinator = createRestoreCoordinator();

    expect(coordinator.begin(A)).toBe(true);
    expect(coordinator.begin(A)).toBe(false);
    expect(coordinator.begin(A)).toBe(false);
  });

  it("세션이 바뀌면 다시 시도한다 — 영구 skip 하지 않는다", () => {
    const coordinator = createRestoreCoordinator();

    expect(coordinator.begin(A)).toBe(true);
    expect(coordinator.begin(B)).toBe(true);
  });

  it("A 로 돌아오면 다시 시도한다", () => {
    const coordinator = createRestoreCoordinator();

    coordinator.begin(A);
    coordinator.begin(B);
    expect(coordinator.begin(A)).toBe(true);
  });

  it("현재 세션 판정은 마지막으로 시작한 것을 따른다", () => {
    const coordinator = createRestoreCoordinator();

    coordinator.begin(A);
    expect(coordinator.isCurrent(A)).toBe(true);

    coordinator.begin(B);
    expect(coordinator.isCurrent(A)).toBe(false);
    expect(coordinator.isCurrent(B)).toBe(true);
  });
});

describe("P1-2 stale async — 늦게 온 A 의 결과를 B 화면에 얹지 않는다", () => {
  const setsOf = (ids: string[]) => ids;

  it("A 로드가 늦게 끝나고 그 사이 B 로 옮겨 갔으면 버린다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];

    const gate = deferred<void>();
    const realGet = sessionDb.syncMeta.get.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "get").mockImplementationOnce((async (key: never) => {
      await gate.promise;
      return realGet(key);
    }) as never);

    const restoringA = restoreRestTimer(coordinator, A, setsOf([SET]), T0, (restored) =>
      applied.push(`A:${restored.plannedSetId}`),
    );

    // 사용자가 다른 세션으로 옮겼다. 그 다음에야 A 의 읽기가 끝난다.
    coordinator.begin(B);
    gate.resolve();
    await restoringA;

    expect(applied).toEqual([]);
  });

  it("B 는 제 타이머로 정확히 복구된다", async () => {
    await saveRestTimer(USER, B, SET, TITLE, startRest(120, T0));
    const coordinator = createRestoreCoordinator();
    const applied: { plannedSetId: string; endsAt: number }[] = [];

    expect(coordinator.begin(B)).toBe(true);
    await restoreRestTimer(coordinator, B, setsOf([SET]), T0 + 40_000, (restored) =>
      applied.push({ plannedSetId: restored.plannedSetId, endsAt: restored.timer.endsAt }),
    );

    expect(applied).toEqual([{ plannedSetId: SET, endsAt: T0 + 120_000 }]);
  });

  it("그 세트가 지금 세션에 없으면 올리지 않고 지운다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];
    coordinator.begin(A);

    await restoreRestTimer(coordinator, A, setsOf(["ps-other"]), T0, () => applied.push("x"));

    expect(applied).toEqual([]);
    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("저장된 것이 없으면 아무것도 하지 않는다", async () => {
    const coordinator = createRestoreCoordinator();
    const applied: string[] = [];
    coordinator.begin(A);

    await restoreRestTimer(coordinator, A, setsOf([SET]), T0, () => applied.push("x"));

    expect(applied).toEqual([]);
  });
});
