// @vitest-environment jsdom
/**
 * **실제로 렌더한 `SessionScreen`** 으로 지속·복구 배선을 검증한다.
 *
 * 앞선 판의 테스트는 store 와 조정자만 봤다. 그래서 `SessionScreen` 의 save/close/uncomplete/
 * 세션 종료/매핑/복구 호출을 통째로 지워도 전부 통과했다 — 헬퍼는 옳은데 아무도 부르지 않는
 * 상태를 잡지 못한다. 여기서는 사용자의 실제 흐름(체크 → 휴식 → 닫기 …)을 밟는다.
 *
 * jsdom 은 **이 파일에서만** 켠다(맨 윗줄 지시자). 나머지 40여 개 테스트의 실행 환경은 그대로다.
 */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannedSet, Session } from "../lib/api";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SET_1 = "aaaaaaaa-1111-4111-8111-111111111111";
const SET_2 = "aaaaaaaa-2222-4222-8222-222222222222";
const CORRELATION = "cccccccc-1111-4111-8111-111111111111";
const SERVER_SET = "dddddddd-1111-4111-8111-111111111111";

/** 세션 응답을 손으로 붙잡아 두기 위한 promise. 라우트 전환 지연을 재현한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function plannedSet(id: string, setNo: number): PlannedSet {
  return {
    id,
    exercise_id: "e_bench_press",
    set_no: setNo,
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
  } as unknown as PlannedSet;
}

function sessionPayload(id: string, sets: PlannedSet[]): Session {
  return {
    id,
    program_id: "p-1",
    goal: "hypertrophy",
    scheduled_date: "2026-08-14",
    status: "scheduled",
    planned_sets: sets,
  } as unknown as Session;
}

const CATALOG = [
  {
    id: "e_bench_press",
    name_ko: "벤치프레스",
    movement_pattern: "horizontal_push",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    default_step_kg: 2.5,
    equipment: "barbell",
  },
];

/** `api` 를 통째로 대역화한다 — 네트워크·서버 없이 화면 흐름만 본다. */
const sessionResponses = new Map<string, () => Promise<Session>>();
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      session: (id: string) => {
        const responder = sessionResponses.get(id);
        if (!responder) throw new Error(`no stub for ${id}`);
        return responder();
      },
      exercises: () => Promise.resolve({ items: CATALOG, next_cursor: null }),
    },
  };
});

/** 카탈로그는 별도 모듈이 모아 온다 — 화면이 이름을 그릴 수 있게 같은 값을 준다. */
vi.mock("../components/session/exercise-catalog", () => ({
  fetchAllExercises: () => Promise.resolve(CATALOG),
}));

/** 오프라인 큐를 실제로 돌리지 않는다. 이 파일의 관심사는 타이머 배선이다. */
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: () => Promise.resolve(null) };
});

const { SessionScreen } = await import("../components/session/SessionScreen");
const { PLANNED_SET_MAPPING_EVENT } = await import("../components/session/sync-coordinator");
const store = await import("../components/session/rest-timer-store");
const { sessionDb, DEV_USER_SCOPE } = await import("../components/session/session-db");
const { useSessionLog } = await import("../components/session/session-store");

const USER = DEV_USER_SCOPE;

function wrapper(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

const renderSession = (sessionId: string) =>
  render(wrapper(createElement(SessionScreen, { sessionId })));

/** 저장된 타이머 레코드(있으면). */
const storedTimer = (sessionId: string) => store.loadRestTimer(USER, sessionId, Date.now());

beforeEach(async () => {
  sessionResponses.clear();
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ drafts: {}, sessionId: null });
  sessionResponses.set(SESSION_A, () =>
    Promise.resolve(sessionPayload(SESSION_A, [plannedSet(SET_1, 1), plannedSet(SET_2, 2)])),
  );
  sessionResponses.set(SESSION_B, () =>
    Promise.resolve(sessionPayload(SESSION_B, [plannedSet(SET_1, 1)])),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 1세트를 실제로 완료한다 — 값 입력 → 완료 체크. */
async function completeFirstSet() {
  const weight = await screen.findByLabelText("벤치프레스 1세트 무게, 킬로그램");
  const reps = screen.getByLabelText("벤치프레스 1세트 횟수, 회");
  const { fireEvent } = await import("@testing-library/dom");
  fireEvent.change(weight, { target: { value: "60" } });
  fireEvent.change(reps, { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "벤치프레스 1세트 완료 처리" }));
  await screen.findByRole("dialog", { name: /1세트 후 휴식/ });
}

describe("배선 — 세트 완료가 타이머를 저장한다", () => {
  it("완료 체크 후 휴식 시트가 뜨고 **저장된 레코드가 생긴다**", async () => {
    renderSession(SESSION_A);
    await completeFirstSet();

    await waitFor(async () => {
      const saved = await storedTimer(SESSION_A);
      expect(saved).not.toBeNull();
      expect(saved!.plannedSetId).toBe(SET_1);
    });
  });

  it("휴식 종료를 누르면 시트가 닫히고 **저장된 레코드도 사라진다**", async () => {
    renderSession(SESSION_A);
    await completeFirstSet();
    await waitFor(async () => expect(await storedTimer(SESSION_A)).not.toBeNull());

    const { fireEvent } = await import("@testing-library/dom");
    fireEvent.click(screen.getByRole("button", { name: "휴식 종료" }));

    await waitFor(async () => expect(await storedTimer(SESSION_A)).toBeNull());
  });

  it("+30초를 누르면 저장된 endsAt 이 함께 늘어난다", async () => {
    renderSession(SESSION_A);
    await completeFirstSet();
    const before = await waitFor(async () => {
      const saved = await storedTimer(SESSION_A);
      expect(saved).not.toBeNull();
      return saved!;
    });

    const { fireEvent } = await import("@testing-library/dom");
    fireEvent.click(screen.getByRole("button", { name: "휴식 30초 추가" }));

    await waitFor(async () => {
      const after = await storedTimer(SESSION_A);
      expect(after!.timer.endsAt).toBeGreaterThan(before.timer.endsAt);
    });
  });
});

describe("배선 — 완료 취소는 화면에 타이머가 없어도 저장분을 지운다", () => {
  it("복구가 끝나기 전에 완료를 취소해도 그 세트 레코드가 남지 않는다", async () => {
    // 화면 state 가 비어 있는 상태를 만든다: 레코드만 미리 심고 렌더한다.
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 90_000,
    });
    useSessionLog.setState({
      sessionId: SESSION_A,
      drafts: {
        [SET_1]: {
          planned_set_id: SET_1,
          weight: "60",
          reps: "8",
          time_sec: "",
          rir: null,
          completed: true,
        } as never,
      },
    });

    renderSession(SESSION_A);
    const { fireEvent } = await import("@testing-library/dom");
    const undo = await screen.findByRole("button", { name: "벤치프레스 1세트 완료 취소" });
    fireEvent.click(undo);

    await waitFor(async () => expect(await storedTimer(SESSION_A)).toBeNull());
  });

  it("**다른 세트**의 타이머는 완료 취소로 지워지지 않는다", async () => {
    await store.saveRestTimer(USER, SESSION_A, SET_2, "벤치프레스 2세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 90_000,
    });
    useSessionLog.setState({
      sessionId: SESSION_A,
      drafts: {
        [SET_1]: {
          planned_set_id: SET_1,
          weight: "60",
          reps: "8",
          time_sec: "",
          rir: null,
          completed: true,
        } as never,
      },
    });

    renderSession(SESSION_A);
    const { fireEvent } = await import("@testing-library/dom");
    fireEvent.click(await screen.findByRole("button", { name: "벤치프레스 1세트 완료 취소" }));

    // 1세트를 취소해도 2세트 타이머는 그대로다.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await storedTimer(SESSION_A)).not.toBeNull();
  });
});

describe("배선 — 세션 종료", () => {
  it("운동을 종료하면 저장된 타이머가 정리된다", async () => {
    renderSession(SESSION_A);
    await completeFirstSet();
    await waitFor(async () => expect(await storedTimer(SESSION_A)).not.toBeNull());

    const { fireEvent } = await import("@testing-library/dom");
    fireEvent.click(screen.getByRole("button", { name: "휴식 종료" }));
    fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
    const dialog = await screen.findByRole("dialog", { name: "운동 종료" });
    fireEvent.click(within(dialog).getByRole("button", { name: /종료$/ }));

    await waitFor(async () => expect(await storedTimer(SESSION_A)).toBeNull());
  });
});

describe("배선 — 복구", () => {
  it("저장된 타이머가 있으면 마운트 후 휴식 시트가 뜬다", async () => {
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    renderSession(SESSION_A);

    expect(await screen.findByRole("dialog", { name: /1세트 후 휴식/ })).toBeTruthy();
  });

  it("만료된(그러나 stale 아님) 타이머는 0 으로 복구되고 **자동으로 닫히지 않는다**", async () => {
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() - 10_000,
    });

    renderSession(SESSION_A);

    const sheet = await screen.findByRole("dialog", { name: /1세트 후 휴식/ });
    expect(sheet.textContent).toContain("휴식 완료");
    expect(sheet.textContent).toContain("0:00");
    // 잠시 기다려도 닫히지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole("dialog", { name: /1세트 후 휴식/ })).toBeTruthy();
  });

  it("세트가 세션에 없으면 시트를 올리지 않고 그 레코드만 지운다", async () => {
    await store.saveRestTimer(USER, SESSION_A, "ps-gone", "사라진 운동 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    renderSession(SESSION_A);
    await screen.findByRole("heading", { name: "벤치프레스" });

    await waitFor(async () => expect(await storedTimer(SESSION_A)).toBeNull());
    expect(screen.queryByRole("dialog", { name: /휴식/ })).toBeNull();
  });
});

describe("배선 — A→B 라우트 전환 경합 (질의 지연)", () => {
  it("A 의 세션 질의가 늦게 끝나도 **B 화면에 A 타이머가 올라오지 않는다**", async () => {
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    const gate = deferred<Session>();
    sessionResponses.set(SESSION_A, () => gate.promise);

    const view = renderSession(SESSION_A);
    // A 질의가 아직 안 끝난 채로 B 로 이동한다.
    view.rerender(wrapper(createElement(SessionScreen, { sessionId: SESSION_B })));
    await screen.findByRole("heading", { name: "벤치프레스" });

    // 이제야 A 응답이 도착한다.
    await act(async () => {
      gate.resolve(sessionPayload(SESSION_A, [plannedSet(SET_1, 1), plannedSet(SET_2, 2)]));
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // B 는 제 타이머가 없으므로 시트가 없어야 한다.
    expect(screen.queryByRole("dialog", { name: /휴식/ })).toBeNull();
  });

  it("B→A 로 돌아오면 A 타이머를 **새 표로** 다시 복구한다", async () => {
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    const view = renderSession(SESSION_A);
    expect(await screen.findByRole("dialog", { name: /1세트 후 휴식/ })).toBeTruthy();

    view.rerender(wrapper(createElement(SessionScreen, { sessionId: SESSION_B })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /휴식/ })).toBeNull());

    view.rerender(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    expect(await screen.findByRole("dialog", { name: /1세트 후 휴식/ })).toBeTruthy();
  });
});

describe("배선 — 숨김 상태 알림은 한 타이머당 한 번", () => {
  /** 숨겨진 탭 + 사전 허용 + 서비스워커 등록을 갖춘 환경. */
  function grantedHiddenEnvironment() {
    const shown: string[] = [];
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted" },
    });
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: () =>
          Promise.resolve({
            showNotification: (title: string) => {
              shown.push(title);
              return Promise.resolve();
            },
          }),
      },
    });
    return shown;
  }

  it("틱·focus·pageshow 가 여러 번 와도 알림은 정확히 1회다", async () => {
    const shown = grantedHiddenEnvironment();
    // 이미 끝난 타이머를 복구시켜 종료 상태를 곧바로 만든다.
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() - 1_000,
    });

    renderSession(SESSION_A);
    await screen.findByRole("dialog", { name: /1세트 후 휴식/ });
    await waitFor(() => expect(shown.length).toBe(1));

    // 재계산을 여러 번 유발한다 — 종료 상태는 그대로라 매번 "0 이다"가 참이다.
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    }

    expect(shown).toEqual(["휴식이 끝났어요"]);
  });

  it("화면이 보이는 상태면 알리지 않는다", async () => {
    const shown = grantedHiddenEnvironment();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await store.saveRestTimer(USER, SESSION_A, SET_1, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() - 1_000,
    });

    renderSession(SESSION_A);
    await screen.findByRole("dialog", { name: /1세트 후 휴식/ });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(shown).toEqual([]);
  });
});

describe("배선 — 오프라인 세트 id 승격", () => {
  /** 오프라인 추가 세트는 correlation id 를 그대로 planned-set id 로 쓴다 — 세션에도 그렇게 들어 있다. */
  beforeEach(() => {
    sessionResponses.set(SESSION_A, () =>
      Promise.resolve(
        sessionPayload(SESSION_A, [plannedSet(CORRELATION, 1), plannedSet(SET_2, 2)]),
      ),
    );
  });

  it("매핑이 오면 저장된 타이머의 세트 id 도 서버 id 로 옮겨간다", async () => {
    await store.saveRestTimer(USER, SESSION_A, CORRELATION, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    renderSession(SESSION_A);
    await screen.findByRole("heading", { name: "벤치프레스" });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PLANNED_SET_MAPPING_EVENT, {
          detail: [
            {
              correlation_id: CORRELATION,
              planned_set_id: SERVER_SET,
              planned_set: plannedSet(SERVER_SET, 1),
            },
          ],
        }),
      );
      await Promise.resolve();
    });

    await waitFor(async () => {
      const saved = await store.loadRestTimer(USER, SESSION_A, Date.now());
      expect(saved).not.toBeNull();
      expect(saved!.plannedSetId).toBe(SERVER_SET);
    });
  });

  it("매핑 대상이 아닌 세트의 타이머는 그대로 둔다", async () => {
    await store.saveRestTimer(USER, SESSION_A, SET_2, "벤치프레스 2세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });

    renderSession(SESSION_A);
    await screen.findByRole("heading", { name: "벤치프레스" });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PLANNED_SET_MAPPING_EVENT, {
          detail: [
            {
              correlation_id: CORRELATION,
              planned_set_id: SERVER_SET,
              planned_set: plannedSet(SERVER_SET, 1),
            },
          ],
        }),
      );
      await Promise.resolve();
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    const saved = await store.loadRestTimer(USER, SESSION_A, Date.now());
    expect(saved!.plannedSetId).toBe(SET_2);
  });
});
