// @vitest-environment jsdom
/**
 * BUG-10 — the server's refusals are never silent, and the screen never keeps claiming a finish
 * the server did not apply. Everything goes through the REAL SyncCoordinator and IndexedDB; the
 * transport answers with the server's real taxonomy (a refused set is `conflict`; a completion in
 * the same batch is `dependent_conflict`).
 *
 * The self-check axes for the single judge (one place decides what to say and whether a finish is
 * withdrawn; mount and sync events both call it; an acknowledgement marks what was said):
 * - live finishing: a set and the finish refused together are both named, in the sheet, once
 * - the session cannot be read again / the browser's day disagrees: still said
 * - re-entry: a refusal recorded while no screen was open is said on mount, once, never again
 * - mount and a sync event together: exactly once — and either alone: once, not zero
 * - another session's refusal: not here; said when that session is opened
 * - a refused routine edit is never taken for a refused finish
 * - a finish refused for any reason (an unknown one too) withdraws the summary and says so
 */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session as ApiSession, SyncRequest, SyncResponse } from "../lib/api";
import type { ResistancePlannedSet as PlannedSet } from "../components/session/cardio-read";
type Session = Omit<ApiSession, "planned_sets"> & { planned_sets: PlannedSet[] };

const mocks = vi.hoisted(() => ({ session: vi.fn(), sync: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, session: mocks.session } };
});
vi.mock("../components/session/exercise-catalog", async () => {
  const actual = await vi.importActual<typeof import("../components/session/exercise-catalog")>(
    "../components/session/exercise-catalog",
  );
  return {
    ...actual,
    fetchAllExercises: async () => [
      { id: "bench", name_ko: "벤치프레스", metric: "reps", step_kg: 2.5, primary_muscles: [] },
    ],
  };
});
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: mocks.sync };
});
const { SessionScreen } = await import("../components/session/SessionScreen");
const { sessionDb, DEV_USER_SCOPE } = await import("../components/session/session-db");
const { SyncCoordinator } = await import("../components/session/sync-coordinator");
const { useSessionLog } = await import("../components/session/session-store");
const { EDIT_WINDOW_COPY } = await import("../components/session/session-edit-rights");

const NOW = new Date("2026-08-14T10:00:00.000Z");
/** The UTC midnight that turns 08-13 into an older day. */
const CLOSED = new Date("2026-08-15T00:00:01.000Z");
const EXPIRED = EDIT_WINDOW_COPY.expired;
const SET1 = "벤치프레스 1세트 기록은 저장되지 않았어요.";
const FINISH_TOO = "운동 종료도 저장되지 않았어요.";
const FINISH_ONLY = "운동 종료는 저장되지 않았어요.";

const plannedSets = (prefix: string) =>
  [1, 2].map((n) => ({
    id: `${prefix}-${n}`,
    exercise_id: "bench",
    set_no: n,
    target_reps_low: 8,
    target_reps_high: 10,
    target_rir: 2,
    rest_sec: 90,
    recommended_weight: 60,
    recommended_reps: 9,
    reason_code: "BASELINE",
    rules_version: "2026.08.1",
    load_kind: "external",
    performed_set: null,
  })) as PlannedSet[];
const session = (id: string, scheduled_date: string, status: Session["status"]) =>
  ({
    id,
    program_id: "p",
    goal: "hypertrophy",
    status,
    scheduled_date,
    planned_sets: plannedSets(id === "A" ? "set" : id.toLowerCase()),
  }) as Session;
const clients: QueryClient[] = [];
function mount(sessionId = "A") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <SessionScreen sessionId={sessionId} />
    </QueryClientProvider>,
  );
}
const weight = (n = 1) => `벤치프레스 ${n}세트 무게, 킬로그램`;
/** Real timers drive the IDB/judge chain; only Date is faked. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
const sync = (transport: (body: SyncRequest) => Promise<SyncResponse>) =>
  new SyncCoordinator({ userId: DEV_USER_SCOPE, transport }).request();

/** The server's real taxonomy (sync.service): sets first, then the completion of that session. */
async function refuseAsServer(body: SyncRequest): Promise<SyncResponse> {
  const refusedSet = body.mutations.some((m) => m.entity === "performed_set");
  return {
    applied: [],
    conflicts: body.mutations.map((m) => ({
      client_id: m.client_id,
      entity_id: m.entity_id,
      reason: m.entity === "session" && refusedSet ? "dependent_conflict" : "conflict",
    })),
    changes: [],
    planned_set_mappings: [],
    next_cursor: "v1.test",
  };
}

async function logSet(sessionId: string, plannedSetId: string) {
  await useSessionLog.getState().begin(sessionId);
  await useSessionLog
    .getState()
    .completeSet(plannedSetId, { weight: 60, reps: 9, rir: 2, timeSec: null });
}
/** Offline finish: the sheet commits locally and the summary claims the finish. */
async function finishOffline() {
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ })); // sync → null
  await screen.findByRole("heading", { name: "수고했어요" });
}
const notices = async () => (await sessionDb.conflicts.toArray()).map((row) => row.notice);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.session.mockReset();
  mocks.sync.mockReset();
  mocks.sync.mockResolvedValue(null);
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
  vi.restoreAllMocks();
  await sessionDb.delete();
});

it("live finishing: a set and the finish refused together are both named in the sheet, once", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mocks.sync.mockImplementation(async () => {
    if (!(await sessionDb.outbox.toArray()).some((row) => row.entity === "session")) return null;
    vi.setSystemTime(CLOSED);
    return sync(refuseAsServer);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() =>
    expect(within(sheet).getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1} ${FINISH_TOO}`),
  );
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(await sessionDb.conflicts.count()).toBe(2);
  await settle();
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
});

it("a refusal is said even when the session cannot be read again", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  await screen.findByLabelText(weight(2));
  vi.setSystemTime(CLOSED);
  mocks.session.mockRejectedValue(new Error("GET unavailable after a successful sync"));
  await act(async () => {
    await sync(refuseAsServer);
  });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
});

it("the browser still believes the day is open: what was not saved is said, without a date reason", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress")); // previous here
  mount();
  await screen.findByLabelText(weight(2));
  // The server is a day ahead and refuses; the browser's clock still reads 08-14.
  await act(async () => {
    await sync(refuseAsServer);
  });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SET1));
});

it("an offline finish refused later while the session cannot be read: the claim is withdrawn everywhere", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  await finishOffline();
  vi.setSystemTime(CLOSED);
  mocks.session.mockRejectedValue(new Error("GET unavailable after a successful sync"));
  await act(async () => {
    await sync(refuseAsServer);
  });
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1} ${FINISH_TOO}`),
  );
  expect(screen.queryByRole("heading", { name: "수고했어요" })).toBeNull();
  // A reload (even offline) must not bring the finish back: the local mirror is undone too.
  const mirror = await sessionDb.sessions.get([DEV_USER_SCOPE, "A"]);
  expect((mirror?.session as { status?: string } | undefined)?.status).toBe("in_progress");
});

it.each(["stale_update", "zz_reason_no_list_knows"])(
  "a finish refused for %s still withdraws the summary and says the finish was not saved",
  async (reason) => {
    await logSet("A", "set-1");
    mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress")); // today
    mount();
    await finishOffline();
    await act(async () => {
      await sync(async (body) => ({
        applied: body.mutations.filter((m) => m.entity !== "session").map((m) => m.client_id),
        conflicts: body.mutations
          .filter((m) => m.entity === "session")
          .map((m) => ({ client_id: m.client_id, entity_id: m.entity_id, reason })),
        changes: [],
        planned_set_mappings: [],
        next_cursor: "v1.test",
      }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(FINISH_ONLY));
    expect(screen.queryByRole("heading", { name: "수고했어요" })).toBeNull();
  },
);

it("a refused routine edit is never taken for a refused finish", async () => {
  mocks.session.mockResolvedValue(session("A", "2026-08-12", "completed"));
  await sessionDb.outbox.put({
    client_id: "11111111-1111-4111-8111-111111111111",
    user_id: DEV_USER_SCOPE,
    entity: "session_routine",
    entity_id: "A",
    op: "upsert",
    updated_at: NOW.toISOString(),
    payload: { exercise_ids: ["bench"] },
    attempts: 0,
  });
  mount();
  await screen.findByRole("heading", { name: "오늘은 기록이 없어요" });
  await act(async () => {
    await sync(refuseAsServer); // the routine row: `conflict`, entity_id = the session id
  });
  await settle();
  expect(screen.queryByText(/운동 종료[는도] 저장되지 않았어요/)).toBeNull();
  expect(screen.getByRole("heading", { name: "오늘은 기록이 없어요" })).toBeTruthy();
});

it("another session's refusal is not said here; it is said when that session is opened", async () => {
  vi.setSystemTime(CLOSED);
  await logSet("B", "b-1");
  mocks.session.mockImplementation(async (id: string) =>
    id === "B"
      ? session("B", "2026-08-13", "in_progress")
      : session("A", "2026-08-15", "scheduled"),
  );
  const here = mount("A");
  await screen.findByLabelText(weight(2));
  await act(async () => {
    await sync(refuseAsServer);
  });
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(await notices()).toEqual(["pending"]);
  here.unmount();

  mount("B");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
  expect(await notices()).toEqual(["shown"]);
});

it("re-entry: a refusal recorded while no screen was open is said once on mount, never again", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer); // nobody is looking
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  const first = mount();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
  expect(await notices()).toEqual(["shown"]);
  first.unmount();

  mount();
  await screen.findAllByText(EXPIRED); // the screen is up (header notice of the older session)
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
});

/**
 * The acknowledgement pair: both callers at once must say it exactly once, and either caller
 * alone must also say it once — "nothing said" can never pass for "said once".
 */
it.each(["mount only", "sync event only", "both at once"] as const)(
  "the refusal is said exactly once — %s",
  async (when) => {
    await logSet("A", "set-1");
    vi.setSystemTime(CLOSED);
    mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
    if (when === "mount only") {
      await sync(refuseAsServer);
      mount();
    } else if (when === "sync event only") {
      mount();
      await screen.findAllByText(EXPIRED);
      await settle();
      await act(async () => {
        await sync(refuseAsServer);
      });
    } else {
      const pending = sync(refuseAsServer);
      mount();
      await act(async () => {
        await pending;
      });
    }
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
    await settle();
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    expect(await notices()).toEqual(["shown"]);
  },
);
