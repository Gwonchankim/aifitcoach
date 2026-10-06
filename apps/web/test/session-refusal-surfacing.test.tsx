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
 * - round 2 (evaluator): the FIRST read fails and the device has no copy — still said, beside the
 *   connection notice; a screen that goes away before saying it, or is reused for another session,
 *   consumes nothing — that session says it when it is on screen again
 * "Said" is asserted as what is on screen, and the acknowledgement only after it — never as "the
 * data arrived" (an intermediate state hides every path that breaks in between).
 * - round 2 (invariants table, r2/INVARIANTS.md): what the sheet could not say is said when it
 *   closes, by the user or by a finish that succeeded; a refusal a later APPLIED write made false is
 *   never said (superseded); a new refusal with the same sentence is still said; one notice holds
 *   every pending refusal of the session; audit rows from before `notice` existed stay silent
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
const { restTimerStore } = await import("../components/session/rest-timer-store");

const NOW = new Date("2026-08-14T10:00:00.000Z");
/** The UTC midnight that turns 08-13 into an older day. */
const CLOSED = new Date("2026-08-15T00:00:01.000Z");
const EXPIRED = EDIT_WINDOW_COPY.expired;
const SET1 = "벤치프레스 1세트 기록은 저장되지 않았어요.";
const FINISH_TOO = "운동 종료도 저장되지 않았어요.";
const FINISH_ONLY = "운동 종료는 저장되지 않았어요.";

const plannedSets = (prefix: string, count = 2) =>
  Array.from({ length: count }, (_, index) => index + 1).map((n) => ({
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

/** The server applies everything it is sent. */
async function applyAsServer(body: SyncRequest): Promise<SyncResponse> {
  return {
    applied: body.mutations.map((m) => m.client_id),
    conflicts: [],
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
const alertTexts = () => screen.queryAllByRole("alert").map((alert) => alert.textContent);
/** The nameless clause: no session to name the card from, and no date to give a reason for. */
const SET_COUNT = "세트 1개 기록은 저장되지 않았어요.";

/**
 * Holds the judge's audit read (`pendingRefusals`, the only `conflicts.where("user_id")` reader)
 * until released, so a test can unmount the screen or switch its session while the judge waits.
 */
function holdAuditReads() {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (started = resolve));
  const where = sessionDb.conflicts.where.bind(sessionDb.conflicts);
  const spy = vi.spyOn(sessionDb.conflicts, "where").mockImplementation(((index: string) => {
    const clause = where(index);
    if (index !== "user_id") return clause;
    const equals = clause.equals.bind(clause);
    clause.equals = ((value: string) => {
      const collection = equals(value);
      const toArray = collection.toArray.bind(collection);
      collection.toArray = (async () => {
        spy.mockRestore(); // only the first read waits
        started();
        await gate;
        return toArray();
      }) as typeof collection.toArray;
      return collection;
    }) as typeof clause.equals;
    return clause;
  }) as typeof sessionDb.conflicts.where);
  return { waiting, release };
}

/**
 * Holds the acknowledgement write (`markRefusalsShown`, the only read-write transaction on the
 * audit table alone) until released: the text is on screen, its "shown" not yet written.
 */
function holdAcknowledgements() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const transaction = sessionDb.transaction.bind(sessionDb) as (...args: unknown[]) => unknown;
  vi.spyOn(sessionDb, "transaction").mockImplementation(((...args: unknown[]) =>
    args.length === 3 && args[0] === "rw" && args[1] === sessionDb.conflicts
      ? gate.then(() => transaction(...args))
      : transaction(...args)) as unknown as typeof sessionDb.transaction);
  return { release };
}

/** The finish commits locally, then fails on its own (the timer store): the sheet stays open. */
async function finishFailingOnItsOwn() {
  vi.spyOn(restTimerStore, "clear").mockRejectedValueOnce(new Error("timer store unavailable"));
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toBeTruthy());
  return sheet;
}

/**
 * Closes the finish sheet — and proves it closed. "계속하기" is disabled while the finish is still
 * settling, and a click on it then does nothing: the sheet's own alert would pass for the screen's.
 */
async function closeSheet(sheet: HTMLElement) {
  const close = within(sheet).getByRole("button", { name: "계속하기" }) as HTMLButtonElement;
  await waitFor(() => expect(close.disabled).toBe(false)); // the finish has settled
  fireEvent.click(close);
  expect(screen.queryByRole("dialog", { name: "운동 종료" })).toBeNull();
}

/** One screen instance shown for one session and then another — the route reuses it. */
function mountReusable(sessionId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const ui = (id: string) => (
    <QueryClientProvider client={client}>
      <SessionScreen sessionId={id} />
    </QueryClientProvider>
  );
  const view = render(ui(sessionId));
  return { show: (id: string) => view.rerender(ui(id)) };
}

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
  await expect.poll(notices).toEqual(["shown"]); // the acknowledgement follows the render
});

it("re-entry: a refusal recorded while no screen was open is said once on mount, never again", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer); // nobody is looking
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  const first = mount();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
  await expect.poll(notices).toEqual(["shown"]); // the acknowledgement follows the render
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
    await expect.poll(notices).toEqual(["shown"]); // the acknowledgement follows the render
  },
);

/**
 * Round 2 (evaluator, no product change): the moment that matters is the FIRST read. The refusal
 * is a local fact — a session that cannot be read on entry must not swallow it, and the connection
 * notice cannot stand in for it: two different facts, both on screen.
 */
it("entry while the session cannot be read and the device has no copy: the refusal is on screen beside the connection notice", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer); // nobody is looking
  expect(await sessionDb.sessions.get([DEV_USER_SCOPE, "A"])).toBeUndefined(); // no copy
  mocks.session.mockRejectedValue(new Error("GET unavailable on entry"));
  mount();
  await waitFor(() => expect(alertTexts()).toContain(SET_COUNT));
  expect(alertTexts()).toHaveLength(2); // the other one is the connection notice
  await expect.poll(notices).toEqual(["shown"]); // the acknowledgement follows the render
});

it("a screen that goes away before it has said a refusal leaves it pending; the next screen says it", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer);
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  const read = holdAuditReads();
  const first = mount();
  await act(async () => {
    await read.waiting; // the judge is reading the audit
  });
  first.unmount();
  read.release();
  await settle();
  expect(await notices()).toEqual(["pending"]);

  mount();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
  await expect.poll(notices).toEqual(["shown"]); // the acknowledgement follows the render
});

/**
 * The negative pin for the acknowledgement (coordinator, round 2): decided is not said. The judge
 * decides on a mounted screen, for this session — but the finish sheet shows another error first
 * (`finishError ?? refusal`), so the refusal is not on screen and must stay pending. Without this,
 * "shown after the render" would also pass as "shown at the decision".
 */
it("a refusal decided while the sheet shows another error stays pending until the screen says it", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  // The finish commits locally, then fails on its own (the timer store) — the sheet stays open.
  vi.spyOn(restTimerStore, "clear").mockRejectedValueOnce(new Error("timer store unavailable"));
  const first = mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toBeTruthy());
  const other = within(sheet).getByRole("alert").textContent;
  vi.setSystemTime(CLOSED);
  await act(async () => {
    await sync(refuseAsServer); // the set and the finish are refused while that error is up
  });
  await settle();
  expect(within(sheet).getByRole("alert").textContent).toBe(other);
  expect(await notices()).toEqual(["pending", "pending"]); // decided, not on screen
  first.unmount();

  mount();
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1} ${FINISH_TOO}`),
  );
  await expect.poll(notices).toEqual(["shown", "shown"]);
});

it("a screen reused for another session never shows the first session's refusal; it waits for that session", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer);
  mocks.session.mockImplementation(async (id: string) =>
    id === "A"
      ? session("A", "2026-08-13", "in_progress")
      : session("B", "2026-08-15", "scheduled"),
  );
  const read = holdAuditReads();
  const view = mountReusable("A");
  await act(async () => {
    await read.waiting; // A's judge is reading the audit
  });
  view.show("B");
  // B is today's session: A's older-day notice is gone and B's routine is up.
  await waitFor(() => expect(screen.queryByText(EXPIRED)).toBeNull());
  await screen.findByLabelText(weight(2));
  read.release();
  await settle();
  expect(alertTexts()).toEqual([]);
  expect(await notices()).toEqual(["pending"]);

  view.show("A");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1}`));
  await expect.poll(notices).toEqual(["shown"]); // the acknowledgement follows the render

  // Said once: away and back again, the same screen does not say it a second time.
  view.show("B");
  await waitFor(() => expect(screen.queryByText(EXPIRED)).toBeNull());
  view.show("A");
  await screen.findAllByText(EXPIRED); // A is up again (its header notice)
  await settle();
  expect(alertTexts()).toEqual([]);
});

/*
 * Round 2 — the empty cells of the invariants table (r2/INVARIANTS.md): 6 (two ways off the sheet),
 * 1 (no repeat when the sheet closes), 5 (superseded), 7 (a new event), 14 (old rows), 15 (all in one).
 */

it("invariant 6 — the sheet closes while another error hid the refusal: said on the screen at once", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  const sheet = await finishFailingOnItsOwn();
  vi.setSystemTime(CLOSED);
  await act(async () => {
    await sync(refuseAsServer); // the set and the finish are refused behind that error
  });
  await settle();
  expect(await notices()).toEqual(["pending", "pending"]); // decided, not on screen
  await closeSheet(sheet);
  // No sync, no re-entry: closing the sheet is enough.
  await waitFor(() => expect(alertTexts()).toEqual([`${EXPIRED} ${SET1} ${FINISH_TOO}`]));
  await expect.poll(notices).toEqual(["shown", "shown"]);
});

it("invariant 6 — the retried finish succeeds offline: the hidden refusal is said there and the summary is withdrawn", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  const sheet = await finishFailingOnItsOwn();
  vi.setSystemTime(CLOSED);
  await act(async () => {
    await sync(refuseAsServer);
  });
  await settle();
  expect(await notices()).toEqual(["pending", "pending"]);
  // The retry commits locally and the device is offline (sync → null): a local success. The
  // session is out of the window and time only moves forward — this finish will be refused too.
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() => expect(alertTexts()).toEqual([`${EXPIRED} ${SET1} ${FINISH_TOO}`]));
  expect(screen.queryByRole("heading", { name: "수고했어요" })).toBeNull();
  await expect.poll(notices).toEqual(["shown", "shown"]);
});

it("invariant 1 — said in the sheet, closed before the acknowledgement is written: not said again", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mocks.sync.mockImplementation(async () => {
    if (!(await sessionDb.outbox.toArray()).some((row) => row.entity === "session")) return null;
    vi.setSystemTime(CLOSED);
    return sync(refuseAsServer);
  });
  const acknowledgements = holdAcknowledgements();
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() =>
    expect(within(sheet).getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1} ${FINISH_TOO}`),
  );
  expect(await notices()).toEqual(["pending", "pending"]); // said; "shown" is still on its way
  await closeSheet(sheet);
  await settle();
  expect(alertTexts()).toEqual([]);
  acknowledgements.release();
  await expect.poll(notices).toEqual(["shown", "shown"]);
});

it("invariant 5 — a refusal a later write made false is never said: the retried finish was applied (superseded)", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress")); // today
  const first = mount();
  const sheet = await finishFailingOnItsOwn();
  // Refused for a reason that is not the date, behind the timer error: decided, not on screen.
  await act(async () => {
    await sync(async (body) => ({
      applied: body.mutations.filter((m) => m.entity !== "session").map((m) => m.client_id),
      conflicts: body.mutations
        .filter((m) => m.entity === "session")
        .map((m) => ({ client_id: m.client_id, entity_id: m.entity_id, reason: "stale_update" })),
      changes: [],
      planned_set_mappings: [],
      next_cursor: "v1.test",
    }));
  });
  await settle();
  expect(await notices()).toEqual(["pending"]);
  // The retry goes out online and the server applies it: the session IS finished now.
  mocks.sync.mockImplementation(() => sync(applyAsServer));
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await screen.findByRole("heading", { name: "수고했어요" });
  await settle();
  expect(screen.queryByText(FINISH_ONLY)).toBeNull();
  expect(screen.getByRole("heading", { name: "수고했어요" })).toBeTruthy();
  expect(await notices()).toEqual(["superseded"]);
  // Nor on the next screen for this session.
  first.unmount();
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "completed"));
  mount();
  await screen.findByRole("heading", { name: "수고했어요" });
  await settle();
  expect(screen.queryByText(FINISH_ONLY)).toBeNull();
  expect(screen.getByRole("heading", { name: "수고했어요" })).toBeTruthy();
});

it("invariant 7 — the same set refused again is a new event: said again, though the sentence is the same", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress")); // previous here
  mount();
  await screen.findByLabelText(weight(2));
  // The server is a day ahead; the browser still has the day open, so the set can be entered again.
  await act(async () => {
    await sync(refuseAsServer);
  });
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
  await act(async () => {
    await logSet("A", "set-1");
    await sync(refuseAsServer);
  });
  // The second refusal is its own row: it is put on screen (same words) and acknowledged.
  await expect.poll(notices).toEqual(["shown", "shown"]);
  expect(alertTexts()).toEqual([SET1]);
});

it("invariant 14 — an audit row from before `notice` existed is never surfaced", async () => {
  await sessionDb.conflicts.add({
    user_id: DEV_USER_SCOPE,
    client_id: "22222222-2222-4222-8222-222222222222",
    kind: "conflict",
    payload: { entity: "performed_set", entity_id: "set-1" },
    session_id: "A",
  });
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  await screen.findByLabelText(weight(2));
  await settle();
  expect(alertTexts()).toEqual([]);
  expect(await notices()).toEqual([undefined]);
});

it("invariant 15 — one notice holds every pending refusal of the session, and not the one a later write saved", async () => {
  // A session a day ahead: the server refuses its records until its day comes.
  for (const id of ["set-1", "set-2", "set-3"]) await logSet("A", id);
  await sync(refuseAsServer); // nobody is looking
  expect(await notices()).toEqual(["pending", "pending", "pending"]);
  vi.setSystemTime(new Date("2026-08-15T00:00:01.000Z")); // its day has come
  await logSet("A", "set-2"); // set 2 is entered again — and this time it is saved
  await sync(applyAsServer);
  mocks.session.mockResolvedValue({
    ...session("A", "2026-08-15", "in_progress"),
    planned_sets: plannedSets("set", 3),
  });
  mount();
  await waitFor(() =>
    expect(alertTexts()).toEqual(["벤치프레스 1·3세트 기록은 저장되지 않았어요."]),
  );
  // Per set, not by row order: the three were refused in one batch whose order is the outbox's
  // (same updated_at under the frozen clock, then a random client_id).
  const noticeBySet = async () =>
    Object.fromEntries(
      (await sessionDb.conflicts.toArray()).map((row) => [
        (row.payload as { entity_id: string }).entity_id,
        row.notice,
      ]),
    );
  await expect
    .poll(noticeBySet)
    .toEqual({ "set-1": "shown", "set-2": "superseded", "set-3": "shown" });
});
