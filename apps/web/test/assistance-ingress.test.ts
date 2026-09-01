/**
 * F-4b fixup — **모든 production ingress 가 같은 fail-closed 경계를 지난다.**
 *
 * authoritative GET 하나만 막으면 소용이 없다. sync 의 `planned_set_mappings`, 루틴 편집의
 * provisional commit, 편집 뒤 refetch 가 각자 raw 로 미러를 쓰면 v4 가 지운 세션이 그 경로로 다시 오염된다.
 *
 * 보존해야 하는 것은 그대로다 — **`drafts`·`outbox`·correlation remap 은 어떤 거절에서도 살아남는다.**
 * 거절되는 것은 "서버가 안전하다고 말하지 않은 처방"뿐이다.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import {
  commitAuthoritativeSession,
  commitRoutineSnapshot,
  DEV_USER_SCOPE,
  isRemediationPending,
  isSafeSessionPayload,
  markerKeyFor,
  markRemediationPending,
  processRemediationMarkers,
  readThroughSession,
  mirrorSession,
  REMEDIATION_PENDING,
  safeMappings,
  sessionDb,
} from "../components/session/session-db";

const USER = DEV_USER_SCOPE;

function serverRow(overrides: Record<string, unknown> = {}) {
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

/** 클라이언트가 오프라인에서 만든 임시 행. **출처는 행이 아니라 호출 context 가 정한다.** */
function provisionalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "corr-1",
    exercise_id: "e_bench_press",
    set_no: 1,
    target_reps_low: 8,
    target_reps_high: 12,
    target_rir: 2,
    rest_sec: 90,
    // 처방이 없다 — `0` 은 "무게 미정"이라 방향을 주장하지 않는다.
    recommended_weight: 0,
    recommended_reps: 8,
    reason_code: "BASELINE",
    confidence: 0,
    rules_version: "2026.08.1",
    ...overrides,
  };
}

function payload(sets: unknown[], overrides: Record<string, unknown> = {}) {
  return { id: "s-1", status: "scheduled", planned_sets: sets, ...overrides };
}

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

describe("구조 검증 — malformed 는 안전이 아니다", () => {
  it.each([
    ["planned_sets 없음", { id: "s-1", status: "scheduled" }],
    ["planned_sets 가 배열이 아님", { id: "s-1", planned_sets: {} }],
    ["planned_sets 가 null", { id: "s-1", planned_sets: null }],
    ["세션이 null", null],
    ["세션이 문자열", "nope"],
    ["행이 객체가 아님", { id: "s-1", planned_sets: ["nope"] }],
  ])("%s 는 거절한다", (_label, session) => {
    expect(isSafeSessionPayload(session)).toBe(false);
  });

  it("빈 배열은 통과한다 — 계획이 없는 세션은 위험하지 않다", () => {
    expect(isSafeSessionPayload(payload([]))).toBe(true);
  });
});

describe("load_kind 는 exact whitelist 다", () => {
  it.each([["external"], ["bodyweight"], ["not_applicable"]])(
    "%s 는 허용된 non-assistance 값이다",
    (kind) => {
      const row = serverRow({
        load_kind: kind,
        assistance_provenance: null,
        assistance_safety_status: null,
      });
      expect(isSafeSessionPayload(payload([row]))).toBe(true);
    },
  );

  it.each([
    ["null", null],
    ["없음", undefined],
    ["오타", "assistanc"],
    ["미래 값", "elastic_band"],
    ["숫자", 3],
  ])("%s 인 load_kind 는 거절한다", (_label, kind) => {
    const row = serverRow({ load_kind: kind }) as Record<string, unknown>;
    if (kind === undefined) delete row.load_kind;
    expect(isSafeSessionPayload(payload([row]))).toBe(false);
  });
});

const LOCAL = new Set(["corr-1"]);

describe("provisional 행 — 출처는 호출 context 가 정한다", () => {
  it("local envelope 로 알려주면 통과한다 — 오프라인 편집이 살아야 한다", () => {
    expect(isSafeSessionPayload(payload([provisionalRow()]), LOCAL)).toBe(true);
  });

  it("**같은 행이라도 봉투가 없으면 거절**한다 — server payload 는 로컬 규칙을 못 쓴다", () => {
    expect(isSafeSessionPayload(payload([provisionalRow()]))).toBe(false);
  });

  it("payload 가 provisional 을 자칭해도 소용없다 — server-spoofed reject", () => {
    const spoofed = provisionalRow({ id: "ps-spoof", provisional: true });
    expect(isSafeSessionPayload(payload([spoofed]))).toBe(false);
  });

  it.each([
    ["양수 무게", { recommended_weight: 20 }],
    ["처방 상태", { recommendation_state: "ready" }],
    ["action", { recommended_action: { kind: "suggest_exercise_swap", exercise_id: "e_pullup" } }],
    ["verdict", { assistance_safety_status: "safe" }],
    ["provenance", { assistance_provenance: "native" }],
    ["load_kind", { load_kind: "assistance" }],
    ["generic reason", { reason_code: "WEIGHT_UP_REP_TARGET_MET" }],
    ["빈 exercise_id", { exercise_id: "" }],
    ["set_no 0", { set_no: 0 }],
  ])("로컬 행이 %s 를 주장하면 거절한다 — 로컬은 처방 축을 만들지 않는다", (_l, override) => {
    expect(isSafeSessionPayload(payload([provisionalRow(override)]), LOCAL)).toBe(false);
  });

  it("서버 행과 섞여도 각자 규칙으로 판정한다", () => {
    expect(isSafeSessionPayload(payload([serverRow(), provisionalRow()]), LOCAL)).toBe(true);
    expect(
      isSafeSessionPayload(
        payload([serverRow({ assistance_safety_status: "unsafe" }), provisionalRow()]),
        LOCAL,
      ),
    ).toBe(false);
  });
});

describe("mirrorSession — 모든 미러 쓰기가 같은 경계를 지난다", () => {
  it("unsafe payload 는 미러에 쓰지 않고 marker 를 세운다", async () => {
    const unsafe = payload([serverRow({ assistance_safety_status: "unsafe" })]);

    await expect(mirrorSession(USER, "s-1", unsafe)).resolves.toBe(false);
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });

  it("safe payload 는 그대로 쓴다", async () => {
    await expect(mirrorSession(USER, "s-1", payload([serverRow()]))).resolves.toBe(true);
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
  });

  it("거절해도 기존 안전 미러를 지우지 않는다 — 있던 화면을 빼앗지 않는다", async () => {
    await mirrorSession(USER, "s-1", payload([serverRow()]));
    await mirrorSession(USER, "s-1", payload([serverRow({ assistance_safety_status: "unsafe" })]));

    const kept = await sessionDb.sessions.get([USER, "s-1"]);
    expect(kept).toBeDefined();
    // 그래도 marker 는 선다 — 다음 읽기가 authoritative refetch 를 강제한다.
    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });
});

describe("routine 편집 — 거절해도 outbox·correlation 은 보존한다", () => {
  const correlations = [{ correlation_id: "corr-1", exercise_id: "e_bench_press", set_no: 1 }];

  it("unsafe 세션 스냅샷이면 미러는 안 쓰되 outbox 는 남는다", async () => {
    const unsafe = payload([serverRow({ assistance_safety_status: "unsafe" })]) as never;

    await commitRoutineSnapshot(
      USER,
      "s-1",
      ["e_bench_press"],
      "00000000-0000-4000-8000-0000000000cc",
      "2026-08-14T08:00:00.000Z",
      correlations,
      unsafe,
    );

    // 사용자의 편집 의도는 서버로 가야 한다 — 이걸 잃으면 진짜 데이터 손실이다.
    expect(await sessionDb.outbox.count()).toBe(1);
    expect((await sessionDb.routines.get([USER, "s-1"]))?.correlations).toHaveLength(1);
    // 그러나 unsafe 처방은 미러에 남지 않는다.
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });

  it("provisional 스냅샷은 정상 저장된다 — 오프라인 추가가 살아 있다", async () => {
    await commitRoutineSnapshot(
      USER,
      "s-1",
      ["e_bench_press"],
      "00000000-0000-4000-8000-0000000000dd",
      "2026-08-14T08:00:00.000Z",
      correlations,
      payload([provisionalRow()]) as never,
      LOCAL,
    );

    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(false);
  });
});

describe("sync mapping — 안전한 매핑만 화면·미러로 간다", () => {
  const mapping = (planned: Record<string, unknown>) => ({
    correlation_id: "corr-1",
    planned_set_id: "ps-1",
    planned_set: planned,
  });

  it("unsafe·구형 매핑은 걸러낸다", () => {
    expect(safeMappings([mapping(serverRow({ assistance_safety_status: "unsafe" }))])).toEqual([]);
    const legacy = serverRow() as Record<string, unknown>;
    delete legacy.load_kind;
    delete legacy.assistance_safety_status;
    expect(safeMappings([mapping(legacy)])).toEqual([]);
  });

  it("안전한 매핑은 그대로 통과한다", () => {
    const safe = mapping(serverRow());
    expect(safeMappings([safe])).toEqual([safe]);
  });
});

describe("marker 는 세션 단위로 격리된다", () => {
  it("한 세션이 막혀도 다른 세션은 영향받지 않는다", async () => {
    await mirrorSession(
      USER,
      "s-bad",
      payload([serverRow({ assistance_safety_status: "unsafe" })]),
    );
    await mirrorSession(USER, "s-good", payload([serverRow()]));

    expect(await isRemediationPending(USER, "s-bad")).toBe(true);
    expect(await isRemediationPending(USER, "s-good")).toBe(false);
    expect(await sessionDb.syncMeta.get([USER, markerKeyFor("s-bad")])).toMatchObject({
      value: REMEDIATION_PENDING,
    });
  });
});

/**
 * **marker 수명주기는 production 에 연결돼야 한다.** 정의만 있고 부르는 곳이 없으면
 * "다음 sync 에서 authoritative refetch" 는 문서상의 약속일 뿐이다.
 */
describe("marker lifecycle — foreground sync 가 실제로 처리한다", () => {
  async function seedMarker(sessionId: string) {
    await markRemediationPending(USER, sessionId);
  }

  it("pending 세션을 refetch 해서 safe 면 marker 를 푼다", async () => {
    await seedMarker("s-1");
    const fetched: string[] = [];

    await processRemediationMarkers(USER, async (sessionId) => {
      fetched.push(sessionId);
      return payload([serverRow()]);
    });

    expect(fetched).toEqual(["s-1"]);
    expect(await isRemediationPending(USER, "s-1")).toBe(false);
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
  });

  it("여전히 unsafe 면 marker 를 유지한다 — 200 은 근거가 아니다", async () => {
    await seedMarker("s-1");

    await processRemediationMarkers(USER, async () =>
      payload([serverRow({ assistance_safety_status: "unsafe" })]),
    );

    expect(await isRemediationPending(USER, "s-1")).toBe(true);
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeUndefined();
  });

  it("오프라인·5xx 면 marker 를 유지한다", async () => {
    await seedMarker("s-1");

    await processRemediationMarkers(USER, async () => {
      throw new ApiError(503, "UNAVAILABLE", "down");
    });

    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });

  it.each([[404], [410]])(
    "authenticated %s 는 terminal cleanup 이다 — 고아 marker 를 남기지 않는다",
    async (status) => {
      await seedMarker("s-gone");

      await processRemediationMarkers(USER, async () => {
        throw new ApiError(status, "NOT_FOUND", "gone");
      });

      expect(await isRemediationPending(USER, "s-gone")).toBe(false);
    },
  );

  it("401 은 terminal 이 아니다 — 인증이 끊긴 것뿐이라 marker 를 지우면 안 된다", async () => {
    await seedMarker("s-1");

    await processRemediationMarkers(USER, async () => {
      throw new ApiError(401, "UNAUTHENTICATED", "no session");
    });

    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });

  it("다른 사용자의 marker 는 건드리지 않는다", async () => {
    await markRemediationPending("other-user", "s-1");

    const seen: string[] = [];
    await processRemediationMarkers(USER, async (sessionId) => {
      seen.push(sessionId);
      return payload([]);
    });

    expect(seen).toEqual([]);
    expect(await isRemediationPending("other-user", "s-1")).toBe(true);
  });

  it("marker 가 아닌 syncMeta 키(cursor)는 건드리지 않는다", async () => {
    await sessionDb.syncMeta.put({ user_id: USER, key: "cursor", value: "v1.abc" });

    await processRemediationMarkers(USER, async () => payload([]));

    expect((await sessionDb.syncMeta.get([USER, "cursor"]))?.value).toBe("v1.abc");
  });
});

describe("읽기 경로의 terminal cleanup", () => {
  it.each([[404], [410]])("%s 는 marker 를 지우고 오류를 그대로 던진다", async (status) => {
    await markRemediationPending(USER, "s-gone");

    await expect(
      readThroughSession(USER, "s-gone", () => {
        throw new ApiError(status, "NOT_FOUND", "gone");
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(await isRemediationPending(USER, "s-gone")).toBe(false);
  });
});

/**
 * **원자성은 주입해서 증명한다.** "unsafe 거절 → safe 성공" 만 보면 트랜잭션을 쪼개도 통과한다.
 * `sessions.put` 뒤 marker delete 전에 고장을 넣어 **둘 다 이전 상태로 돌아가는지** 본다.
 */
describe("commitAuthoritativeSession 은 원자적이다", () => {
  it("marker delete 가 실패하면 미러 쓰기도 롤백되고 marker 가 남는다", async () => {
    await markRemediationPending(USER, "s-1");
    const spy = vi
      .spyOn(sessionDb.syncMeta, "delete")
      .mockRejectedValueOnce(new Error("marker delete 실패"));

    try {
      await expect(
        commitAuthoritativeSession(USER, "s-1", payload([serverRow()])),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    // 절반만 반영되면 "미러는 새것, marker 는 그대로" 라는 모순 상태가 남는다.
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });

  it("고장이 없으면 둘 다 반영된다 — 비공허성", async () => {
    await markRemediationPending(USER, "s-1");

    expect(await commitAuthoritativeSession(USER, "s-1", payload([serverRow()]))).toBe(true);

    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(false);
  });
});

/**
 * **marker 를 남기지 못하면 stale 미러도 남기지 않는다.**
 *
 * marker 가 fail-closed 의 필수 조건인데 그 쓰기 실패를 삼키면, `isRemediationPending()` 이
 * false 를 주고 다음 오프라인 읽기가 **예전 stale 미러를 그대로 반환**한다(독립 재리뷰 P1-3).
 */
describe("marker durability — 쓰기 실패에서도 fail closed", () => {
  const safe = payload([serverRow()]);
  const unsafe = payload([serverRow({ assistance_safety_status: "unsafe" })]);

  async function withMarkerWriteFault<T>(body: () => Promise<T>): Promise<T> {
    const spy = vi
      .spyOn(sessionDb.syncMeta, "put")
      .mockRejectedValueOnce(new Error("quota exceeded"));
    try {
      return await body();
    } finally {
      spy.mockRestore();
    }
  }

  it("marker put 이 실패하면 기존 stale 미러를 지우고 오류를 알린다", async () => {
    await mirrorSession(USER, "s-1", safe);
    await sessionDb.drafts.put({
      user_id: USER,
      session_id: "s-1",
      planned_set_id: "ps-1",
      actual_weight: 22.5,
      actual_reps: 10,
      actual_rir: 2,
      actual_time_sec: null,
      pain_score: null,
      completed: true,
      client_id: "00000000-0000-4000-8000-0000000000ee",
      updated_at: "2026-08-14T09:00:00.000Z",
    });
    await sessionDb.outbox.put({
      client_id: "00000000-0000-4000-8000-0000000000ef",
      user_id: USER,
      entity: "performed_set",
      entity_id: "ps-1",
      op: "upsert",
      updated_at: "2026-08-14T09:00:00.000Z",
      payload: { actual_weight: 22.5, completed: true },
      attempts: 0,
    });

    await withMarkerWriteFault(async () => {
      await expect(mirrorSession(USER, "s-1", unsafe)).rejects.toThrow();
    });

    // 폴백 원천이 사라졌다 — stale 미러 반환 0.
    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeUndefined();
    // 사용자의 기록은 어느 경로에서도 건드리지 않는다.
    expect(await sessionDb.drafts.count()).toBe(1);
    expect(await sessionDb.outbox.count()).toBe(1);
  });

  it("그 뒤 오프라인 읽기가 stale 미러를 반환하지 않는다", async () => {
    await mirrorSession(USER, "s-1", safe);
    await withMarkerWriteFault(async () => {
      await mirrorSession(USER, "s-1", unsafe).catch(() => undefined);
    });

    await expect(
      readThroughSession(USER, "s-1", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow();
  });

  it("marker 를 정상적으로 쓰면 미러는 그대로 둔다 — 비공허성", async () => {
    await mirrorSession(USER, "s-1", safe);

    await expect(mirrorSession(USER, "s-1", unsafe)).resolves.toBe(false);

    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(true);
  });
});

/**
 * P1-1 — **화면 GET 경로도 같은 marker 경계를 쓴다.**
 * `readThroughSession` 이 따로 `syncMeta.put(...).catch()` 를 부르면 marker 실패가 삼켜지고
 * 다음 오프라인 읽기가 stale 미러를 되살린다.
 */
describe("authoritative GET 의 marker durability", () => {
  const safe = payload([serverRow()]);
  const unsafe = payload([serverRow({ assistance_safety_status: "unsafe" })]);

  it("unsafe GET + marker put 실패 → stale 미러가 사라지고 오류가 난다", async () => {
    await mirrorSession(USER, "s-1", safe);
    await sessionDb.drafts.put({
      user_id: USER,
      session_id: "s-1",
      planned_set_id: "ps-1",
      actual_weight: 20,
      actual_reps: 10,
      actual_rir: 2,
      actual_time_sec: null,
      pain_score: null,
      completed: true,
      client_id: "00000000-0000-4000-8000-0000000000f1",
      updated_at: "2026-08-14T09:00:00.000Z",
    });
    const spy = vi.spyOn(sessionDb.syncMeta, "put").mockRejectedValueOnce(new Error("quota"));

    try {
      await expect(readThroughSession(USER, "s-1", async () => unsafe)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeUndefined();
    // 다음 오프라인 읽기가 stale 을 돌려주지 않는다.
    await expect(
      readThroughSession(USER, "s-1", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow();
    // 기록은 그대로다.
    expect(await sessionDb.drafts.count()).toBe(1);
  });

  it("marker 가 정상적으로 서면 미러는 남고 다음 읽기는 막힌다", async () => {
    await mirrorSession(USER, "s-1", safe);

    await expect(readThroughSession(USER, "s-1", async () => unsafe)).rejects.toThrow();

    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(true);
    await expect(
      readThroughSession(USER, "s-1", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow();
  });
});

/** P2-1 — authenticated 404/410 은 marker 뿐 아니라 세션 캐시 전체를 정리한다. */
describe("terminal cleanup — 사라진 세션의 캐시도 지운다", () => {
  async function seedCachedSession() {
    await mirrorSession(USER, "s-gone", payload([serverRow()]));
    await sessionDb.routines.put({
      user_id: USER,
      session_id: "s-gone",
      exercise_ids: ["e_bench_press"],
      correlations: [],
      updated_at: "2026-08-14T00:00:00.000Z",
    });
    await sessionDb.readModels.put({
      user_id: USER,
      cache_key: "history-session:s-gone",
      kind: "history-session",
      data: {},
      request_started_at: 0,
      synced_at: "2026-08-14T00:00:00.000Z",
    });
    await markRemediationPending(USER, "s-gone");
  }

  it.each([[404], [410]])("읽기 경로의 %s 는 세션 캐시를 통째로 정리한다", async (status) => {
    await seedCachedSession();

    await expect(
      readThroughSession(USER, "s-gone", () => {
        throw new ApiError(status, "NOT_FOUND", "gone");
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(await sessionDb.sessions.get([USER, "s-gone"])).toBeUndefined();
    expect(await sessionDb.routines.get([USER, "s-gone"])).toBeUndefined();
    expect(await sessionDb.readModels.get([USER, "history-session:s-gone"])).toBeUndefined();
    expect(await isRemediationPending(USER, "s-gone")).toBe(false);
  });

  it("marker processor 의 404 도 같은 정리를 한다", async () => {
    await seedCachedSession();

    await processRemediationMarkers(USER, async () => {
      throw new ApiError(404, "NOT_FOUND", "gone");
    });

    expect(await sessionDb.sessions.get([USER, "s-gone"])).toBeUndefined();
    expect(await sessionDb.routines.get([USER, "s-gone"])).toBeUndefined();
  });

  it("terminal 뒤 오프라인 읽기가 미러를 돌려주지 않는다", async () => {
    await seedCachedSession();
    await readThroughSession(USER, "s-gone", () => {
      throw new ApiError(410, "GONE", "gone");
    }).catch(() => undefined);

    await expect(
      readThroughSession(USER, "s-gone", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("offline");
  });

  it("401 은 캐시를 지우지 않는다 — terminal 이 아니다", async () => {
    await seedCachedSession();

    await processRemediationMarkers(USER, async () => {
      throw new ApiError(401, "UNAUTHENTICATED", "no session");
    });

    expect(await sessionDb.sessions.get([USER, "s-gone"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-gone")).toBe(true);
  });
});

/** P1-3 — 연속 오프라인 편집에서 봉투가 누적되지 않으면 두 번째 편집부터 미러가 멈춘다. */
describe("연속 오프라인 편집 — local envelope 누적", () => {
  const localRow = (id: string, exerciseId: string) => ({
    id,
    exercise_id: exerciseId,
    set_no: 1,
    recommended_weight: 0,
    reason_code: "BASELINE",
  });

  async function addExercise(ids: string[], newId: string, exerciseId: string) {
    await commitRoutineSnapshot(
      USER,
      "s-1",
      ["e_bench_press", exerciseId],
      `00000000-0000-4000-8000-0000000000${ids.length}a`,
      "2026-08-14T08:00:00.000Z",
      [{ correlation_id: newId, exercise_id: exerciseId, set_no: 1 }],
      payload(
        ids.map((id, index) => localRow(id, index === 0 ? "e_bench_press" : exerciseId)),
      ) as never,
      new Set([newId]),
    );
  }

  it("add → add 연속에서 미러와 봉투가 모두 유지된다", async () => {
    await addExercise(["c-1"], "c-1", "e_bench_press");
    await addExercise(["c-1", "c-2"], "c-2", "e_face_pull");

    const mirror = await sessionDb.sessions.get([USER, "s-1"]);
    expect(mirror).toBeDefined();
    expect(new Set(mirror?.local_ids)).toEqual(new Set(["c-1", "c-2"]));
    // 두 번째 편집에서 marker 가 서면 재진입이 막힌다 — loss-0 위반이다.
    expect(await isRemediationPending(USER, "s-1")).toBe(false);
  });

  it("add → swap 에서도 유지된다", async () => {
    await addExercise(["c-1"], "c-1", "e_bench_press");
    await addExercise(["c-1", "c-3"], "c-3", "e_lat_pulldown");

    expect(await sessionDb.sessions.get([USER, "s-1"])).toBeDefined();
    expect(await isRemediationPending(USER, "s-1")).toBe(false);
  });

  it("스냅샷에서 빠진 id 는 봉투에서도 빠진다 — 무한히 커지지 않는다", async () => {
    await addExercise(["c-1"], "c-1", "e_bench_press");
    await addExercise(["c-1", "c-2"], "c-2", "e_face_pull");
    // c-1 이 빠진 스냅샷을 커밋한다.
    await commitRoutineSnapshot(
      USER,
      "s-1",
      ["e_face_pull"],
      "00000000-0000-4000-8000-0000000000bb",
      "2026-08-14T08:10:00.000Z",
      [],
      payload([localRow("c-2", "e_face_pull")]) as never,
      new Set(),
    );

    expect((await sessionDb.sessions.get([USER, "s-1"]))?.local_ids).toEqual(["c-2"]);
  });

  it("authoritative 교체는 봉투를 제거한다", async () => {
    await addExercise(["c-1"], "c-1", "e_bench_press");

    expect(await commitAuthoritativeSession(USER, "s-1", payload([serverRow()]))).toBe(true);

    expect((await sessionDb.sessions.get([USER, "s-1"]))?.local_ids).toBeUndefined();
  });
});
