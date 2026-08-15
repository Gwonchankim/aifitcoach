/**
 * 세트 기록 상태 계약(F1 되돌리기·F7 부분 수행, STEP 6 /sync payload 모양).
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  painOf,
  summarize,
  useSessionLog,
  type SetDraft,
} from "../components/session/session-store";

const VALUES = { weight: 62.5, reps: 9, rir: 2, timeSec: null };

beforeEach(async () => {
  const { sessionDb } = await import("../components/session/session-db");
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
});

/** openapi PerformedSet.client_id / Mutation.client_id = `format: uuid`. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("완료 체크", () => {
  it("commit failure leaves Zustand unchanged", async () => {
    const { sessionDb } = await import("../components/session/session-db");
    await useSessionLog.getState().begin("s_1");
    vi.spyOn(sessionDb.drafts, "put").mockRejectedValueOnce(new Error("disk full"));

    await expect(useSessionLog.getState().completeSet("ps_1", VALUES)).rejects.toThrow("disk full");
    expect(useSessionLog.getState().drafts).toEqual({});
    expect(await sessionDb.outbox.count()).toBe(0);
  });

  it("체크 → 해제 → 재체크에서 값이 사라지지 않는다(AC-S4-1)", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    await store.uncompleteSet("ps_1");

    const afterUncheck = useSessionLog.getState().drafts.ps_1;
    expect(afterUncheck.completed).toBe(false);
    expect(afterUncheck.actual_weight).toBe(62.5);
    expect(afterUncheck.actual_reps).toBe(9);

    await useSessionLog.getState().completeSet("ps_1", VALUES);
    expect(useSessionLog.getState().drafts.ps_1.completed).toBe(true);
  });

  it("client_id 는 편집마다 새 mutation id를 만든다", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    const first = useSessionLog.getState().drafts.ps_1.client_id;

    await store.uncompleteSet("ps_1");
    await store.completeSet("ps_1", VALUES);

    expect(useSessionLog.getState().drafts.ps_1.client_id).not.toBe(first);
  });

  it("드래프트는 openapi PerformedSet 과 같은 키를 갖는다", async () => {
    await useSessionLog.getState().begin("s_1");
    await useSessionLog.getState().completeSet("ps_1", { ...VALUES, weight: null, timeSec: 45 });
    const draft: SetDraft = useSessionLog.getState().drafts.ps_1;

    expect(Object.keys(draft).sort()).toEqual(
      [
        "actual_reps",
        "actual_rir",
        "actual_time_sec",
        "actual_weight",
        "client_id",
        "completed",
        "pain_score",
        "planned_set_id",
        "updated_at",
      ].sort(),
    );
    expect(draft.actual_time_sec).toBe(45);
    expect(draft.actual_weight).toBeNull();
  });

  it("client_id 는 세트마다 다른 uuid 다", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    await store.completeSet("ps_2", VALUES);

    const drafts = useSessionLog.getState().drafts;
    expect(drafts.ps_1.client_id).toMatch(UUID_V4);
    expect(drafts.ps_2.client_id).toMatch(UUID_V4);
    expect(drafts.ps_1.client_id).not.toBe(drafts.ps_2.client_id);
  });
});

/**
 * 실기기 재현(blocker): 폰에서 `http://192.168.x.x:3000` 으로 열면 **secure context 가 아니다**.
 * 그 환경에서 `crypto.randomUUID` 는 아예 없다(`crypto.getRandomValues` 는 있다).
 * 여기서 예외가 나면 완료 체크가 통째로 죽는다 → 휴식 타이머도 안 뜨고 종료 시 0세트가 된다.
 */
describe("비보안 출처(http) 실기기", () => {
  beforeEach(() => {
    // 프로토타입의 randomUUID 를 own 프로퍼티로 가린다(브라우저의 비보안 출처와 같은 모양).
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });

  afterEach(() => {
    delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  });

  it("crypto.randomUUID 가 없어도 완료 체크가 기록된다", async () => {
    expect(globalThis.crypto.randomUUID).toBeUndefined();

    await useSessionLog.getState().begin("s_1");
    await expect(useSessionLog.getState().completeSet("ps_1", VALUES)).resolves.toBeUndefined();

    const draft = useSessionLog.getState().drafts.ps_1;
    expect(draft.completed).toBe(true);
    expect(draft.actual_weight).toBe(62.5);
    expect(draft.client_id).toMatch(UUID_V4);
    expect(summarize(useSessionLog.getState().drafts).completedCount).toBe(1);
  });
});

/**
 * 운동별 통증 보고(FEATURES_UX 안전 절). STEP 5 에는 세트 통증을 보낼 경로가 없으므로
 * 드래프트의 `pain_score`(= openapi PerformedSet 키)에만 담고 STEP 6 /sync 로 넘긴다.
 */
describe("통증 보고", () => {
  it("운동의 모든 세트에 통증 점수를 남긴다", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    await store.reportPain(["ps_1", "ps_2"], 5);

    const drafts = useSessionLog.getState().drafts;
    expect(drafts.ps_1.pain_score).toBe(5);
    expect(drafts.ps_2.pain_score).toBe(5);
    // 통증 기록이 완료 체크를 만들지는 않는다(F7: 완료 체크된 세트만 기록된다).
    expect(drafts.ps_1.completed).toBe(true);
    expect(drafts.ps_2.completed).toBe(false);
    expect(summarize(drafts).completedCount).toBe(1);
  });

  it("미완료 세트 통증은 로컬에만 남고 완료 세트만 새 outbox upsert를 만든다", async () => {
    const { sessionDb } = await import("../components/session/session-db");
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);

    await store.reportPain(["ps_1", "ps_2"], 5);

    const rows = await sessionDb.outbox.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.entity_id === "ps_1")).toHaveLength(2);
    expect(rows.some((row) => row.entity_id === "ps_2")).toBe(false);
  });

  it("여러 세트 통증 저장이 실패하면 DB와 Zustand 모두 부분 반영하지 않는다", async () => {
    const { sessionDb } = await import("../components/session/session-db");
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    vi.spyOn(sessionDb.outbox, "put").mockRejectedValueOnce(new Error("disk full"));

    await expect(store.reportPain(["ps_2", "ps_1"], 5)).rejects.toThrow("disk full");

    expect(useSessionLog.getState().drafts.ps_1.pain_score).toBeNull();
    expect(useSessionLog.getState().drafts.ps_2).toBeUndefined();
    expect(await sessionDb.outbox.count()).toBe(1);
  });

  it("기록값은 건드리지 않고, 취소하면 null 로 되돌린다", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    await store.reportPain(["ps_1"], 7);
    await store.reportPain(["ps_1"], null);

    const draft = useSessionLog.getState().drafts.ps_1;
    expect(draft.pain_score).toBeNull();
    expect(draft.actual_weight).toBe(62.5);
    expect(draft.completed).toBe(true);
  });

  it("같은 운동의 통증 점수를 읽어온다", async () => {
    await useSessionLog.getState().begin("s_1");
    await useSessionLog.getState().reportPain(["ps_1", "ps_2"], 4);
    expect(painOf(useSessionLog.getState().drafts, ["ps_1", "ps_2"])).toBe(4);
    expect(painOf(useSessionLog.getState().drafts, ["ps_9"])).toBeNull();
  });
});

describe("begin", () => {
  it("늦게 끝난 hydrate가 같은 세션의 새 commit을 지우지 않는다", async () => {
    const { sessionDb } = await import("../components/session/session-db");
    let release!: (rows: never[]) => void;
    const rows = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    const where = vi.spyOn(sessionDb.drafts, "where").mockReturnValue({
      equals: () => ({ toArray: () => rows }),
    } as never);

    const begin = useSessionLog.getState().begin("s_1");
    await useSessionLog.getState().completeSet("ps_new", VALUES);
    release([]);
    await begin;
    where.mockRestore();

    expect(useSessionLog.getState().drafts.ps_new.completed).toBe(true);
  });

  it("다른 세션에 들어오면 기록을 비운다", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);

    await useSessionLog.getState().begin("s_2");
    expect(useSessionLog.getState().drafts).toEqual({});
  });

  it("같은 세션이면 기록을 유지한다(리마운트로 기록이 날아가지 않는다)", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);

    await useSessionLog.getState().begin("s_1");
    expect(useSessionLog.getState().drafts.ps_1.completed).toBe(true);
  });
});

describe("summarize (F7 부분 수행)", () => {
  it("완료 체크된 세트만 집계한다(AC-S5-1)", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", VALUES);
    await store.completeSet("ps_2", { weight: 60, reps: 10, rir: null, timeSec: null });
    await store.completeSet("ps_3", VALUES);
    await store.uncompleteSet("ps_3");

    const summary = summarize(useSessionLog.getState().drafts);
    expect(summary.completedCount).toBe(2);
    expect(summary.totalVolume).toBe(62.5 * 9 + 60 * 10);
  });

  it("자체중량·시간 세트는 볼륨에 0으로 들어간다(C-6 미확정)", async () => {
    const store = useSessionLog.getState();
    await store.begin("s_1");
    await store.completeSet("ps_1", { weight: null, reps: 12, rir: null, timeSec: null });
    await store.completeSet("ps_2", { weight: null, reps: null, rir: null, timeSec: 45 });

    expect(summarize(useSessionLog.getState().drafts)).toEqual({
      completedCount: 2,
      totalVolume: 0,
    });
  });

  it("기록이 없으면 0 이다", () => {
    expect(summarize({})).toEqual({ completedCount: 0, totalVolume: 0 });
  });
});
