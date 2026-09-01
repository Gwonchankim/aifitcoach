/**
 * F-4b 재리뷰 fixup — **화면 캐시도 같은 경계를 지난다.**
 *
 * Dexie 미러와 marker 가 아무리 안전해도 TanStack Query 캐시가 fail-open 이면 사용자는
 * unsafe 처방을 그대로 본다. `fetchQuery` 는 **성공 응답을 predicate 보다 먼저** 캐시에 넣기 때문에
 * 그 자체가 우회로였다(독립 재리뷰 P1-1). 여기서는 **실제 QueryClient** 로 그걸 확인한다.
 */
import "fake-indexeddb/auto";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session, SyncResponse } from "../lib/api";
import { mappedSession, refetchAuthoritativeSession } from "../components/session/SessionScreen";
import { DEV_USER_SCOPE, isRemediationPending, sessionDb } from "../components/session/session-db";

const SESSION_ID = "s-1";

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

const session = (rows: unknown[]) =>
  ({ id: SESSION_ID, status: "scheduled", planned_sets: rows }) as unknown as Session;

let queryClient: QueryClient;

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

const cached = () => queryClient.getQueryData<Session>(["session", SESSION_ID]);

describe("edit-error refetch — validate before cache", () => {
  it("safe 응답만 캐시에 들어간다", async () => {
    const payload = session([serverRow()]);

    await expect(
      refetchAuthoritativeSession(queryClient, SESSION_ID, async () => payload),
    ).resolves.toEqual(payload);
    expect(cached()).toEqual(payload);
  });

  it.each([
    ["unsafe verdict", session([serverRow({ assistance_safety_status: "unsafe" })])],
    ["load_kind 누락", session([{ ...serverRow(), load_kind: undefined }])],
    ["planned_sets 없음", { id: SESSION_ID, status: "scheduled" } as unknown as Session],
  ])("%s 는 캐시에 남지 않는다", async (_label, payload) => {
    await expect(
      refetchAuthoritativeSession(queryClient, SESSION_ID, async () => payload),
    ).resolves.toBeNull();

    // 여기가 P1-1 이 지적한 지점이다 — 캐시에 한 줄이라도 들어가면 화면에 그대로 뜬다.
    expect(cached()).toBeUndefined();
    expect(await sessionDb.sessions.get([DEV_USER_SCOPE, SESSION_ID])).toBeUndefined();
    expect(await isRemediationPending(DEV_USER_SCOPE, SESSION_ID)).toBe(true);
  });

  it("거절해도 기존 safe 캐시를 덮어쓰지 않는다", async () => {
    const safe = session([serverRow()]);
    await refetchAuthoritativeSession(queryClient, SESSION_ID, async () => safe);

    await refetchAuthoritativeSession(queryClient, SESSION_ID, async () =>
      session([serverRow({ assistance_safety_status: "unsafe" })]),
    );

    expect(cached()).toEqual(safe);
  });

  it("네트워크 실패는 캐시를 건드리지 않는다", async () => {
    await expect(
      refetchAuthoritativeSession(queryClient, SESSION_ID, () =>
        Promise.reject(new Error("offline")),
      ),
    ).resolves.toBeNull();
    expect(cached()).toBeUndefined();
  });
});

describe("query mapping — 처방은 거르고 identity 는 옮긴다", () => {
  const correlationId = "corr-1";
  const serverId = "ps-server";
  const local = session([
    { id: correlationId, exercise_id: "e_bench_press", set_no: 1, recommended_weight: 0 },
  ]);

  const mapping = (planned: Record<string, unknown>) =>
    [
      { correlation_id: correlationId, planned_set_id: serverId, planned_set: planned },
    ] as unknown as SyncResponse["planned_set_mappings"];

  it("safe 매핑은 처방까지 반영한다", () => {
    const next = mappedSession(local, mapping(serverRow({ id: serverId })));
    expect(next.planned_sets[0]).toMatchObject({ id: serverId, recommended_weight: 20 });
  });

  it("unsafe 매핑은 처방을 버리되 **id 는 서버 것으로** 바꾼다", () => {
    const next = mappedSession(
      local,
      mapping(serverRow({ id: serverId, assistance_safety_status: "unsafe" })),
    );

    // draft·outbox 는 이미 server id 를 쓴다. 화면만 correlation 에 남으면 기록이 사라진다(P1-2).
    expect(next.planned_sets[0].id).toBe(serverId);
    expect(next.planned_sets[0].recommended_weight).toBe(0);
    expect(next.planned_sets[0].assistance_safety_status).toBeUndefined();
  });

  it("매핑이 없으면 그대로 둔다", () => {
    expect(mappedSession(local, [] as SyncResponse["planned_set_mappings"])).toBe(local);
  });
});
