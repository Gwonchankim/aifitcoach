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
    // 앞 save 가 실패해도 clear 는 돌았고 성공을 보고한다.
    await expect(clearing).resolves.toBe(true);

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

    // B 의 읽기도 A 에 막히지 않는다.
    expect(await loadRestTimer(USER, B, T0)).not.toBeNull();
    // A 는 아직 커밋되지 않았다(큐 밖에서 직접 확인 — 같은 세션 읽기는 큐 뒤로 줄을 선다).
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(A)])).toBeUndefined();

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

describe("P2 stale load vs 새 save — 낡은 판정이 새 타이머를 지우지 못한다", () => {
  it("낡은 레코드를 읽는 도중 저장된 정상 타이머가 살아남는다", async () => {
    // 이미 stale 인 레코드(어제 것)를 심어 둔다. 복구는 이걸 지우려 할 것이다.
    await saveRestTimer(USER, A, SET, TITLE, { totalSec: 90, endsAt: T0 - 86_400_000 });

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
    const saving = saveRestTimer(USER, A, SET, TITLE, { totalSec: 120, endsAt: T0 + 120_000 });
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
    const saving = saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
    gate.resolve();

    expect(await loading).toBeNull();
    await saving;

    expect(await loadRestTimer(USER, A, T0 + 1_000)).not.toBeNull();
  });
});

describe("P2 완료 취소 — 그 세트만 지운다", () => {
  it("일치하는 세트면 지운다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));

    await clearRestTimerForPlannedSet(USER, A, SET);

    expect(await loadRestTimer(USER, A, T0)).toBeNull();
  });

  it("다른 세트면 남긴다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));

    await clearRestTimerForPlannedSet(USER, A, "ps-other");

    expect(await loadRestTimer(USER, A, T0)).not.toBeNull();
  });

  it("저장된 것이 없어도 던지지 않는다", async () => {
    await expect(clearRestTimerForPlannedSet(USER, A, SET)).resolves.toBe(true);
  });
});

describe("P1-3 세트 id 승격 — 저장된 타이머도 따라간다", () => {
  it("일치하는 세트를 서버 id 로 옮긴다", async () => {
    await saveRestTimer(USER, A, "corr-1", TITLE, startRest(90, T0));

    await expect(remapRestTimerPlannedSet(USER, A, "corr-1", "server-1")).resolves.toBe(true);

    const moved = await loadRestTimer(USER, A, T0);
    expect(moved!.plannedSetId).toBe("server-1");
    // 나머지는 그대로다.
    expect(moved!.timer).toEqual({ totalSec: 90, endsAt: T0 + 90_000 });
    expect(moved!.title).toBe(TITLE);
  });

  it("다른 세트의 타이머는 건드리지 않는다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));

    await expect(remapRestTimerPlannedSet(USER, A, "corr-1", "server-1")).resolves.toBe(false);

    expect((await loadRestTimer(USER, A, T0))!.plannedSetId).toBe(SET);
  });

  it("저장된 것이 없으면 아무 일도 없다", async () => {
    await expect(remapRestTimerPlannedSet(USER, A, "corr-1", "server-1")).resolves.toBe(false);
  });

  it("같은 id 로의 승격은 무시한다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));

    await expect(remapRestTimerPlannedSet(USER, A, SET, SET)).resolves.toBe(false);
  });

  it("승격은 세션 큐 안에서 일어난다 — 앞선 저장 뒤에 적용된다", async () => {
    const gate = deferred<void>();
    const realPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    vi.spyOn(sessionDb.syncMeta, "put").mockImplementationOnce((async (row: never) => {
      await gate.promise;
      return realPut(row);
    }) as never);

    const saving = saveRestTimer(USER, A, "corr-1", TITLE, startRest(90, T0));
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
    await saveRestTimer(USER, B, SET, TITLE, startRest(120, T0));
    const coordinator = createRestoreCoordinator();
    const applied: { plannedSetId: string; endsAt: number }[] = [];

    const tokenB = coordinator.begin(B)!;
    await restoreRestTimer(coordinator, tokenB, setsOf([SET]), T0 + 40_000, (restored) =>
      applied.push({ plannedSetId: restored.plannedSetId, endsAt: restored.timer.endsAt }),
    );

    expect(applied).toEqual([{ plannedSetId: SET, endsAt: T0 + 120_000 }]);
  });

  it("그 세트가 지금 세션에 없으면 올리지 않고 지운다", async () => {
    await saveRestTimer(USER, A, SET, TITLE, startRest(90, T0));
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
