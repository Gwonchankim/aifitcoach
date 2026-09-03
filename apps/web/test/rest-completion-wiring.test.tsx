// @vitest-environment jsdom
/**
 * **실제로 렌더한 `SessionScreen`** 으로 통합 게이트의 배선을 검증한다.
 *
 * 게이트 단위테스트는 "규칙이 맞다"만 말한다. 그 규칙을 아무도 부르지 않아도, 시트가 관측을
 * 보고하지 않아도, 장부를 시트 안에 둬서 휴식마다 초기화돼도 전부 통과한다 —
 * T2 가 같은 함정에서 배선 테스트를 따로 세운 이유가 그것이다.
 *
 * 여기서는 사용자의 실제 흐름(세트 완료 → 휴식 → 종료 관측)을 밟고, 두 싱크가 **각각 몇 번**
 * 불렸는지 센다. 싱크는 브라우저 API 경계에서 대역화한다.
 */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannedSet, Session } from "../lib/api";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SET_1 = "aaaaaaaa-1111-4111-8111-111111111111";
const SET_2 = "aaaaaaaa-2222-4222-8222-222222222222";

/** 두 싱크를 브라우저 경계에서 센다 — 게이트가 아니라 **실제 배선**을 보려는 것이다. */
const emitForeground = vi.fn();
const notifyHidden = vi.fn(() => Promise.resolve(true));

vi.mock("../lib/rest-feedback", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/rest-feedback")>("../lib/rest-feedback");
  return { ...actual, emitRestCompleteFeedback: () => emitForeground() };
});

vi.mock("../lib/rest-notification", async () => {
  const actual = await vi.importActual<typeof import("../lib/rest-notification")>(
    "../lib/rest-notification",
  );
  return { ...actual, notifyRestComplete: () => notifyHidden() };
});

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

const SESSION_PAYLOAD = {
  id: SESSION_A,
  program_id: "p-1",
  goal: "hypertrophy",
  scheduled_date: "2026-08-14",
  status: "scheduled",
  planned_sets: [plannedSet(SET_1, 1), plannedSet(SET_2, 2)],
} as unknown as Session;

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

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      session: () => Promise.resolve(SESSION_PAYLOAD),
      exercises: () => Promise.resolve({ items: CATALOG, next_cursor: null }),
    },
  };
});

vi.mock("../components/session/exercise-catalog", () => ({
  fetchAllExercises: () => Promise.resolve(CATALOG),
}));

vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: () => Promise.resolve(null) };
});

const { SessionScreen } = await import("../components/session/SessionScreen");
const { sessionDb } = await import("../components/session/session-db");
const { useSessionLog } = await import("../components/session/session-store");

function wrapper(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

/** 화면의 가시성 상태를 손으로 정한다. 시트의 틱이 이 값을 읽어 `visibleSince` 를 만든다. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** 세트를 완료해 휴식 시트를 연다. */
async function completeFirstSet() {
  const weight = await screen.findByLabelText("벤치프레스 1세트 무게, 킬로그램");
  const reps = screen.getByLabelText("벤치프레스 1세트 횟수, 회");
  const { fireEvent } = await import("@testing-library/dom");
  fireEvent.change(weight, { target: { value: "60" } });
  fireEvent.change(reps, { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: "벤치프레스 1세트 완료 처리" }));
  await screen.findByRole("dialog", { name: /1세트 후 휴식/ });
}

/**
 * 시계는 **손으로 민다.** fake timer 를 쓰면 `findBy*` 의 대기와 200ms 틱이 서로를 굶는다
 * (실측: 시트가 열리기 전에 단언이 먼저 죽는다). 대신 `Date.now` 만 옮기고 실제 틱을 기다린다.
 */
let clock = 0;

/**
 * 휴식이 끝날 만큼 시계를 밀고 **화면이 종료를 그릴 때까지** 기다린다.
 *
 * 고정 sleep 을 쓰면 안 된다 — 200ms 틱이 부하에 밀리면 그 창을 놓쳐 clean baseline 이
 * 간헐적으로 빨개진다(실측: 독립 실행에서 StrictMode 기대 1, 실제 0). "휴식 완료" 문구는
 * 시트가 `finished` 를 실제로 관측했다는 증거라 조건으로 삼을 수 있다.
 */
/** 시트 **안에서** 종료 문구를 기다린다 — 화면 다른 곳의 같은 문구와 섞이지 않게. */
async function awaitRestFinished() {
  const sheet = await screen.findByRole("dialog", { name: /후 휴식/ });
  await waitFor(() => expect(within(sheet).getByText("휴식 완료")).toBeTruthy(), {
    timeout: 3_000,
  });
}

async function runOutTheRest() {
  clock += 91_000;
  await awaitRestFinished();
}

beforeEach(async () => {
  clock = Date.parse("2026-08-14T09:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  emitForeground.mockClear();
  notifyHidden.mockClear();
  setVisibility("visible");
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ drafts: {}, sessionId: null });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await sessionDb.delete();
});

describe("배선 — 종료 관측이 게이트를 거쳐 한 싱크에만 닿는다", () => {
  it("전경에서 끝나면 **비프만** 한 번, 알림 0", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();

    await runOutTheRest();

    expect(emitForeground).toHaveBeenCalledTimes(1);
    expect(notifyHidden).not.toHaveBeenCalled();
  });

  it("**틱이 계속 돌아도** 늘지 않는다 — 종료는 이벤트가 아니라 상태다", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();
    await runOutTheRest();

    // 재계산을 여러 번 유발한다. 종료 상태는 그대로라 매 관측마다 "0 이다"가 참이다.
    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
    }

    expect(emitForeground).toHaveBeenCalledTimes(1);
  });

  it("숨은 채 끝나면 **알림만** 한 번, 비프 0", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();

    await act(async () => {
      setVisibility("hidden");
      await Promise.resolve();
    });
    await runOutTheRest();

    expect(notifyHidden).toHaveBeenCalledTimes(1);
    expect(emitForeground).not.toHaveBeenCalled();
  });

  it("**백그라운드에서 끝난 뒤 복귀하면 둘 다 0** — 늦은 재생이 없다", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();

    // 숨는다. 숨은 동안 틱이 돌지 않는다고 보고, 복귀 시점에 처음 관측한다.
    await act(async () => {
      setVisibility("hidden");
      await Promise.resolve();
    });
    clock += 91_000;
    setVisibility("visible");
    // **관측이 실제로 일어났는지를 먼저 증명한다.** 그냥 기다렸다 0 을 단언하면 틱이 안 돈
    // 경우에도 통과해 버린다 — "휴식 완료" 가 그려졌다는 것이 관측의 증거다.
    await awaitRestFinished();

    expect(emitForeground).not.toHaveBeenCalled();
    expect(notifyHidden).not.toHaveBeenCalled();
  });

  it("StrictMode 이중 실행에도 1회", async () => {
    render(
      createElement(
        StrictMode,
        null,
        wrapper(createElement(SessionScreen, { sessionId: SESSION_A })),
      ),
    );
    await completeFirstSet();

    await runOutTheRest();

    expect(emitForeground).toHaveBeenCalledTimes(1);
  });
});

/**
 * **세션 화면을 떠났다가 돌아와도 총 1회.**
 *
 * "시트를 닫았다 같은 정체성으로 다시 열기" 는 **도달 불가**다 — 시트를 다시 여는 유일한 경로는
 * `handleComplete` 이고 그건 새 `endsAt`(= 다른 정체성)을 만든다. 시계를 되감지 않는 한 같은
 * 정체성으로 되돌아올 수 없다.
 *
 * 실제로 가능한 경로는 **라우트 이탈 후 복귀**다. 시트를 닫지 않고 화면을 떠나면 `syncMeta` 에
 * 같은 `{sessionId, plannedSetId, endsAt}` 가 남고, 돌아오면 새 게이트가 그것을 복구한다.
 * 그때 첫 관측은 **이미 끝난 상태**라 장전된 적이 없다 → 추가 신호 0. 총 1회.
 *
 * 이 경로는 장부 소유뿐 아니라 **arm 규칙과 저장분 복구 배선**을 함께 지난다.
 */
describe("배선 — 세션 화면을 떠났다 돌아와도 총 1회", () => {
  /** 복구된 시트가 틱을 여러 번 관측하도록 둔다. 음성 단언이라 짧으면 통과할 뿐 실패하지 않는다 —
   *  이 테스트가 실제로 판별하는지는 arm 가드 제거 뮤테이션(러너 27번)이 증명한다. */
  async function settleTicks() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
  }

  /**
   * 화면을 떠난다 → 같은 세션으로 새로 들어온다. 새 게이트·새 장부가 생긴다.
   *
   * `cleanup()` 으로 트리와 컨테이너를 함께 걷어낸다. `unmount()` 만 부르면 빈 컨테이너가
   * 문서에 남아 다음 렌더와 겹치고, `screen` 이 두 트리를 함께 보게 된다(실측: "휴식 완료" 2개).
   */
  async function leaveAndReturn() {
    cleanup();
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    // 복구가 저장분을 올려 시트가 다시 뜬다.
    await screen.findByRole("dialog", { name: /1세트 후 휴식/ });
  }

  it("전경에서 울린 뒤 떠났다 돌아오면 **추가 0** — 저장분은 그대로 남아 있다", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();
    await runOutTheRest();
    expect(emitForeground).toHaveBeenCalledTimes(1);

    // 시트를 닫지 않는다 — 닫으면 레코드가 지워져 같은 정체성이 사라진다.
    await leaveAndReturn();
    await settleTicks();

    expect(emitForeground).toHaveBeenCalledTimes(1);
    expect(notifyHidden).not.toHaveBeenCalled();
  }, 20_000);

  it("숨김에서 알린 뒤 떠났다 돌아오면 **추가 0**", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();

    await act(async () => {
      setVisibility("hidden");
      await Promise.resolve();
    });
    await runOutTheRest();
    expect(notifyHidden).toHaveBeenCalledTimes(1);

    await leaveAndReturn();
    await settleTicks();

    expect(notifyHidden).toHaveBeenCalledTimes(1);
    expect(emitForeground).not.toHaveBeenCalled();
  }, 20_000);

  it("**울리기 전에** 떠났다 돌아와도 정상 만료는 1회다 — 억제가 과하지 않다", async () => {
    render(wrapper(createElement(SessionScreen, { sessionId: SESSION_A })));
    await completeFirstSet();

    // 아직 돌고 있다. 여기서 떠난다.
    await leaveAndReturn();

    // 돌아온 화면이 진행 중을 관측해 다시 장전한 뒤 끝난다.
    await runOutTheRest();

    expect(emitForeground).toHaveBeenCalledTimes(1);
  }, 20_000);
});
