// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../lib/api";
import { RECORDED_BENCH_TEXT, recordedText, recordInput } from "./support/record-controls";

const mocks = vi.hoisted(() => ({ session: vi.fn(), sync: vi.fn(), complete: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  const replacements: Partial<typeof actual.api> = {
    session: mocks.session,
    completeSession: mocks.complete,
  };
  for (const key of Object.keys(replacements)) {
    if (typeof actual.api[key as keyof typeof actual.api] !== "function")
      throw new Error(`probe target does not exist: ${key}`);
  }
  return { ...actual, api: { ...actual.api, ...replacements } };
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
const { sessionDb } = await import("../components/session/session-db");
const database = await import("../components/session/session-db");
const { api } = await import("../lib/api");
const { useSessionLog } = await import("../components/session/session-store");
const { resolveSessionPosition } = await import("../components/session/session-position");
const { isResistancePlannedSet } = await import("../components/session/cardio-read");
const clients: QueryClient[] = [];
const SID = "10000000-0000-4000-8000-000000000001";
const PID = "20000000-0000-4000-8000-000000000001";
const SET = "30000000-0000-4000-8000-000000000001";
const record = {
  actual_weight: 72.5,
  actual_reps: 8,
  actual_rir: 1,
  actual_time_sec: null,
  pain_score: null,
  completed: true,
  performed_at: "2026-08-14T09:00:00.000Z",
};
const makeSession = (serverRecord: boolean): Session =>
  ({
    id: SID,
    program_id: PID,
    goal: "hypertrophy",
    status: "scheduled",
    scheduled_date: "2026-08-14",
    planned_sets: [1, 2].map((n) => ({
      id: n === 1 ? SET : "30000000-0000-4000-8000-000000000002",
      exercise_id: "bench",
      set_no: n,
      source_revision: "bug02-record-source",
      correlation_id: null,
      append_eligibility: null,
      target_reps_low: 8,
      target_reps_high: 10,
      target_rir: 2,
      rest_sec: 90,
      recommended_weight: 60,
      recommended_reps: 9,
      reason_code: "BASELINE",
      rules_version: "2026.08.1",
      load_kind: "external",
      recommendation_state: "ready",
      assistance_provenance: null,
      recommended_action: null,
      assistance_safety_status: null,
      recommendation_gate: "ready",
      performed_set: serverRecord && n === 1 ? record : null,
    })),
  }) as Session;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <SessionScreen sessionId={SID} />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-14T10:00:00.000Z"));
  mocks.session.mockReset();
  mocks.sync.mockReset();
  mocks.complete.mockReset();
  mocks.sync.mockResolvedValue(null);
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  clients.splice(0).forEach((client) => client.clear());
  await sessionDb.delete();
  vi.useRealTimers();
});

it("server-only actual appears as checked with recorded values, not as unperformed prefill", async () => {
  const authoritative = makeSession(true);
  mocks.session.mockResolvedValue(authoritative);
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  expect(mocks.session.mock.calls[0]?.[0]).toBe(SID);
  expect(authoritative.planned_sets[0].performed_set?.completed).toBe(true);
  const check = document.querySelector(`[data-set-check="${SET}"]`);
  expect(check?.getAttribute("aria-pressed")).toBe("true");
  expect(recordedText(SET)).toBe(RECORDED_BENCH_TEXT);
  expect(await sessionDb.outbox.count()).toBe(0);
});

it.each(["삭제", "교체"])(
  "server-only actual blocks %s before a routine mutation or sheet",
  async (action) => {
    mocks.session.mockResolvedValue(makeSession(true));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "벤치프레스 메뉴" }));
    const item = screen.getByRole("menuitem", { name: `벤치프레스 ${action}` });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await sessionDb.outbox.count()).toBe(0);
  },
);

it("local-only completion still checks and protects the exercise", async () => {
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 10, rir: 2, timeSec: null });
  const before = await sessionDb.outbox.count();
  expect(before).toBe(1);
  mocks.session.mockResolvedValue(makeSession(false));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "벤치프레스 메뉴" }));
  await waitFor(() =>
    expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(
    screen.getByRole("menuitem", { name: "벤치프레스 삭제" }).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(await sessionDb.outbox.count()).toBe(before);
});

it("cold partial server completion stays in the routine without a local draft", async () => {
  expect(useSessionLog.getState().drafts).toEqual({});
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  expect(screen.getByRole("heading", { name: "오늘 운동" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "수고했어요" })).toBeNull();
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("the existing position gate already summarizes a cold session with every server set completed", async () => {
  const session = makeSession(true);
  session.planned_sets[1].performed_set = { ...session.planned_sets[0].performed_set! };
  expect(useSessionLog.getState().drafts).toEqual({});
  mocks.session.mockResolvedValue(session);
  mount();
  await screen.findByRole("heading", { name: "수고했어요" });
  expect(screen.queryByRole("button", { name: "벤치프레스 메뉴" })).toBeNull();
  expect(
    Object.values(useSessionLog.getState().drafts).filter((draft) => draft.completed),
  ).toHaveLength(2);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("diagnostic control: a pulled draft alone feeds the unchanged consumers and uncheck write baseline", async () => {
  // Seed only establishes the consumer premise; this is not a GET-hydrate implementation.
  await sessionDb.drafts.put({
    user_id: "dev-user",
    session_id: SID,
    planned_set_id: SET,
    ...record,
    client_id: SET,
    updated_at: "2026-08-14T10:00:00.000Z",
  });
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  const check = document.querySelector(`[data-set-check="${SET}"]`)!;
  await waitFor(() => expect(check.getAttribute("aria-pressed")).toBe("true"));
  const row = document.querySelector(`[data-planned-set-id="${SET}"]`)!;
  expect(row.textContent).toContain("72.5");
  expect(row.textContent).toContain("8회");
  expect(screen.getByText("1세트 완료 · 계획 2세트")).toBeTruthy();
  expect(screen.getByText("1/2")).toBeTruthy();
  expect(await sessionDb.outbox.count()).toBe(0);
  fireEvent.click(check);
  await waitFor(async () => expect(await sessionDb.outbox.count()).toBe(1));
  const mutation = (await sessionDb.outbox.toArray())[0];
  expect({ entity: mutation.entity, id: mutation.entity_id, op: mutation.op }).toEqual({
    entity: "performed_set",
    id: SET,
    op: "delete",
  });
  expect(useSessionLog.getState().drafts[SET].completed).toBe(false);
});

it("GET after begin has finished publishes a read draft without sending a mutation or completion", async () => {
  await useSessionLog.getState().begin(SID);
  expect(useSessionLog.getState().drafts).toEqual({});
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  await waitFor(() => expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true));
  expect((await sessionDb.drafts.toArray())[0]).toMatchObject({
    session_id: SID,
    planned_set_id: SET,
    completed: true,
  });
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(`[data-set-check="${SET}"]`)!);
  await waitFor(async () => expect(await sessionDb.outbox.count()).toBe(1));
  expect((await sessionDb.outbox.toArray())[0]).toMatchObject({
    entity: "performed_set",
    entity_id: SET,
    op: "delete",
  });
});

it("successful safe GET still checks the row when the durable cache write fails", async () => {
  await useSessionLog.getState().begin(SID);
  vi.spyOn(sessionDb.sessions, "put").mockRejectedValue(new Error("quota exceeded"));
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  await waitFor(() =>
    expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("a local uncheck made while GET is pending remains unchecked and retains the delete intent", async () => {
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 10, rir: 2, timeSec: null });
  let resolve!: (session: Session) => void;
  mocks.session.mockImplementation(
    () =>
      new Promise<Session>((done) => {
        resolve = done;
      }),
  );
  mount();
  await waitFor(() => expect(mocks.session).toHaveBeenCalled());
  await useSessionLog.getState().uncompleteSet(SET);
  const intent = useSessionLog.getState().drafts[SET];
  expect(intent.completed).toBe(false);
  const writes = await sessionDb.outbox.toArray();
  expect(writes.some((row) => row.client_id === intent.client_id && row.op === "delete")).toBe(
    true,
  );
  resolve(makeSession(true));
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  expect(useSessionLog.getState().drafts[SET]).toEqual(intent);
  expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(await sessionDb.outbox.toArray()).toEqual(writes);
});

it("late GET of A does not publish its read draft into the current B session", async () => {
  let resolve!: (session: Session) => void;
  mocks.session.mockImplementation(
    () =>
      new Promise<Session>((done) => {
        resolve = done;
      }),
  );
  mount();
  await waitFor(() => expect(mocks.session).toHaveBeenCalled());
  const otherSession = "10000000-0000-4000-8000-000000000002";
  await useSessionLog.getState().begin(otherSession);
  resolve(makeSession(true));
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  expect(useSessionLog.getState().sessionId).toBe(otherSession);
  expect(useSessionLog.getState().drafts).toEqual({});
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("before GET hydrate the position gate still reads server actual with an explicitly empty draft map", () => {
  const session = makeSession(true);
  const drafts = new Map<string, boolean>();
  expect(drafts.size).toBe(0);
  const partial = new Map(
    session.planned_sets.map((set) => [set.id, set.performed_set?.completed === true]),
  );
  expect(
    resolveSessionPosition(null, session.planned_sets.filter(isResistancePlannedSet), partial),
  ).toEqual(
    resolveSessionPosition(null, session.planned_sets.filter(isResistancePlannedSet), drafts),
  );
  expect(
    resolveSessionPosition(null, session.planned_sets.filter(isResistancePlannedSet), drafts)
      ?.planned_set_id,
  ).toBe(session.planned_sets[1].id);
  session.planned_sets[1].performed_set = { ...record };
  expect(
    resolveSessionPosition(null, session.planned_sets.filter(isResistancePlannedSet), drafts),
  ).toBeNull();
  const all = new Map(
    session.planned_sets.map((set) => [set.id, set.performed_set?.completed === true]),
  );
  expect(
    resolveSessionPosition(null, session.planned_sets.filter(isResistancePlannedSet), all),
  ).toBeNull();
});

it("API seam complete probe observes a call to the existing completeSession function", async () => {
  expect(typeof api.completeSession).toBe("function");
  expect(mocks.complete).not.toHaveBeenCalled();
  await api.completeSession(SID);
  expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(SID);
});

it("the same recorded values have identical row markup after UI completion and GET hydration", async () => {
  mocks.session.mockResolvedValue(makeSession(false));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  fireEvent.change(recordInput(SET, "weight"), {
    target: { value: "72.5" },
  });
  fireEvent.change(recordInput(SET, "reps"), { target: { value: "8" } });
  fireEvent.change(recordInput(SET, "rir"), {
    target: { value: "1" },
  });
  fireEvent.click(document.querySelector(`[data-set-check="${SET}"]`)!);
  await waitFor(() =>
    expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  const local = document.querySelector(`[data-planned-set-id="${SET}"]`)!.innerHTML;
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  await waitFor(() =>
    expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(document.querySelector(`[data-planned-set-id="${SET}"]`)!.innerHTML).toBe(local);
});

it("mirror publication preserves a local write completed after its draft read began", async () => {
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 10, rir: 2, timeSec: null });
  const old = { ...useSessionLog.getState().drafts };
  let finishRead!: (drafts: typeof old) => void;
  const read = vi.spyOn(database, "loadDrafts").mockImplementationOnce(
    () =>
      new Promise((done) => {
        finishRead = done;
      }),
  );
  const refresh = useSessionLog.getState().refreshFromMirror(SID);
  expect(read).toHaveBeenCalledWith("dev-user", SID);
  await useSessionLog.getState().uncompleteSet(SET);
  const intent = useSessionLog.getState().drafts[SET];
  finishRead(old);
  await refresh;
  expect(useSessionLog.getState().drafts[SET]).toEqual(intent);
  expect(useSessionLog.getState().drafts[SET].completed).toBe(false);
});

it("an orphan pending delete protects against read resurrection in both durable and memory projection", async () => {
  await useSessionLog.getState().begin(SID);
  await sessionDb.outbox.put({
    user_id: "dev-user",
    client_id: "40000000-0000-4000-8000-000000000001",
    entity: "performed_set",
    entity_id: SET,
    op: "delete",
    payload: {},
    attempts: 0,
    updated_at: "2026-08-14T10:00:00.000Z",
  });
  expect(await sessionDb.drafts.count()).toBe(0);
  await database.readThroughSession("dev-user", SID, async () => makeSession(true));
  await useSessionLog.getState().publishSessionRead(SID, makeSession(true));
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(useSessionLog.getState().drafts).toEqual({});
  expect(await sessionDb.outbox.count()).toBe(1);
});

it("unknown pending intent defers projection visibly to developers and the next successful GET retries", async () => {
  await useSessionLog.getState().begin(SID);
  vi.spyOn(database, "pendingPerformedIds").mockRejectedValueOnce(new Error("read unavailable"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await useSessionLog.getState().publishSessionRead(SID, makeSession(true));
  expect(useSessionLog.getState().drafts).toEqual({});
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "Session record hydration deferred: local intent unavailable",
  );
  const read = await database.readThroughSession("dev-user", SID, async () => makeSession(true));
  await useSessionLog.getState().publishSessionRead(SID, read);
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  expect(await sessionDb.outbox.count()).toBe(0);
});
