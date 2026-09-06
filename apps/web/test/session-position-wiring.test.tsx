// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session, PlannedSet } from "../lib/api";

const mocks = vi.hoisted(() => ({ session: vi.fn(), sync: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, session: mocks.session } };
});
vi.mock("../components/session/exercise-catalog", async () => {
  const actual = await vi.importActual<typeof import("../components/session/exercise-catalog")>(
    "../components/session/exercise-catalog",
  );
  const { default: seed } = await import("../../../docs/specs/exercises_seed.json");
  return {
    ...actual,
    fetchAllExercises: async () => [
      { id: "bench", name_ko: "벤치프레스", metric: "reps", step_kg: 2.5, primary_muscles: [] },
      seed.exercises.find((exercise) => exercise.id === "e_plank")!,
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
const { sessionDb, DEV_USER_SCOPE: USER } = await import("../components/session/session-db");
const { useSessionLog } = await import("../components/session/session-store");
const positionStore = await import("../components/session/session-position");
const timers = await import("../components/session/rest-timer-store");
const { SyncCoordinator } = await import("../components/session/sync-coordinator");
const clients: QueryClient[] = [];
const scroll = vi.fn();
const key = (sessionId = "A") => [USER, `session-position:${sessionId}`];
const sets = [1, 2, 3].map((n) => ({
  id: `set-${n}`,
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
const session = (id = "A", status: Session["status"] = "in_progress") =>
  ({
    id,
    program_id: "p",
    goal: "hypertrophy",
    status,
    scheduled_date: new Date().toISOString().slice(0, 10),
    planned_sets: sets,
  }) as Session;
const record = (id = "set-2", expanded = false, sessionId = "A") => ({
  v: 1,
  session_id: sessionId,
  generation: 0,
  position: { exercise_id: "bench", planned_set_id: id, expanded },
});
async function putPosition(value = record()) {
  await sessionDb.syncMeta.put({
    user_id: USER,
    key: `session-position:${value.session_id}`,
    value: JSON.stringify(value),
  });
}
function mount(id = "A") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <SessionScreen sessionId={id} />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  mocks.session.mockClear();
  mocks.sync.mockClear();
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
  mocks.session.mockImplementation(async (id: string) => session(id));
  mocks.sync.mockResolvedValue(null);
  scroll.mockClear();
  HTMLElement.prototype.scrollIntoView = scroll;
});
afterEach(async () => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  await sessionDb.delete();
});

it("actual input records identity only; remount restores the row once without focusing an input", async () => {
  const first = mount();
  const input = await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
  fireEvent.change(input, { target: { value: "73" } });
  await waitFor(async () =>
    expect(JSON.parse((await sessionDb.syncMeta.get(key()))!.value)).toEqual(record()),
  );
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
  first.unmount();
  scroll.mockClear();
  mount();
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-2"),
  );
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(document.body);
  expect((screen.getByLabelText("벤치프레스 2세트 무게, 킬로그램") as HTMLInputElement).value).toBe(
    "60",
  );
});

it("restores a committed expanded completed row without keyboard focus", async () => {
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("set-2", { weight: 73, reps: 8, rir: 1, timeSec: null });
  await putPosition(record("set-2", true));
  const before = await sessionDb.drafts.toArray();
  mount();
  await waitFor(() =>
    expect(
      document.querySelector('[data-planned-set-id="set-2"]')?.getAttribute("data-expanded"),
    ).toBe("true"),
  );
  expect((screen.getByLabelText("벤치프레스 2세트 무게, 킬로그램") as HTMLInputElement).value).toBe(
    "73",
  );
  expect(document.activeElement).toBe(document.body);
  expect(await sessionDb.drafts.toArray()).toEqual(before);
});

it("late position hydration cannot scroll back over an explicit input action", async () => {
  await putPosition();
  const original = positionStore.readPosition;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(positionStore, "readPosition").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (args[1] === "A") await held;
    return value;
  });
  mount();
  const input = await screen.findByLabelText("벤치프레스 3세트 무게, 킬로그램");
  fireEvent.change(input, { target: { value: "74" } });
  await act(async () => {
    release();
  });
  await waitFor(async () =>
    expect((await original(USER, "A")).position?.planned_set_id).toBe("set-3"),
  );
  expect(scroll).not.toHaveBeenCalled();
});

it("completed reload defaults to summary; only the explicit edit CTA reopens records", async () => {
  mocks.session.mockResolvedValue(session("A", "completed"));
  mount();
  const edit = await screen.findByRole("button", { name: "기록 더하거나 고치기" });
  expect(screen.queryByLabelText("벤치프레스 1세트 무게, 킬로그램")).toBeNull();
  fireEvent.click(edit);
  fireEvent.change(await screen.findByLabelText("벤치프레스 1세트 무게, 킬로그램"), {
    target: { value: "65" },
  });
  await waitFor(async () =>
    expect(JSON.parse((await sessionDb.syncMeta.get(key()))!.value).position.planned_set_id).toBe(
      "set-1",
    ),
  );
});

it("a late remote completed GET preserves an explicit input, while remount still defaults to summary", async () => {
  const view = mount();
  const input = await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
  fireEvent.change(input, { target: { value: "73" } });
  await waitFor(async () =>
    expect((await positionStore.readPosition(USER, "A")).position?.planned_set_id).toBe("set-2"),
  );
  mocks.session.mockResolvedValue(session("A", "completed"));
  await act(async () => {
    await clients[0].refetchQueries({ queryKey: ["session", "A"] });
  });
  await screen.findByText("이미 종료한 운동이에요. 오늘 안에는 기록을 더하거나 고칠 수 있어요.");
  expect(screen.getByLabelText("벤치프레스 2세트 무게, 킬로그램")).toBe(input);
  expect((input as HTMLInputElement).value).toBe("73");
  expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
  view.unmount();
  mount();
  await screen.findByRole("button", { name: "기록 더하거나 고치기" });
  expect(screen.queryByLabelText("벤치프레스 2세트 무게, 킬로그램")).toBeNull();
});

it("an explicit add remains visible after its actual ACK and authoritative remote completed GET", async () => {
  mount();
  await screen.findByLabelText("벤치프레스 1세트 무게, 킬로그램");
  const canonical = [1, 2, 3].map((n) => ({
    ...sets[0],
    id: `plank-${n}`,
    exercise_id: "e_plank",
    set_no: n,
    load_kind: "not_applicable",
    recommended_weight: null,
    recommended_reps: null,
    target_reps_low: null,
    target_reps_high: null,
    target_rir: null,
    target_time_low_sec: 20,
    target_time_high_sec: 60,
  })) as PlannedSet[];
  const completed = { ...session("A", "completed"), planned_sets: [...sets, ...canonical] };
  const sync = new SyncCoordinator({
    transport: async (body) => {
      const routine = body.mutations.find((mutation) => mutation.entity === "session_routine")!;
      expect(routine).toBeTruthy();
      const saved = (await sessionDb.routines.get([USER, "A"]))!;
      expect(saved.correlations).toHaveLength(3);
      return {
        applied: [routine.client_id],
        conflicts: [],
        changes: [],
        next_cursor: "remote-complete",
        planned_set_mappings: saved.correlations.map((correlation, index) => ({
          correlation_id: correlation.correlation_id,
          planned_set_id: canonical[index].id,
          planned_set: canonical[index],
        })),
      };
    },
  });
  mocks.sync.mockImplementation(() => sync.request());
  mocks.session.mockResolvedValue(completed);
  fireEvent.click(screen.getByRole("button", { name: "운동 추가" }));
  fireEvent.click(screen.getByRole("tab", { name: "코어" }));
  fireEvent.click(screen.getByRole("button", { name: /플랭크/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "운동 추가" })).toBeNull());
  expect(screen.getByRole("heading", { name: "플랭크" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(clients[0].getQueryData<Session>(["session", "A"])?.status).toBe("completed");
});

it("hydration and programmatic focus do not opt into editing a remotely completed session", async () => {
  await putPosition();
  mount();
  const input = await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
  act(() => input.focus());
  mocks.session.mockResolvedValue(session("A", "completed"));
  await act(async () => {
    await clients[0].refetchQueries({ queryKey: ["session", "A"] });
  });
  await screen.findByRole("button", { name: "기록 더하거나 고치기" });
  expect(screen.queryByLabelText("벤치프레스 2세트 무게, 킬로그램")).toBeNull();
});

it("same-instance route changes discard editing intent for completed B and return to completed A", async () => {
  const view = mount();
  fireEvent.change(await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램"), {
    target: { value: "73" },
  });
  mocks.session.mockImplementation(async (id: string) => session(id, "completed"));
  await act(async () => {
    await clients[0].refetchQueries({ queryKey: ["session", "A"] });
  });
  await screen.findByText("이미 종료한 운동이에요. 오늘 안에는 기록을 더하거나 고칠 수 있어요.");
  // Preload completed B so the prop change cannot briefly borrow A's editing state.
  clients[0].setQueryData(["session", "B"], session("B", "completed"));
  for (const id of ["B", "A"]) {
    view.rerender(
      <QueryClientProvider client={clients[0]}>
        <SessionScreen sessionId={id} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: "기록 더하거나 고치기" });
    expect(screen.queryByRole("button", { name: "운동 추가" })).toBeNull();
    expect(screen.queryByLabelText("벤치프레스 2세트 무게, 킬로그램")).toBeNull();
  }
});

it("A → B → A restores independent identity and ignores late A hydration", async () => {
  await putPosition(record());
  await putPosition(record("set-3", false, "B"));
  let release!: (value: Session) => void;
  mocks.session.mockImplementation((id: string) =>
    id === "A"
      ? new Promise<Session>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(session(id)),
  );
  const first = mount();
  await waitFor(() => expect(mocks.session).toHaveBeenCalled());
  first.unmount();
  const second = mount("B");
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-3"),
  );
  await act(async () => {
    release(session());
  });
  expect(
    document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
  ).toBe("set-3");
  second.unmount();
  mocks.session.mockResolvedValue(session());
  mount();
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-2"),
  );
});

it("deleted saved row falls back within exercise without rewriting position or inventing a draft", async () => {
  await putPosition(record("removed", true));
  mount();
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-1"),
  );
  expect(JSON.parse((await sessionDb.syncMeta.get(key()))!.value)).toEqual(record("removed", true));
  expect(await sessionDb.drafts.count()).toBe(0);
});

it("removing the last saved member falls back to summary without reviving its identity", async () => {
  await putPosition(record("removed", true));
  mocks.session.mockResolvedValue({ ...session(), planned_sets: [] });
  mount();
  await screen.findByRole("button", { name: "기록 더하거나 고치기" });
  expect(document.querySelector('[data-session-current="true"]')).toBeNull();
  expect(JSON.parse((await sessionDb.syncMeta.get(key()))!.value)).toEqual(record("removed", true));
});

it("completion clears active position durably", async () => {
  const view = mount();
  fireEvent.change(await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램"), {
    target: { value: "73" },
  });
  await waitFor(async () =>
    expect((await positionStore.readPosition(USER, "A")).position?.planned_set_id).toBe("set-2"),
  );
  // Exercise the actual FinishSheet; a transport outage still follows the existing local completion contract.
  fireEvent.click(screen.getByRole("button", { name: "운동 종료" }));
  const finish = await screen.findByRole("button", { name: "그래도 종료" });
  fireEvent.click(finish);
  await screen.findByRole("button", { name: "기록 더하거나 고치기" });
  expect((await positionStore.readPosition(USER, "A")).position).toBeNull();
  view.unmount();
});

it("without a valid position, all completed rows show summary beside exactly one existing timer", async () => {
  await useSessionLog.getState().begin("A");
  for (const set of sets)
    await useSessionLog
      .getState()
      .completeSet(set.id, { weight: 60, reps: 8, rir: 2, timeSec: null });
  const timer = { totalSec: 90, endsAt: Date.now() + 60000 };
  await timers.saveRestTimer(USER, "A", "set-3", "마지막 세트 후 휴식", timer);
  const before = await sessionDb.drafts.toArray();
  mount();
  await screen.findByText("수고했어요");
  const dialog = await screen.findByRole("dialog", { name: "마지막 세트 후 휴식" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect((await timers.loadRestTimer(USER, "A", Date.now()))?.timer).toEqual(timer);
  expect(await sessionDb.drafts.toArray()).toEqual(before);
  expect(await sessionDb.syncMeta.get(key())).toBeUndefined();
  // Unrelated query notifications cannot remount the live timer.
  await act(async () => {
    clients[0].setQueryData(["session", "A"], { ...session() });
  });
  expect(screen.getByRole("dialog", { name: "마지막 세트 후 휴식" })).toBe(dialog);
  fireEvent.click(screen.getByRole("button", { name: "휴식 종료" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("수고했어요")).toBeTruthy();
});

it("a failed completion transaction retains position and committed records", async () => {
  await putPosition();
  mount();
  await waitFor(() => expect(document.querySelector('[data-session-current="true"]')).toBeTruthy());
  vi.spyOn(sessionDb.outbox, "put").mockRejectedValueOnce(new Error("disk full"));
  fireEvent.click(screen.getByRole("button", { name: "운동 종료" }));
  fireEvent.click(await screen.findByRole("button", { name: "그래도 종료" }));
  await screen.findByRole("alert");
  expect((await positionStore.readPosition(USER, "A")).position).toEqual(record().position);
  expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
});

it("membership removal after restoration falls back once, without moving later explicit input on refetch", async () => {
  await putPosition();
  mount();
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-2"),
  );
  await act(async () => {
    clients[0].setQueryData(["session", "A"], {
      ...session(),
      planned_sets: sets.filter((set) => set.id !== "set-2"),
    });
  });
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-1"),
  );
  fireEvent.change(screen.getByLabelText("벤치프레스 3세트 무게, 킬로그램"), {
    target: { value: "70" },
  });
  scroll.mockClear();
  await act(async () => {
    clients[0].setQueryData(["session", "A"], { ...session() });
  });
  expect(
    document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
  ).toBe("set-3");
  expect(scroll).not.toHaveBeenCalled();
});

it("actual ACK and a late GET keep a newer focused row while remapping the committed record", async () => {
  const local = {
    ...session(),
    planned_sets: sets.map((set) => (set.id === "set-2" ? { ...set, id: "local" } : set)),
  };
  mocks.session.mockResolvedValue(local);
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("local", { weight: 73, reps: 8, rir: 1, timeSec: null });
  await putPosition(record("local", true));
  mount();
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("local"),
  );
  let release!: (value: Session) => void;
  const held = new Promise<Session>((resolve) => {
    release = resolve;
  });
  mocks.session.mockImplementationOnce(() => held);
  const fetching = clients[0].refetchQueries({ queryKey: ["session", "A"] });
  const input = screen.getByLabelText("벤치프레스 3세트 무게, 킬로그램");
  act(() => {
    input.focus();
  });
  fireEvent.change(input, { target: { value: "81" } });
  await waitFor(async () =>
    expect((await positionStore.readPosition(USER, "A")).position?.planned_set_id).toBe("set-3"),
  );
  const canonical = { ...sets[1], id: "server" };
  const mapped = { ...session(), planned_sets: [sets[0], canonical, sets[2]] };
  mocks.session.mockResolvedValue(mapped);
  scroll.mockClear();
  await act(async () => {
    await new SyncCoordinator({
      transport: async () => ({
        applied: [],
        conflicts: [],
        changes: [],
        next_cursor: "mapped",
        planned_set_mappings: [
          { correlation_id: "local", planned_set_id: "server", planned_set: canonical },
        ],
      }),
    }).request();
    release(local);
    await fetching;
  });
  await waitFor(() =>
    expect(document.querySelector('[data-planned-set-id="server"]')).toBeTruthy(),
  );
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("81");
  expect(scroll).not.toHaveBeenCalled();
  expect((await positionStore.readPosition(USER, "A")).position?.planned_set_id).toBe("set-3");
  expect(useSessionLog.getState().drafts.server.actual_weight).toBe(73);
  expect(useSessionLog.getState().drafts.local).toBeUndefined();
});

const performed = (weight: number | null, reps: number | null, completed = true) => ({
  actual_weight: weight,
  actual_reps: reps,
  actual_rir: 2,
  actual_time_sec: null,
  completed,
  performed_at: "2026-08-14T08:00:00.000Z",
});
it("server-only completed summary reads current membership actuals without creating local drafts or outbox", async () => {
  mocks.session.mockResolvedValue({
    ...session("A", "completed"),
    planned_sets: [
      { ...sets[0], performed_set: performed(60, 8) },
      { ...sets[1], performed_set: performed(99, 10, false) },
    ],
  });
  mount();
  await screen.findByText("오늘 1세트, 480kg 들었어요.");
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
});
it("summary local edits and explicit uncomplete beat server actuals; removed local membership contributes nothing", async () => {
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("set-1", { weight: 50, reps: 5, rir: 1, timeSec: null });
  await useSessionLog
    .getState()
    .completeSet("set-2", { weight: 70, reps: 10, rir: 1, timeSec: null });
  await useSessionLog.getState().uncompleteSet("set-2");
  await useSessionLog
    .getState()
    .completeSet("removed", { weight: 999, reps: 99, rir: 1, timeSec: null });
  const before = JSON.stringify([
    await sessionDb.drafts.toArray(),
    await sessionDb.outbox.toArray(),
  ]);
  mocks.session.mockResolvedValue({
    ...session("A", "completed"),
    planned_sets: sets.map((set) => ({ ...set, performed_set: performed(60, 8) })),
  });
  mount();
  await screen.findByText("오늘 2세트, 730kg 들었어요.");
  expect(JSON.stringify([await sessionDb.drafts.toArray(), await sessionDb.outbox.toArray()])).toBe(
    before,
  );
});
it("summary uses snapshot load_kind, counting assistance/bodyweight/time while excluding their kg volume", async () => {
  mocks.session.mockResolvedValue({
    ...session("A", "completed"),
    planned_sets: [
      { ...sets[0], performed_set: performed(60, 8) },
      {
        ...sets[1],
        exercise_id: "e_assisted_pullup",
        load_kind: "external",
        performed_set: performed(30, 6),
      },
      {
        ...sets[2],
        load_kind: "assistance",
        assistance_safety_status: "safe",
        performed_set: performed(20, 10),
      },
      { ...sets[0], id: "body", load_kind: "bodyweight", performed_set: performed(80, 10) },
      {
        ...sets[0],
        id: "time",
        load_kind: "not_applicable",
        performed_set: { ...performed(80, 10), actual_time_sec: 30 },
      },
    ],
  });
  mount();
  await screen.findByText("오늘 5세트, 660kg 들었어요.");
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("a pending A completion clears A only and cannot replace B's active screen when it settles", async () => {
  await putPosition(record());
  await putPosition(record("set-3", false, "B"));
  let release!: () => void;
  const held = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  mocks.sync.mockReturnValue(held);
  const view = mount();
  await waitFor(() => expect(document.querySelector('[data-session-current="true"]')).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "운동 종료" }));
  fireEvent.click(await screen.findByRole("button", { name: "그래도 종료" }));
  await waitFor(() => expect(mocks.sync).toHaveBeenCalled());
  view.rerender(
    <QueryClientProvider client={clients[0]}>
      <SessionScreen sessionId="B" />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-3"),
  );
  await act(async () => {
    release();
  });
  await waitFor(async () =>
    expect((await positionStore.readPosition(USER, "A")).position).toBeNull(),
  );
  expect(
    document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
  ).toBe("set-3");
  expect((await positionStore.readPosition(USER, "B")).position?.planned_set_id).toBe("set-3");
  expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
});
