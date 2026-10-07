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
import { alertsDrawn } from "./support/alerts-drawn";
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
      { id: "squat", name_ko: "스쿼트", metric: "reps", step_kg: 2.5, primary_muscles: [] },
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
/** The module itself, to hold the judge's audit read (round 3, as the evaluator reproduced it). */
const sessionDbModule = await import("../components/session/session-db");
const { SyncCoordinator, SYNC_RESPONSE_EVENT } =
  await import("../components/session/sync-coordinator");
const { useSessionLog } = await import("../components/session/session-store");
const { EDIT_WINDOW_COPY } = await import("../components/session/session-edit-rights");
/** The module itself, to act between the judge's check and its notice (round 3, axis re-scan). */
const editRightsModule = await import("../components/session/session-edit-rights");
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
/** The pain score the finish sheet will send: the chip pressed, if any. */
function pressedPain(sheet: HTMLElement): number | null {
  const label = within(sheet)
    .queryAllByRole("button", { pressed: true })
    .map((chip) => chip.getAttribute("aria-label") ?? "")
    .find((name) => /^통증 \d+점$/.test(name));
  return label ? Number(label.replace(/\D/g, "")) : null;
}
/**
 * Sets the finish sheet's pain report to exactly this. The sheet stays mounted between openings and
 * keeps its selection: a retry with no chip touched still sends the pain chosen before.
 */
function choosePain(sheet: HTMLElement, pain: number | null) {
  const before = pressedPain(sheet);
  if (before !== null && before !== pain)
    fireEvent.click(within(sheet).getByRole("button", { name: `통증 ${before}점` }));
  if (pain !== null && before !== pain)
    fireEvent.click(within(sheet).getByRole("button", { name: `통증 ${pain}점` }));
  expect(pressedPain(sheet)).toBe(pain); // what this finish will send
}
/** Finishes from the sheet — with exactly this pain report, none by default (sync → null). */
async function finishOffline(pain?: number) {
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  choosePain(sheet, pain ?? null);
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await screen.findByRole("heading", { name: "수고했어요" });
}
/** BUG-10 R5 (총괄 승인): a refused finish's pain report, on a session the server holds finished. */
const PAIN_ONLY = "통증 기록은 저장되지 않았어요.";
const PAIN_TOO = "통증 기록도 저장되지 않았어요.";
const notices = async () => (await sessionDb.conflicts.toArray()).map((row) => row.notice);
const alertTexts = () => screen.queryAllByRole("alert").map((alert) => alert.textContent);
/** The nameless clause: no session to name the card from, and no date to give a reason for. */
const SET_COUNT = "세트 1개 기록은 저장되지 않았어요.";

/**
 * Holds the judge's audit read (`standingRefusals`, the only `conflicts.where("user_id")` reader)
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
 * audit table alone) until released: the text is on screen, its "shown" not yet written. `waiting`:
 * the acknowledgement HAS reached the hold — the test's premise, awaited, so a hold that no longer
 * catches it fails instead of passing without the race it is there for (총괄 R6).
 */
function holdAcknowledgements() {
  let release!: () => void;
  let caught!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (caught = resolve));
  const transaction = sessionDb.transaction.bind(sessionDb) as (...args: unknown[]) => unknown;
  vi.spyOn(sessionDb, "transaction").mockImplementation(((...args: unknown[]) => {
    if (!(args.length === 3 && args[0] === "rw" && args[1] === sessionDb.conflicts))
      return transaction(...args);
    caught();
    return gate.then(() => transaction(...args));
  }) as unknown as typeof sessionDb.transaction);
  return { waiting, release };
}

/**
 * Holds the judge's audit read (`standingRefusals`) twice: the first judge AFTER it has read (it
 * has said nothing yet), and the next one — the judge a superseding response wakes — BEFORE it
 * reads. Releasing the first alone lets what it decides be drawn on its own: otherwise `act` puts
 * that render and the next judge's rewrite in one batch, and a false notice drawn for a moment —
 * which a browser shows and a screen reader announces — would never be seen here.
 */
function holdJudgeReads() {
  const read = sessionDbModule.standingRefusals;
  let reached!: (rows: Awaited<ReturnType<typeof read>>) => void;
  let releaseFirst!: () => void;
  let releaseNext!: () => void;
  const entered = new Promise<Awaited<ReturnType<typeof read>>>((resolve) => (reached = resolve));
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const next = new Promise<void>((resolve) => (releaseNext = resolve));
  vi.spyOn(sessionDbModule, "standingRefusals")
    .mockImplementationOnce(async (...args) => {
      const rows = await read(...args); // the judge HAS read …
      reached(rows);
      await first; // … and has not said anything yet
      return rows;
    })
    .mockImplementationOnce(async (...args) => {
      await next;
      return read(...args);
    });
  return { entered, releaseFirst, releaseNext };
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

const APPEND = "00000000-0000-4000-8000-000000000100";
const PROVISIONAL = "00000000-0000-4000-8000-000000000101";
/** Today's session whose second set was appended here and is not acknowledged yet. */
async function sessionWithPendingAppend() {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const source = {
    ...plannedSets("set", 1)[0],
    id: "00000000-0000-4000-8000-000000000011",
    source_revision: "fixture-append-source",
    correlation_id: null,
    append_eligibility: {
      version: 1 as const,
      source_revision: "fixture-append-source",
      cohort_revision: "fixture-cohort",
      status: "allowed" as const,
      reason: null,
    },
    confidence: 0.3,
    recommendation_state: "ready" as const,
    assistance_provenance: null,
    assistance_safety_status: null,
    recommended_action: null,
    recommendation_gate: "ready" as const,
  };
  const server = { ...session(sessionId, "2026-08-14", "in_progress"), planned_sets: [source] };
  await sessionDb.sessions.put({
    user_id: DEV_USER_SCOPE,
    session_id: sessionId,
    session: server,
    updated_at: NOW.toISOString(),
  });
  const { commitSessionSetAppend } = await import("../components/session/session-set-append-db");
  await commitSessionSetAppend(
    { user_id: DEV_USER_SCOPE, session_id: sessionId },
    {
      exercise_id: "bench",
      today: server.scheduled_date,
      generation: 0,
      client_id: APPEND,
      correlation_id: PROVISIONAL,
      updated_at: NOW.toISOString(),
    },
  );
  mocks.session.mockResolvedValue(server);
  return { sessionId, source };
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
  delete (document as { visibilityState?: unknown }).visibilityState;
  delete (document as { hidden?: unknown }).hidden;
  await sessionDb.delete();
});

/** The page goes to the background (another app in front, the screen off) or comes back. */
function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

/*
 * The probe itself (diagnosis row 12: a probe's "not observed" is evidence only once it has been
 * seen to report the thing). Positive control: a false sentence is deliberately put into an alert
 * already on screen and taken back at once — in place, the way React rewrites a text it rendered,
 * and by a node swapped inside it — and `alertsDrawn` must report it. Both within one observer
 * batch, as two renders in one `act` flush would land.
 */
it.each([
  [
    "in place (the text node's value)",
    (alert: Element, text: string) => {
      const node = alert.firstChild!;
      expect(node.nodeType).toBe(Node.TEXT_NODE); // React's own text node
      const kept = node.nodeValue;
      node.nodeValue = text;
      node.nodeValue = kept;
    },
  ],
  [
    "by a node swapped inside it",
    (alert: Element, text: string) => {
      const kept = [...alert.childNodes];
      alert.replaceChildren(document.createTextNode(text));
      alert.replaceChildren(...kept);
    },
  ],
])(
  "alertsDrawn (positive control) — a false sentence put into an alert on screen and taken back at once is reported: %s",
  async (_, putAndTakeBack) => {
    await logSet("A", "set-1");
    await sync(refuseAsServer);
    mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
    mount();
    await waitFor(() => expect(alertTexts()).toEqual([SET1]));
    await settle();
    const drawn = alertsDrawn();
    await settle();
    expect(drawn.texts).toEqual([]); // an alert left as it is: nothing reported
    const FALSE = "벤치프레스 2세트 기록은 저장되지 않았어요."; // set 2 was never refused
    putAndTakeBack(screen.getByRole("alert"), FALSE);
    await settle();
    drawn.stop();
    expect(drawn.texts).toEqual([FALSE, SET1]);
    expect(alertTexts()).toEqual([SET1]); // the screen is as it was: only the probe saw it
  },
);

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
  // 5c: the re-read failed — it changes nothing; the refusal is said from the refusal itself, and
  // stays said once the re-read has come back (the re-read is not a gate).
  await settle();
  expect(screen.getByRole("alert").textContent).toBe(`${EXPIRED} ${SET1} ${FINISH_TOO}`);
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
    // 5c: the re-read says the session is not finished — the refusal stays true, and stays said
    // once the re-read has come back.
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(FINISH_ONLY);
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

/*
 * The third way off the sheet: no click and no finish success — the coordinator acknowledges the
 * appended set and its completion, and the screen closes the sheet itself (the append reconcile).
 * The batches are constructed to put a refusal behind the sheet at that moment: a real server
 * refusing this session's set for its date would refuse the pending append for the same date
 * (`readonly`), and there would be no acknowledgement. What this pins is the mechanism — that this
 * close goes through the state the re-judge watches.
 */
it("invariant 6 — the append completion is acknowledged and closes the sheet: the hidden refusal is said there", async () => {
  const { sessionId, source } = await sessionWithPendingAppend();
  mount(sessionId);
  await screen.findByLabelText(weight(2)); // the appended set is on the card
  await act(async () => {
    await logSet(sessionId, source.id);
  });
  fireEvent.click(screen.getByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  // The completion waits for the appended set to be acknowledged; the sheet says so.
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toBeTruthy());
  const waiting = within(sheet).getByRole("alert").textContent;
  expect((await sessionDb.outbox.toArray()).find((row) => row.entity === "session")).toEqual(
    expect.objectContaining({
      append_dependencies: expect.objectContaining({ session_id: sessionId }),
    }),
  );
  // A batch refuses the logged set and leaves the append and its completion unanswered.
  await act(async () => {
    await sync(async (body) => ({
      applied: [],
      conflicts: body.mutations
        .filter((m) => m.entity === "performed_set")
        .map((m) => ({ client_id: m.client_id, entity_id: m.entity_id, reason: "conflict" })),
      changes: [],
      planned_set_mappings: [],
      next_cursor: "v1.test",
    }));
  });
  await settle();
  expect(within(sheet).getByRole("alert").textContent).toBe(waiting); // behind the waiting notice
  expect(await notices()).toEqual(["pending"]);
  // The appended set and the completion are acknowledged: the screen closes the sheet itself.
  await act(async () => {
    await sync(async (body) => ({
      applied: body.mutations.map((m) => m.client_id),
      conflicts: [],
      changes: [],
      planned_set_mappings: [
        {
          correlation_id: PROVISIONAL,
          planned_set_id: "00000000-0000-4000-8000-000000000500",
          planned_set: {
            ...source,
            id: "00000000-0000-4000-8000-000000000500",
            set_no: 2,
            correlation_id: PROVISIONAL,
          },
        },
      ],
      next_cursor: "v1.test",
    }));
  });
  await screen.findByRole("heading", { name: "수고했어요" });
  expect(screen.queryByRole("dialog", { name: "운동 종료" })).toBeNull();
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
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
  await acknowledgements.waiting; // its "shown" is on its way, and held
  expect(await notices()).toEqual(["pending", "pending"]); // said; "shown" is still on its way
  await closeSheet(sheet);
  await settle();
  expect(alertTexts()).toEqual([]);
  acknowledgements.release();
  await expect.poll(notices).toEqual(["shown", "shown"]);
});

it("invariant 5a — a refusal a strictly later write made false is never said: the retried finish was applied (superseded)", async () => {
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
  // The retry comes after the refused attempt (strictly later — a tie would be said, 5a), goes out
  // online and the server applies it: the session IS finished now.
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
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

/*
 * Round 3 (evaluator R3) — invariant 5 split. 5a: only a STRICTLY later applied write supersedes a
 * refusal; the same instant or an unknown order is said. 5b: whether a refusal is still true is
 * decided when it is said — before it goes on screen and again when its "shown" is written — never
 * from what was read earlier. The writes compared are this device's own outbox rows (one clock).
 */

/** The server's real answer (pinned by sync-replay-ack-only.spec): `applied[a] + conflicts[b]`. */
const answer =
  (applied: string, refused: { client_id: string; entity_id: string }) => async () => ({
    applied: [applied],
    conflicts: [{ client_id: refused.client_id, entity_id: refused.entity_id, reason: "conflict" }],
    changes: [],
    planned_set_mappings: [],
    next_cursor: "v1.test",
  });
/** A second write of set-1 at the current (fake) time — a new outbox row beside the first. */
async function editSet1(weight: number) {
  const [first] = await sessionDb.outbox.toArray();
  await useSessionLog.getState().completeSet("set-1", { weight, reps: 10, rir: 2, timeSec: null });
  const second = (await sessionDb.outbox.toArray()).find(
    (row) => row.client_id !== first.client_id,
  );
  expect(second).toBeDefined();
  return { first, second: second! };
}

it("invariant 5a — an older write whose ACK was lost never silences a newer refused edit of the same set", async () => {
  await logSet("A", "set-1"); // applied by the server; its ACK never reached the device
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  const { first: older, second: newer } = await editSet1(65); // the user's newer value
  expect(Date.parse(newer.updated_at)).toBeGreaterThan(Date.parse(older.updated_at));
  await sync(answer(older.client_id, newer));
  expect(await notices()).toEqual(["pending"]); // the newer value was NOT saved: not superseded
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  mount();
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
});

it("invariant 5a — a write applied at the same instant as the refused one leaves the order unknown: said", async () => {
  await logSet("A", "set-1");
  const { first, second } = await editSet1(65); // the frozen clock: the same instant
  expect(second.updated_at).toBe(first.updated_at);
  await sync(answer(first.client_id, second));
  expect(await notices()).toEqual(["pending"]);
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  mount();
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
});

it("invariant 5a — a genuinely newer applied edit supersedes the earlier refused attempt (positive control)", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  const { first: earlier, second: later } = await editSet1(65);
  await sync(answer(later.client_id, earlier));
  expect(await notices()).toEqual(["superseded"]);
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  mount();
  await screen.findByLabelText(weight(2));
  await settle();
  expect(alertTexts()).toEqual([]);
});

it("invariant 5b — a refusal superseded after the judge read it is not said, and is not turned back to shown", async () => {
  await logSet("A", "set-1");
  await sync(refuseAsServer);
  expect(await notices()).toEqual(["pending"]);
  const judge = holdJudgeReads();
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  mount();
  let read: unknown[] = [];
  await act(async () => {
    read = await judge.entered;
  });
  expect(read).toHaveLength(1); // the judge HAS read the row
  // Meanwhile a strictly later write of the same set is applied.
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  await act(async () => {
    await logSet("A", "set-1");
    await sync(applyAsServer);
  });
  expect(await notices()).toEqual(["superseded"]);
  const drawn = alertsDrawn();
  judge.releaseFirst();
  await settle();
  // "Not said" is never drawn — not drawn and then rewritten away by the judge the superseding
  // response woke (the end state alone cannot tell the two apart).
  expect(drawn.texts).toEqual([]);
  judge.releaseNext();
  await settle();
  drawn.stop();
  expect(drawn.texts).toEqual([]);
  expect(alertTexts()).toEqual([]);
  expect(await notices()).toEqual(["superseded"]);
});

it("invariant 5b — of two refusals the judge read, one is superseded before it speaks: the notice holds only the one still true", async () => {
  for (const id of ["set-1", "set-2"]) await logSet("A", id);
  await sync(refuseAsServer);
  expect(await notices()).toEqual(["pending", "pending"]);
  const judge = holdJudgeReads();
  mocks.session.mockResolvedValue({
    ...session("A", "2026-08-14", "in_progress"),
    planned_sets: plannedSets("set", 3), // set 3 is still ahead: the routine, not the summary
  });
  mount();
  let read: unknown[] = [];
  await act(async () => {
    read = await judge.entered;
  });
  expect(read).toHaveLength(2); // the judge HAS read both
  // Meanwhile set 1 is saved by a strictly later write.
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  await act(async () => {
    await logSet("A", "set-1");
    await sync(applyAsServer);
  });
  const drawn = alertsDrawn();
  judge.releaseFirst();
  await settle();
  // It says what is true when it speaks — set 2 — and never set 1, not even for a moment.
  const SET2 = "벤치프레스 2세트 기록은 저장되지 않았어요.";
  expect(drawn.texts).toEqual([SET2]);
  judge.releaseNext();
  await settle();
  drawn.stop();
  expect(drawn.texts).toEqual([SET2]);
  expect(alertTexts()).toEqual([SET2]);
  await expect.poll(perSet).toEqual({ "set-1": "superseded", "set-2": "shown" });
});

it("invariant 5b — a refusal that turns false while its notice is being acknowledged is taken back, and stays superseded", async () => {
  await logSet("A", "set-1");
  await sync(refuseAsServer);
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  const acknowledgements = holdAcknowledgements();
  mount();
  await waitFor(() => expect(alertTexts()).toEqual([SET1])); // on screen; its "shown" is held
  await acknowledgements.waiting;
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  await act(async () => {
    await logSet("A", "set-1");
    await sync(applyAsServer);
  });
  expect(await notices()).toEqual(["superseded"]);
  acknowledgements.release();
  await waitFor(() => expect(alertTexts()).toEqual([])); // taken back: it is not true any more
  await settle();
  expect(await notices()).toEqual(["superseded"]); // never turned back to shown
});

it("invariant 5b — part of a notice turns false while it is being acknowledged: nothing is marked, and what is still true is said and marked once", async () => {
  for (const id of ["set-1", "set-2"]) await logSet("A", id);
  await sync(refuseAsServer);
  mocks.session.mockResolvedValue({
    ...session("A", "2026-08-14", "in_progress"),
    planned_sets: plannedSets("set", 3), // set 3 is still ahead: the routine, not the summary
  });
  const acknowledgements = holdAcknowledgements();
  mount();
  await waitFor(() =>
    expect(alertTexts()).toEqual(["벤치프레스 1·2세트 기록은 저장되지 않았어요."]),
  ); // on screen; its "shown" is held
  await acknowledgements.waiting;
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  await act(async () => {
    await logSet("A", "set-2");
    await sync(applyAsServer);
  });
  acknowledgements.release();
  await waitFor(() => expect(alertTexts()).toEqual([SET1])); // only what is still true
  // Set 1 was on screen the whole time, but its "shown" was never written with the false part:
  // it is said again on its own and marked — once — so a re-entry does not say it a second time.
  await expect.poll(perSet).toEqual({ "set-1": "shown", "set-2": "superseded" });
  cleanup();
  mount();
  await screen.findByLabelText(weight(3));
  await settle();
  expect(alertTexts()).toEqual([]);
});

/*
 * Round 3 (evaluator R3) — invariant 2, tightened: not consumed without a PERCEIVABLE render. Not
 * perceivable: outside the viewport (→ sticky), inside an `inert` subtree (→ held while a modal is
 * up). An alert inside `inert` is not announced, and is not announced later when `inert` lifts.
 */
it("invariant 2 — a refusal that arrives while the rest sheet makes the screen inert waits, and is said when the sheet closes", async () => {
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  mount();
  await screen.findByLabelText(weight(1));
  fireEvent.click(screen.getByRole("button", { name: "벤치프레스 1세트 완료 처리" }));
  const rest = await screen.findByRole("dialog", { name: "벤치프레스 1세트 후 휴식" });
  const drawn = alertsDrawn();
  await act(async () => {
    await sync(refuseAsServer);
  });
  await settle();
  drawn.stop();
  const inert = [...document.querySelectorAll('[role="alert"]')].filter((el) =>
    el.closest("[inert]"),
  );
  expect(inert.map((el) => el.textContent)).toEqual([]); // nothing is put behind the sheet
  expect(drawn.texts).toEqual([]); // not even for a moment (drawn, then taken back)
  expect(await notices()).toEqual(["pending"]); // and nothing is consumed
  fireEvent.click(within(rest).getByRole("button", { name: "휴식 종료" }));
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
});

it("invariant 2 — held behind the rest sheet, then the screen turns to the connection notice (no sheet, no inert): said there", async () => {
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress"));
  mount();
  await screen.findByLabelText(weight(1));
  fireEvent.click(screen.getByRole("button", { name: "벤치프레스 1세트 완료 처리" }));
  await screen.findByRole("dialog", { name: "벤치프레스 1세트 후 휴식" });
  await act(async () => {
    await sync(refuseAsServer);
  });
  await settle();
  expect(await notices()).toEqual(["pending"]); // held: the screen is inert behind the sheet
  // The session cannot be read again and the device has no copy: the error view replaces the
  // screen. A rest timer is still set, but nothing is over this view — it is perceivable.
  await sessionDb.sessions.clear();
  mocks.session.mockRejectedValue(new Error("GET unavailable"));
  await act(async () => {
    await clients[0].refetchQueries({ queryKey: ["session", "A"] });
  });
  await screen.findByRole("button", { name: "다시 불러오기" });
  expect(screen.queryByRole("dialog", { name: "벤치프레스 1세트 후 휴식" })).toBeNull();
  await waitFor(() => expect(alertTexts()).toContain(SET1));
  await expect.poll(notices).toEqual(["shown"]);
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

it("invariant 14 — an audit row from before `notice` existed is not surfaced inside another refusal's notice either", async () => {
  await sessionDb.conflicts.add({
    user_id: DEV_USER_SCOPE,
    client_id: "22222222-2222-4222-8222-222222222222",
    kind: "conflict",
    payload: { entity: "performed_set", entity_id: "set-2" },
    session_id: "A",
  });
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress")); // previous here
  mount();
  await screen.findByLabelText(weight(2));
  // A new event in the same session: its notice holds what is still true — and the old row is
  // not something this screen can say truthfully, whatever it says about set 2.
  await act(async () => {
    await logSet("A", "set-1");
    await sync(refuseAsServer);
  });
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(async () => (await notices()).sort()).toEqual(["shown", undefined]);
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

/*
 * Round 3, the axis re-scan (총괄 결정 2026-10-07): "said" (`shown`) is not "done". Two axes, kept
 * apart — SAID: the notice was put on a perceivable screen; STILL TRUE: no strictly later write of
 * the same fact was applied since. A notice holds every refusal of the session that is still true,
 * said before or not (15); a notice is raised only for a new event (7); a strictly later applied
 * write makes a refusal false whether or not it was said — the notice on screen is rewritten from
 * what is still true, or taken back when nothing is (5a·5b). A hidden page is the third place a
 * render is not perceivable (2).
 */
const perSet = async () =>
  Object.fromEntries(
    (await sessionDb.conflicts.toArray()).map((row) => [
      (row.payload as { entity_id: string }).entity_id,
      row.notice,
    ]),
  );

/** The server refuses this device's finish (`stale_update`) and applies everything else. */
const finishRefusedOnly = async (body: SyncRequest): Promise<SyncResponse> => ({
  applied: body.mutations.filter((m) => m.entity !== "session").map((m) => m.client_id),
  conflicts: body.mutations
    .filter((m) => m.entity === "session")
    .map((m) => ({ client_id: m.client_id, entity_id: m.entity_id, reason: "stale_update" })),
  changes: [],
  planned_set_mappings: [],
  next_cursor: "v1.test",
});

/*
 * With a pain report (총괄 R5 (i), the same rule for this source): a later finish makes the earlier
 * refused one false only for what the later one saved. Without pain it sends no pain at all (`{}`):
 * the server's pain is neither set nor cleared — the first pain report was never saved, nor
 * replaced, so "not saved" is still true of it. With pain, the latest report is saved.
 */
it.each([
  ["", undefined, undefined, [], "superseded"],
  [
    " — both carried a pain report: the latest one is saved, nothing is left",
    3,
    4,
    [],
    "superseded",
  ],
  [
    " — only the first carried a pain report: that pain is still not saved",
    3,
    undefined,
    [PAIN_ONLY],
    "shown",
  ],
] as const)(
  "invariant 5a — a refusal already SAID that a strictly later write made false is taken back: the retried finish was applied%s",
  async (_, firstPain, retryPain, left, audit) => {
    await logSet("A", "set-1");
    mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress")); // today
    mount();
    await finishOffline(firstPain);
    await act(async () => {
      await sync(finishRefusedOnly);
    });
    await waitFor(() => expect(alertTexts()).toEqual([FINISH_ONLY]));
    await expect.poll(notices).toEqual(["shown"]); // said
    // The user finishes again — strictly later, online now — and the server applies it.
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    mocks.sync.mockImplementation(() => sync(applyAsServer));
    fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
    const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
    choosePain(sheet, retryPain ?? null); // the sheet still holds the first one's selection
    fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
    await screen.findByRole("heading", { name: "수고했어요" });
    await settle();
    expect(alertTexts()).toEqual(left); // "운동 종료는 저장되지 않았어요" beside a true summary: never
    expect(await notices()).toEqual([audit]);
  },
);

/*
 * The same, when the retried finish is applied by a later sync in the background — no sheet closes
 * to judge again: the response that changed what a refusal says is announced (like one that made a
 * refusal false, F1). It reaches the response's two other listeners too; that they do nothing here
 * is ASSERTED (총괄: not judged harmless) — and the two probes are first shown to see a run.
 */
it("invariant 5a — a retried finish without pain, applied in the background: the notice turns to the pain report, and the response's other listeners do nothing", async () => {
  await logSet("A", "set-1");
  mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress")); // today
  mount();
  await finishOffline(3);
  await act(async () => {
    await sync(finishRefusedOnly);
  });
  await waitFor(() => expect(alertTexts()).toEqual([FINISH_ONLY]));
  await expect.poll(notices).toEqual(["shown"]);
  vi.setSystemTime(new Date(NOW.getTime() + 1000));
  await finishOffline(); // the retry, without pain: committed here, sent later
  await settle();
  expect(alertTexts()).toEqual([FINISH_ONLY]); // not applied yet: still true
  const client = clients[0];
  const appendUpdates = () => client.getQueryState(["session-append", "A"])?.dataUpdateCount;
  const drafts = () => useSessionLog.getState().drafts;
  const before = { append: appendUpdates(), drafts: drafts() };
  await act(async () => {
    await sync(applyAsServer); // a background sync applies the retry
  });
  await waitFor(() => expect(alertTexts()).toEqual([PAIN_ONLY]));
  await settle();
  expect(await notices()).toEqual(["shown"]);
  expect(appendUpdates()).toBe(before.append); // onCommit did not reconcile
  expect(drafts()).toBe(before.drafts); // onSyncResponse did not reload drafts
  // The probes' positive control: an event that does concern both moves each of them.
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(SYNC_RESPONSE_EVENT, {
        detail: {
          applied: [],
          conflicts: [],
          changes: [{ entity: "session", entity_id: "A", op: "upsert", data: null }],
          planned_set_mappings: [],
          next_cursor: "v1.test",
          local_session_ids: ["A"],
          completed_session_ids: [],
        },
      }),
    );
  });
  await settle();
  expect(appendUpdates()).not.toBe(before.append);
  expect(drafts()).not.toBe(before.drafts);
});

it("invariant 5b — a notice already said holds only what is still true: rewritten when part of it is saved later", async () => {
  // A session a day ahead: the server refuses its records until its day comes.
  for (const id of ["set-1", "set-2"]) await logSet("A", id);
  await sync(refuseAsServer); // nobody is looking
  mocks.session.mockResolvedValue({
    ...session("A", "2026-08-15", "scheduled"),
    planned_sets: plannedSets("set", 3), // set 3 is still ahead: the routine, not the summary
  });
  mount();
  await screen.findByRole("heading", { name: "오늘 운동" });
  await waitFor(() =>
    expect(alertTexts()).toEqual([
      `${EDIT_WINDOW_COPY.upcoming} 벤치프레스 1·2세트 기록은 저장되지 않았어요.`,
    ]),
  );
  await expect.poll(perSet).toEqual({ "set-1": "shown", "set-2": "shown" }); // said
  // Its day comes; set 2 is entered again and this time it is saved. Set 1 still is not.
  vi.setSystemTime(new Date("2026-08-15T00:00:01.000Z"));
  await act(async () => {
    await logSet("A", "set-2");
    await sync(applyAsServer);
  });
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  expect(await perSet()).toEqual({ "set-1": "shown", "set-2": "superseded" });
});

it("invariant 5b — a notice rewritten while a sheet is up stays: a rewrite says nothing new, so it waits for nothing", async () => {
  for (const id of ["set-1", "set-2"]) await logSet("A", id);
  await sync(refuseAsServer); // nobody is looking
  mocks.session.mockResolvedValue({
    ...session("A", "2026-08-15", "scheduled"),
    planned_sets: plannedSets("set", 3),
  });
  mount();
  await waitFor(() =>
    expect(alertTexts()).toEqual([
      `${EDIT_WINDOW_COPY.upcoming} 벤치프레스 1·2세트 기록은 저장되지 않았어요.`,
    ]),
  );
  await expect.poll(perSet).toEqual({ "set-1": "shown", "set-2": "shown" });
  // A sheet comes up over the screen …
  fireEvent.click(screen.getByRole("button", { name: "운동 추가" }));
  const picker = await screen.findByRole("dialog", { name: "운동 추가" });
  // … and meanwhile its day comes and set 2 is saved.
  vi.setSystemTime(new Date("2026-08-15T00:00:01.000Z"));
  await act(async () => {
    await logSet("A", "set-2");
    await sync(applyAsServer);
  });
  await settle();
  // Behind the sheet the notice no longer claims set 2: a false sentence is not left standing.
  const behind = [...document.querySelectorAll('[role="alert"]')].filter((el) =>
    el.closest("[inert]"),
  );
  expect(behind.map((el) => el.textContent)).toEqual([SET1]);
  fireEvent.click(within(picker).getByRole("button", { name: "닫기" }));
  await settle();
  expect(alertTexts()).toEqual([SET1]); // and it is still there: nothing took the rewrite back
  expect(await perSet()).toEqual({ "set-1": "shown", "set-2": "superseded" });
});

it("invariant 15 — a new refusal's notice still holds the earlier ones that are still true, said before or not", async () => {
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress")); // previous here
  mount();
  await screen.findByLabelText(weight(2));
  // The server is a day ahead; the browser still has the day open.
  await act(async () => {
    await logSet("A", "set-1");
    await sync(refuseAsServer);
  });
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
  // A new event: set 2 is refused as well. Set 1 was not entered again — still not saved.
  await act(async () => {
    await logSet("A", "set-2");
    await sync(refuseAsServer);
  });
  await waitFor(() =>
    expect(alertTexts()).toEqual(["벤치프레스 1·2세트 기록은 저장되지 않았어요."]),
  );
  await expect.poll(perSet).toEqual({ "set-1": "shown", "set-2": "shown" });
});

it("invariant 2 — a refusal that arrives while the page is hidden is neither drawn nor consumed; it is said once the page is visible", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  await screen.findAllByText(EXPIRED); // the screen is up (header notice of the older session)
  await settle();
  // The app goes to the background; a sync still runs there (the `online` trigger, a retry).
  act(() => setVisibility("hidden"));
  const drawn = alertsDrawn();
  await act(async () => {
    await sync(refuseAsServer);
  });
  await settle();
  drawn.stop();
  expect(drawn.texts).toEqual([]); // nothing is drawn on a page nobody can see
  expect(await notices()).toEqual(["pending"]); // and nothing is consumed
  act(() => setVisibility("visible"));
  await waitFor(() => expect(alertTexts()).toEqual([`${EXPIRED} ${SET1}`]));
  await expect.poll(notices).toEqual(["shown"]);
});

it("invariant 2 — the page is hidden after the judge decided, before the notice is marked said: not consumed; said once visible", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer); // nobody is looking
  const describe = editRightsModule.describeRefusals;
  let hidden = false;
  vi.spyOn(editRightsModule, "describeRefusals").mockImplementationOnce((...args) => {
    setVisibility("hidden"); // past the judge's check, before its notice is drawn
    hidden = true;
    return describe(...args);
  });
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  await screen.findAllByText(EXPIRED);
  await settle();
  expect(hidden).toBe(true);
  expect(await notices()).toEqual(["pending"]); // drawn on a hidden page: not consumed …
  expect(alertTexts()).toEqual([]); // … and taken back
  act(() => setVisibility("visible"));
  await waitFor(() => expect(alertTexts()).toEqual([`${EXPIRED} ${SET1}`]));
  await expect.poll(notices).toEqual(["shown"]);
});

it("invariant 2 — a sheet comes up after the judge decided, before the notice is marked said: not consumed; said when it closes", async () => {
  await logSet("A", "set-1");
  await sync(refuseAsServer); // nobody is looking
  const describe = editRightsModule.describeRefusals;
  let opened = false;
  vi.spyOn(editRightsModule, "describeRefusals").mockImplementationOnce((...args) => {
    // Past the judge's check, before its notice is drawn: the user opens the exercise picker.
    fireEvent.click(screen.getByRole("button", { name: "운동 추가" }));
    opened = true;
    return describe(...args);
  });
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress")); // the routine is open
  mount();
  const picker = await screen.findByRole("dialog", { name: "운동 추가" });
  await settle();
  expect(opened).toBe(true);
  expect(await notices()).toEqual(["pending"]); // drawn behind the picker: not consumed
  fireEvent.click(within(picker).getByRole("button", { name: "닫기" }));
  await waitFor(() => expect(alertTexts()).toEqual([SET1]));
  await expect.poll(notices).toEqual(["shown"]);
});

it("invariant 2 — a notice already said keeps standing when its view changes while the page is hidden: drawn again, nothing new to mark", async () => {
  await logSet("A", "set-1");
  vi.setSystemTime(CLOSED);
  await sync(refuseAsServer); // nobody is looking
  mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
  mount();
  await waitFor(() => expect(alertTexts()).toEqual([`${EXPIRED} ${SET1}`]));
  await expect.poll(notices).toEqual(["shown"]); // said, while the page was in front
  // In the background the session cannot be read again and the device has no copy: the error view
  // replaces the screen and draws the notice anew — the same notice, already said.
  act(() => setVisibility("hidden"));
  await sessionDb.sessions.clear();
  mocks.session.mockRejectedValue(new Error("GET unavailable"));
  await act(async () => {
    await clients[0].refetchQueries({ queryKey: ["session", "A"] });
  });
  await screen.findByRole("button", { name: "다시 불러오기" });
  await settle();
  expect(alertTexts()).toContain(`${EXPIRED} ${SET1}`); // still standing: not taken back
  act(() => setVisibility("visible"));
  await settle();
  expect(alertTexts()).toContain(`${EXPIRED} ${SET1}`);
  expect(await notices()).toEqual(["shown"]);
});

/*
 * The eleventh face (총괄 2026-10-07): "my write was refused" is not "it did not happen". A refusal
 * is a fact about OUR attempt; whether the session was finished is another question, and the
 * authoritative session — re-read after a refused finish — answers it. `stale_update` on a finish
 * means a later completion was already applied: by another device, whose write has no row in this
 * outbox to compare with (5a cannot see it). When the re-read says "completed", the finish was
 * not lost: "운동 종료는 저장되지 않았어요" beside the summary would be false. A failed re-read
 * changes nothing — the refusal is said from the refusal itself (the re-read is not a gate).
 */
/** The server's answer to this device's sync after ANOTHER device finished the session first. */
const finishedElsewhere = async (body: SyncRequest): Promise<SyncResponse> => ({
  applied: body.mutations.filter((m) => m.entity !== "session").map((m) => m.client_id),
  conflicts: body.mutations
    .filter((m) => m.entity === "session")
    .map((m) => ({ client_id: m.client_id, entity_id: m.entity_id, reason: "stale_update" })),
  changes: [],
  planned_set_mappings: [],
  next_cursor: "v1.test",
});

/*
 * 15's boundary (총괄 R4): what a notice holds is the session's still-true refusals as read right
 * before it is composed — not the snapshot the judge read first. A refusal that arrived after that
 * read is in the first notice, complete; its own arrival then wakes a judge that has nothing new
 * (it was said: 1). One arriving after the composition read is not chased — that arrival wakes the
 * judge and the rewrite (F3) puts it in the notice: the window is narrowed as far as the mechanism
 * allows, not to zero.
 */
it("invariant 15 — a refusal that arrives after the judge's read but before its notice is composed is in that notice: said once, complete", async () => {
  await logSet("A", "set-1");
  await sync(refuseAsServer); // set 1 refused while nobody was looking
  const judge = holdJudgeReads();
  mocks.session.mockResolvedValue({
    ...session("A", "2026-08-13", "in_progress"),
    planned_sets: plannedSets("set", 3), // set 3 is still ahead: the routine, not the summary
  });
  mount();
  let read: unknown[] = [];
  await act(async () => {
    read = await judge.entered;
  });
  expect(read).toHaveLength(1); // the judge HAS read set 1 …
  // … and before it composes, set 2 is refused too (its arrival wakes the next judge, held here).
  await act(async () => {
    await logSet("A", "set-2");
    await sync(refuseAsServer);
  });
  const BOTH = "벤치프레스 1·2세트 기록은 저장되지 않았어요.";
  const drawn = alertsDrawn();
  judge.releaseFirst();
  await settle();
  expect(drawn.texts).toEqual([BOTH]); // composed from what is still true right before it
  judge.releaseNext();
  await settle();
  drawn.stop();
  expect(drawn.texts).toEqual([BOTH]); // set 2's own judge has nothing new: said once
  await expect.poll(perSet).toEqual({ "set-1": "shown", "set-2": "shown" });
});

/*
 * With a pain report (총괄 R5 (i)): the finish IS saved — the session is finished — but the pain
 * this finish carried is not. The finish clause is false; "통증 기록은 저장되지 않았어요" is true and
 * stays: the refusal is not superseded, it is described for what is left of it. These 5c tests used
 * finishes without pain only — which is how the silent loss of a pain report went unseen.
 */
it.each([
  ["without a pain report: nothing is left to say", undefined, [], "superseded"],
  [
    "with a pain report: the pain is still not saved, and only that is said",
    3,
    [PAIN_ONLY],
    "shown",
  ],
] as const)(
  "invariant 5c — a finish refused because another device finished the session first: the re-read says completed, so 'not saved' is not said beside the summary — %s",
  async (_, pain, left, audit) => {
    await logSet("A", "set-1");
    mocks.session.mockResolvedValue(session("A", "2026-08-14", "in_progress")); // today
    const first = mount();
    await finishOffline(pain);
    // Another device finished this session first: the server holds it completed.
    mocks.session.mockResolvedValue(session("A", "2026-08-14", "completed"));
    await act(async () => {
      await sync(finishedElsewhere);
    });
    await screen.findByRole("heading", { name: "수고했어요" }); // the session IS finished
    await waitFor(() => expect(screen.queryByText(FINISH_ONLY)).toBeNull());
    await settle();
    expect(alertTexts()).toEqual(left);
    expect(screen.getByRole("heading", { name: "수고했어요" })).toBeTruthy();
    expect(await notices()).toEqual([audit]);
    // Nor again on the next screen for this session: said once.
    first.unmount();
    mount();
    await screen.findByRole("heading", { name: "수고했어요" });
    await settle();
    expect(alertTexts()).toEqual([]);
  },
);

it.each([
  ["without a pain report", undefined, `${EXPIRED} ${SET1}`, "session:superseded"],
  [
    "with a pain report: the pain is not saved either",
    3,
    `${EXPIRED} ${SET1} ${PAIN_TOO}`,
    "session:shown",
  ],
] as const)(
  "invariant 5c — the session finished elsewhere takes back only the finish: a refused set is still said — %s",
  async (_, pain, said, finishAudit) => {
    await logSet("A", "set-1");
    mocks.session.mockResolvedValue(session("A", "2026-08-13", "in_progress"));
    mount();
    await finishOffline(pain);
    vi.setSystemTime(CLOSED);
    // Another device finished it while its window was open; this device's set and finish arrive late.
    mocks.session.mockResolvedValue(session("A", "2026-08-13", "completed"));
    await act(async () => {
      await sync(refuseAsServer);
    });
    // The set was not saved — that is still true; the session being finished does not change it.
    await waitFor(() => expect(alertTexts()).toEqual([said]));
    await settle();
    expect(alertTexts()).toEqual([said]);
    await expect
      .poll(async () =>
        (await sessionDb.conflicts.toArray())
          .map((row) => `${(row.payload as { entity: string }).entity}:${row.notice}`)
          .sort(),
      )
      .toEqual(["performed_set:shown", finishAudit]);
  },
);

/*
 * Evaluator R5 (총괄: one truth evaluation right before a notice is composed, not a trigger per
 * source). The session being finished on the server makes a finish refusal false, like a strictly
 * later write (F1) does: for every row, said or not, whatever woke the judge — not only while the
 * finish refusal is new. The order below is the evaluator's (real Chrome + API confirmed it): the
 * re-read after the refusal fails, so the refusal is said and marked; a later ordinary read shows
 * the session finished; a set is refused after that. A discriminating pair: the same order, and
 * only what the server says about the session differs — completed takes the finish out of the next
 * notice, in progress keeps it (the guard against taking it out without looking). The pair's third
 * member is the first 5c test above: the session finished from the start.
 */
const todayThreeSets = (status: Session["status"]) => ({
  ...session("A", "2026-08-14", status),
  planned_sets: plannedSets("set", 3),
});
/** The finish is refused while the session cannot be read again: said from the refusal, marked. */
async function finishRefusalSaidWithoutReread(pain?: number) {
  await logSet("A", "set-1");
  await sync(applyAsServer); // set 1 is saved
  mocks.session.mockResolvedValue(todayThreeSets("in_progress"));
  const view = mount();
  await finishOffline(pain);
  mocks.session.mockRejectedValue(new Error("GET 503")); // the re-read after the refusal fails
  await act(async () => {
    await sync(refuseAsServer);
  });
  await waitFor(() => expect(alertTexts()).toEqual([FINISH_ONLY]));
  await settle();
  expect(await notices()).toEqual(["shown"]);
  return view;
}
/** Set 2 is refused: a new event, after the session was read again. */
async function refuseSet2() {
  await act(async () => {
    await logSet("A", "set-2");
    await sync(refuseAsServer);
  });
}

const SET2_SAID = "벤치프레스 2세트 기록은 저장되지 않았어요.";
it.each([
  ["", undefined, SET2_SAID, "superseded"],
  [" — with a pain report: the pain is still not saved", 3, `${SET2_SAID} ${PAIN_TOO}`, "shown"],
] as const)(
  "invariant 5c — a finish refusal already said is false once a later read shows the session finished: the next notice holds the set alone%s",
  async (_, pain, next, finishAudit) => {
    const first = await finishRefusalSaidWithoutReread(pain);
    first.unmount();
    mocks.session.mockResolvedValue(todayThreeSets("completed")); // an ordinary read succeeds
    mount();
    await screen.findByRole("heading", { name: "수고했어요" });
    await settle();
    expect(alertTexts()).toEqual([]); // said once already: not raised again
    await refuseSet2();
    await waitFor(() => expect(alertTexts()).toEqual([next]));
    await settle();
    expect(alertTexts()).toEqual([next]);
    await expect.poll(perSet).toEqual({ A: finishAudit, "set-2": "shown" });
  },
);

it.each([
  ["", undefined],
  [" — with a pain report: the finish clause still covers it", 3],
] as const)(
  "invariant 5c — the contrast: a later read shows the session still in progress, so the finish refusal is still true and stays in the next notice%s",
  async (_, pain) => {
    const first = await finishRefusalSaidWithoutReread(pain);
    first.unmount();
    mocks.session.mockResolvedValue(todayThreeSets("in_progress")); // the server: NOT finished
    mount();
    await screen.findByLabelText(weight(2)); // the routine, not the summary
    await settle();
    expect(alertTexts()).toEqual([]);
    await refuseSet2();
    const SET2_AND_FINISH = `${SET2_SAID} ${FINISH_TOO}`;
    await waitFor(() => expect(alertTexts()).toEqual([SET2_AND_FINISH]));
    await settle();
    expect(alertTexts()).toEqual([SET2_AND_FINISH]);
    await expect.poll(perSet).toEqual({ A: "shown", "set-2": "shown" });
  },
);

it.each([
  ["taken back", undefined, [], "superseded"],
  [
    "rewritten to the pain report it carried (re-announced: the correction is heard)",
    3,
    [PAIN_ONLY],
    "shown",
  ],
] as const)(
  "invariant 5c — a finish refusal on screen is %s when this screen's own later read shows the session finished",
  async (_, pain, left, audit) => {
    await finishRefusalSaidWithoutReread(pain); // still on screen, beside the routine
    mocks.session.mockResolvedValue(todayThreeSets("completed"));
    await act(async () => {
      await clients[0].refetchQueries({ queryKey: ["session", "A"] });
    });
    await screen.findByRole("heading", { name: "수고했어요" });
    await waitFor(() => expect(alertTexts()).toEqual(left));
    await settle();
    expect(alertTexts()).toEqual(left);
    expect(await notices()).toEqual([audit]);
  },
);

/*
 * Evaluator R6 (총괄: 차단 — real Chrome and the compiled API confirmed it). A finish waits in the
 * outbox; an ordinary read meanwhile shows the session finished (another request finished it), so
 * from then on the mirror's "completed" is the server's, not this finish's claim. The finish's
 * refusal arrives after that read: taking "its" completed back took the server's, and with the
 * re-read failing (GET 503) the finish refusal was said beside a finished session. Whether to take a
 * status back is decided by where it came from, not by its value (총괄 R6). The order is the
 * evaluator's. The status the finish replaced is both the unit order's (in progress) and the
 * browser's (scheduled: the mirror was not read again after the set was saved). The refused sync is
 * sent after the read (the browser's order) or already on its way while the read lands (the unit
 * order): the refusal is committed from the finish's row as it is then, not as it was sent.
 */
it.each([
  ["in_progress", "sent after it"],
  ["scheduled", "sent after it"],
  ["in_progress", "on its way while it lands"],
  ["scheduled", "on its way while it lands"],
] as const)(
  "invariant 11 — a finish refused after an ordinary read showed the session finished takes nothing back: that 'completed' is the server's (status before the finish: %s; the refused sync %s)",
  async (prior, order) => {
    await logSet("A", "set-1");
    await sync(applyAsServer); // set 1 is saved
    mocks.session.mockResolvedValue(todayThreeSets(prior));
    mount();
    await finishOffline(); // committed here, not sent
    const finishes = () => sessionDb.outbox.filter((row) => row.entity === "session").toArray();
    expect((await finishes()).map((row) => row.prior_status)).toEqual([prior]);
    const mirror = async () => {
      const row = await sessionDb.sessions.get([DEV_USER_SCOPE, "A"]);
      return { status: (row?.session as Session | undefined)?.status, writtenAt: row?.updated_at };
    };
    let answer = () => sync(refuseAsServer);
    if (order === "on its way while it lands") {
      let release!: () => void;
      let sent!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const onItsWay = new Promise<void>((resolve) => (sent = resolve));
      let refused: ReturnType<typeof sync> = Promise.resolve(null);
      await act(async () => {
        refused = sync(async (body) => {
          sent();
          await gate;
          return refuseAsServer(body);
        });
        await onItsWay;
      });
      answer = () => {
        release();
        return refused;
      };
    }
    // An ordinary read, a moment later, shows the session finished: the read writes the mirror …
    const readAt = new Date(NOW.getTime() + 1000);
    vi.setSystemTime(readAt);
    mocks.session.mockResolvedValue(todayThreeSets("completed"));
    await act(async () => {
      await clients[0].refetchQueries({ queryKey: ["session", "A"] });
    });
    expect(await mirror()).toEqual({ status: "completed", writtenAt: readAt.toISOString() });
    expect(await finishes()).toHaveLength(1); // … while the finish still waits
    mocks.session.mockRejectedValue(new Error("GET 503")); // every read from here on fails
    await act(async () => {
      await answer(); // the finish's refusal arrives
    });
    await settle();
    expect((await mirror()).status).toBe("completed"); // the server's: not taken back
    expect(alertTexts()).toEqual([]);
    expect(screen.getByRole("heading", { name: "수고했어요" })).toBeTruthy();
    expect(await notices()).toEqual(["superseded"]);
  },
);

/*
 * The read overtakes the claims of the session it read — no other's. r8 probe (W-R83): marking every
 * waiting finish of the user survived every test. Here B's finish waits while an ordinary read of A
 * lands; B's refusal must still take B's own optimistic "completed" back — left there, B would look
 * finished on the server and its refusal would be taken back unsaid (the silent direction).
 */
it("invariant 11 — a read of one session overtakes no other session's waiting finish: that refusal still takes its own 'completed' back, and is said on its screen", async () => {
  await logSet("B", "b-1");
  await sync(applyAsServer); // B's set is saved
  let readable = true;
  mocks.session.mockImplementation(async (id: string) => {
    if (!readable) throw new Error("GET 503");
    return session(id, "2026-08-14", "in_progress");
  });
  const onB = mount("B");
  await finishOffline(); // B's finish waits in the outbox
  onB.unmount();
  mount("A"); // an ordinary read of ANOTHER session lands meanwhile
  await screen.findByLabelText(weight(1));
  expect(await sessionDb.outbox.filter((row) => row.entity === "session").count()).toBe(1);
  await act(async () => {
    await sync(refuseAsServer); // B's finish is refused
  });
  const statusOf = async (id: string) =>
    ((await sessionDb.sessions.get([DEV_USER_SCOPE, id]))?.session as Session | undefined)?.status;
  expect(await statusOf("B")).toBe("in_progress"); // B's own claim, taken back
  expect(await notices()).toEqual(["pending"]); // for B's screen to say
  cleanup();
  readable = false; // B is opened again and cannot be read: the device's copy is what it knows
  mount("B");
  await waitFor(() => expect(alertTexts()).toEqual([FINISH_ONLY]));
  await settle();
  expect(await notices()).toEqual(["shown"]);
});

/*
 * 총괄 R5 condition: the judge the screen showing the session finished wakes runs on an ordinary
 * finish too. That run is ASSERTED to do nothing — no alert, no audit write — not judged harmless (a
 * "harmless no-op" in this ticket was once not). That a judge ran on the finished session is asserted
 * first, or "nothing happened" would hold vacuously. Another session's refused finish waits to be
 * said when that session is opened: nothing on this path may touch it. (This session has no refusal
 * of its own, so the truth evaluation does not run here — its own session scope is pinned below.)
 */
it("invariant 5c — on an ordinary finish, the judge that runs on the finished session says nothing and writes no audit row", async () => {
  await sessionDb.conflicts.add({
    user_id: DEV_USER_SCOPE,
    client_id: "33333333-3333-4333-8333-333333333333",
    kind: "stale_update",
    payload: { entity: "session", entity_id: "B" },
    session_id: "B",
    notice: "pending",
  });
  const before = await sessionDb.conflicts.toArray();
  // Every write the audit table takes from here on — one that leaves the row as it was included,
  // which comparing rows cannot see (evaluator R6). The hooks' positive control ends this test.
  const writes = { creating: 0, updating: 0, deleting: 0 };
  const created = () => void writes.creating++;
  const updated = () => void writes.updating++;
  const deleted = () => void writes.deleting++;
  sessionDb.conflicts.hook("creating", created);
  sessionDb.conflicts.hook("updating", updated);
  sessionDb.conflicts.hook("deleting", deleted);
  try {
    await logSet("A", "set-1");
    mocks.session.mockResolvedValue(todayThreeSets("in_progress"));
    mount();
    await screen.findByLabelText(weight(2));
    const read = sessionDbModule.standingRefusals;
    const finishedWhenJudged: boolean[] = [];
    vi.spyOn(sessionDbModule, "standingRefusals").mockImplementation(async (...args) => {
      const shown = clients[0].getQueryData<Session>(["session", "A"])?.status;
      finishedWhenJudged.push(shown === "completed");
      return read(...args);
    });
    await finishOffline(); // the user finishes …
    mocks.session.mockResolvedValue(todayThreeSets("completed"));
    await act(async () => {
      await sync(applyAsServer); // … and the server applies it
    });
    await settle();
    expect(finishedWhenJudged).toContain(true); // a judge ran on the finished session
    expect(alertTexts()).toEqual([]);
    expect(await sessionDb.conflicts.toArray()).toEqual(before); // no audit row changed …
    expect(writes).toEqual({ creating: 0, updating: 0, deleting: 0 }); // … nor written at all
    // The hooks' positive control (총괄 R6 N2): a write that leaves the row exactly as it was IS
    // counted — a put of the same row. Not an update of a field to its own value: Dexie leaves such a
    // row unwritten, so it would count 0 and prove nothing. Without this, 0 could mean "not counted".
    await sessionDb.conflicts.put(before[0]);
    expect(await sessionDb.conflicts.toArray()).toEqual(before);
    expect(writes).toEqual({ creating: 0, updating: 1, deleting: 0 });
  } finally {
    sessionDb.conflicts.hook("creating").unsubscribe(created);
    sessionDb.conflicts.hook("updating").unsubscribe(updated);
    sessionDb.conflicts.hook("deleting").unsubscribe(deleted);
  }
});

/*
 * The finished-on-server evaluation belongs to the session being judged. r7 (W-R62): dropping the
 * session from it survived every test — the bait above is never reached, since a session with no
 * refusal of its own does not run the evaluation. Here A runs it: its own refused finish is false
 * (A is finished) and goes; B's refused finish is true and must stay, for B's screen to say.
 */
it("invariant 4 — evaluating a session finished on the server takes no other session's refusal with it", async () => {
  const refusedFinish = (sessionId: string, notice: "pending" | "shown", clientId: string) => ({
    user_id: DEV_USER_SCOPE,
    client_id: clientId,
    kind: "stale_update",
    payload: { entity: "session", entity_id: sessionId, payload: { status: "completed" } },
    session_id: sessionId,
    notice,
  });
  await sessionDb.conflicts.add(
    refusedFinish("A", "shown", "44444444-4444-4444-8444-444444444444"),
  );
  await sessionDb.conflicts.add(
    refusedFinish("B", "pending", "55555555-5555-4555-8555-555555555555"),
  );
  mocks.session.mockImplementation(async (id: string) =>
    id === "A"
      ? session("A", "2026-08-14", "completed")
      : session("B", "2026-08-14", "in_progress"),
  );
  const first = mount("A");
  // A is finished on the server (its summary: no sets were recorded here).
  await screen.findByRole("heading", { name: "오늘은 기록이 없어요" });
  await settle();
  const bySession = async () =>
    Object.fromEntries(
      (await sessionDb.conflicts.toArray()).map((row) => [row.session_id, row.notice]),
    );
  expect(await bySession()).toEqual({ A: "superseded", B: "pending" });
  first.unmount();
  mount("B");
  await waitFor(() => expect(alertTexts()).toEqual([FINISH_ONLY])); // still true there: said
});

/*
 * Evaluator R4 EVAL_PHANTOM (총괄: 기능 정지 — 최우선): a modal held by an id whose target a re-read
 * removed. What is DRAWN decides whether the screen is inert, target included. The pain sheet
 * draws nothing without its exercise — with `main` left inert behind no dialog, the routine froze
 * (nothing to press, nothing said). The other sheets are still drawn after their target is gone, so
 * the screen behind them is rightly inert until they close. Two separate facts are asserted: the
 * screen is usable again (no `inert`), and the refusal held behind the sheet is said.
 */
/** Previous day, two exercises: bench (set-1, set-2) and squat (sq-1, sq-2). */
const benchAndSquat = () => ({
  ...session("A", "2026-08-13", "in_progress"),
  planned_sets: [
    ...plannedSets("set", 2),
    ...plannedSets("sq", 2).map((set) => ({ ...set, exercise_id: "squat" })),
  ],
});
/** The same session read again after squat was removed elsewhere. */
const benchOnly = () => ({
  ...session("A", "2026-08-13", "in_progress"),
  planned_sets: plannedSets("set", 2),
});
const inertCount = () => document.querySelectorAll("[inert]").length;
const allNotices = async (notice: string) => (await notices()).every((value) => value === notice);
/** A bench refusal said (by name) on the screen. */
const benchSaid = () => alertTexts().some((text) => text?.includes("벤치프레스 1세트"));

/** A modal whose target is squat is up; a bench refusal is held behind it; a re-read removes squat. */
async function holdBehindAModalWhoseTargetGoes(open: () => Promise<void>) {
  mocks.session.mockResolvedValue(benchAndSquat());
  mount();
  await screen.findByLabelText(weight(1));
  await open();
  await act(async () => {
    await logSet("A", "set-1");
    await sync(refuseAsServer);
  });
  await settle();
  expect(inertCount()).toBeGreaterThan(0); // the sheet is up: the screen behind it is inert …
  expect(await allNotices("pending")).toBe(true); // … and the refusal waits
  mocks.session.mockResolvedValue(benchOnly());
  await act(async () => {
    await clients[0].refetchQueries({ queryKey: ["session", "A"] });
  });
  await settle();
}
const fromSquatMenu = (item: string, dialog: string) => async () => {
  fireEvent.click(screen.getByRole("button", { name: "스쿼트 메뉴" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  await screen.findByRole("dialog", { name: dialog });
};
const restAfterSquatSet1 = async () => {
  fireEvent.click(screen.getByRole("button", { name: "스쿼트 1세트 완료 처리" }));
  await screen.findByRole("dialog", { name: "스쿼트 1세트 후 휴식" });
};

it("invariant 2 — the pain sheet's exercise is removed by a re-read: nothing is drawn, so nothing keeps the screen inert — and the held refusal is said", async () => {
  await holdBehindAModalWhoseTargetGoes(fromSquatMenu("스쿼트 통증 기록", "스쿼트 통증 기록"));
  expect(screen.queryAllByRole("dialog")).toHaveLength(0); // nothing is drawn over the screen …
  await waitFor(() => expect(inertCount()).toBe(0)); // … so the routine is usable again
  await waitFor(() => expect(benchSaid()).toBe(true)); // and, separately: the refusal is said
  await expect.poll(() => allNotices("shown")).toBe(true);
});

it("invariant 2 — the rest sheet's set is removed by a re-read: the rest is dropped, nothing is drawn, the screen is usable — and the held refusal is said", async () => {
  await holdBehindAModalWhoseTargetGoes(restAfterSquatSet1);
  // A rest whose set is gone is dropped (its stored timer cleared): the sheet closes itself.
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
  await waitFor(() => expect(inertCount()).toBe(0));
  await waitFor(() => expect(benchSaid()).toBe(true));
  await expect.poll(() => allNotices("shown")).toBe(true);
});

it.each([
  ["remove", fromSquatMenu("스쿼트 삭제", "스쿼트 빼기"), "운동 빼기", "취소"],
  ["swap picker", fromSquatMenu("스쿼트 교체", "스쿼트 교체"), "스쿼트 교체", "닫기"],
] as const)(
  "invariant 2 — the %s sheet's target is removed by a re-read: still drawn, so the screen stays inert behind it; closing it frees the screen and says the held refusal",
  async (_, open, drawn, close) => {
    await holdBehindAModalWhoseTargetGoes(open);
    const sheet = screen.getByRole("dialog", { name: drawn }); // what is drawn decides …
    expect(inertCount()).toBeGreaterThan(0); // … the screen behind it is inert
    expect(await allNotices("pending")).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: close }));
    await waitFor(() => expect(inertCount()).toBe(0));
    await waitFor(() => expect(benchSaid()).toBe(true));
    await expect.poll(() => allNotices("shown")).toBe(true);
  },
);
