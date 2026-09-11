// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
const { SessionScreen, refetchAuthoritativeSession } =
  await import("../components/session/SessionScreen");
const { sessionDb, DEV_USER_SCOPE: USER } = await import("../components/session/session-db");
const sessionPersistence = await import("../components/session/session-db");
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

async function preparePendingAppend() {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const source = {
    ...sets[0],
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
    recommendation_state: null,
    assistance_provenance: null,
    assistance_safety_status: null,
    recommended_action: null,
    recommendation_gate: "ready" as const,
  };
  const server = { ...session(sessionId), planned_sets: [source] };
  await sessionDb.sessions.put({
    user_id: USER,
    session_id: sessionId,
    session: server,
    updated_at: new Date().toISOString(),
  });
  const { commitSessionSetAppend } = await import("../components/session/session-set-append-db");
  await commitSessionSetAppend(
    { user_id: USER, session_id: sessionId },
    {
      exercise_id: "bench",
      today: server.scheduled_date,
      generation: 0,
      client_id: "00000000-0000-4000-8000-000000000100",
      correlation_id: "00000000-0000-4000-8000-000000000101",
      updated_at: new Date().toISOString(),
    },
  );
  mocks.session.mockResolvedValue(server);
  return { sessionId, source, server };
}

function holdNextMirrorRead(sessionId: string) {
  const original = sessionPersistence.readMirroredSession;
  let release!: () => void;
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  vi.spyOn(sessionPersistence, "readMirroredSession").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (armed && args[1] === sessionId) {
      armed = false;
      signal();
      await held;
    }
    return value;
  });
  return { entered, release };
}

function holdNextPositionRead(sessionId: string) {
  const original = positionStore.readPosition;
  let release!: () => void;
  let signal!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let armed = true;
  vi.spyOn(positionStore, "readPosition").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (armed && args[1] === sessionId) {
      armed = false;
      signal();
      await held;
    }
    return value;
  });
  return { entered, release };
}

it("the actual click keeps its parent source while position read waits and another append becomes max", async () => {
  const { sessionId } = await preparePendingAppend();
  mount(sessionId);
  const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  const hold = holdNextPositionRead(sessionId);
  try {
    fireEvent.click(button);
    await hold.entered;
    const append = await import("../components/session/session-set-append-db");
    await append.commitSessionSetAppend(
      { user_id: USER, session_id: sessionId },
      {
        exercise_id: "bench",
        today: new Date().toISOString().slice(0, 10),
        generation: 0,
        client_id: "00000000-0000-4000-8000-000000000102",
        correlation_id: "00000000-0000-4000-8000-000000000103",
        updated_at: new Date().toISOString(),
      },
    );
    await act(async () => {
      hold.release();
    });
    await screen.findByLabelText("벤치프레스 4세트 무게, 킬로그램");
    const state = await append.readAppendState({ user_id: USER, session_id: sessionId });
    expect(state.entries[2].intent.transport.payload.source).toEqual({
      source_correlation_id: "00000000-0000-4000-8000-000000000101",
    });
    expect(state.entries[2].lineage.parent_client_ids).toEqual([
      "00000000-0000-4000-8000-000000000100",
    ]);
    expect(await sessionDb.drafts.count()).toBe(0);
  } finally {
    hold.release();
  }
});

it.each(["revision", "route"])(
  "the actual waiting click rejects a changed %s without partial creation",
  async (kind) => {
    const { sessionId, server, source } = await preparePendingAppend();
    await sessionDb.syncMeta.delete([USER, `session-set-append:${sessionId}`]);
    await sessionDb.outbox.clear();
    const view = mount(sessionId);
    const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    const hold = holdNextPositionRead(sessionId);
    try {
      fireEvent.click(button);
      await hold.entered;
      const changed = {
        ...server,
        planned_sets: [
          {
            ...source,
            source_revision: "changed",
            append_eligibility: { ...source.append_eligibility, source_revision: "changed" },
          },
        ],
      };
      if (kind === "revision") {
        mocks.session.mockResolvedValue(changed);
        await sessionPersistence.mirrorSession(USER, sessionId, changed);
      } else {
        mocks.session.mockImplementation(async (id: string) => session(id));
        view.rerender(
          <QueryClientProvider client={clients[0]}>
            <SessionScreen sessionId="B" />
          </QueryClientProvider>,
        );
        await screen.findByLabelText("벤치프레스 3세트 무게, 킬로그램");
      }
      const before = {
        outbox: await sessionDb.outbox.toArray(),
        mirror: await sessionDb.sessions.get([USER, sessionId]),
        position: await positionStore.readPosition(USER, sessionId),
      };
      const calls = mocks.session.mock.calls.length;
      await act(async () => {
        hold.release();
      });
      if (kind === "revision") {
        await screen.findByText("다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요.");
        await waitFor(() => expect(mocks.session.mock.calls.length).toBeGreaterThan(calls));
      } else {
        await waitFor(() =>
          expect(clients[0].getMutationCache().getAll().at(-1)?.state.status).toBe("error"),
        );
        expect(screen.queryByRole("alert")).toBeNull();
      }
      expect(await sessionDb.outbox.toArray()).toEqual(before.outbox);
      expect((await sessionDb.sessions.get([USER, sessionId]))?.session).toEqual(
        before.mirror?.session,
      );
      expect(await positionStore.readPosition(USER, sessionId)).toEqual(before.position);
    } finally {
      hold.release();
    }
  },
);

it("an actual coordinator source_changed refreshes the server view without replacing the original blocked append intent", async () => {
  const { sessionId, source, server } = await preparePendingAppend();
  mount(sessionId);
  await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
  const original = (await sessionDb.outbox.toArray())[0];
  mocks.session.mockResolvedValue({
    ...server,
    planned_sets: [
      {
        ...source,
        recommended_weight: 65,
        source_revision: "fresh-revision",
        append_eligibility: { ...source.append_eligibility, source_revision: "fresh-revision" },
      },
    ],
  });
  const calls = mocks.session.mock.calls.length;
  await act(async () => {
    await new SyncCoordinator({
      userId: USER,
      transport: async () => ({
        applied: [],
        changes: [],
        next_cursor: "1",
        planned_set_mappings: [],
        conflicts: [
          {
            client_id: original.client_id,
            entity_id: sessionId,
            reason: "source_changed",
            retryable: false,
          },
        ],
      }),
    }).request();
  });
  await screen.findByText("다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요.");
  await waitFor(() => expect(mocks.session.mock.calls.length).toBeGreaterThan(calls));
  const pending = await sessionDb.outbox.toArray();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    client_id: original.client_id,
    entity_id: original.entity_id,
    updated_at: original.updated_at,
    payload: original.payload,
    sync_status: "blocked",
  });
  expect(screen.queryByLabelText("벤치프레스 2세트 무게, 킬로그램")).toBeNull();
  await waitFor(() =>
    expect(
      clients[0].getQueryData<Session>(["session", sessionId])?.planned_sets[0].recommended_weight,
    ).toBe(65),
  );
  expect((await sessionDb.sessions.get([USER, sessionId]))?.session).toMatchObject({
    planned_sets: [{ recommended_weight: 65, source_revision: "fresh-revision" }],
  });
  // The established SetRow input register is not overwritten by a late recommendation read.
  expect((screen.getByLabelText("벤치프레스 1세트 무게, 킬로그램") as HTMLInputElement).value).toBe(
    "60",
  );
  expect(await sessionDb.drafts.count()).toBe(0);
});

it("a held completion postcommit read preserves a new same-route input, completed draft, position and rest", async () => {
  const { sessionId, source } = await preparePendingAppend();
  const c = "00000000-0000-4000-8000-000000000400";
  await sessionPersistence.commitSessionCompletion(
    USER,
    sessionId,
    {},
    c,
    new Date().toISOString(),
  );
  mount(sessionId);
  await screen.findByText("인터넷 연결이 불안정해요. 연결되면 자동으로 이어서 진행할게요.");
  const hold = holdNextMirrorRead(sessionId);
  try {
    await act(async () => {
      await new SyncCoordinator({
        userId: USER,
        transport: async () => ({
          applied: [c],
          conflicts: [],
          changes: [],
          next_cursor: "1",
          planned_set_mappings: [],
        }),
      }).request();
      await hold.entered;
    });
    fireEvent.change(screen.getByLabelText("벤치프레스 1세트 무게, 킬로그램"), {
      target: { value: "75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "벤치프레스 1세트 완료 처리" }));
    await screen.findByRole("dialog", { name: "벤치프레스 1세트 후 휴식" });
    const timer = await timers.loadRestTimer(USER, sessionId, Date.now());
    await act(async () => {
      hold.release();
    });
    await waitFor(() => expect(screen.queryByText("수고했어요")).toBeNull());
    expect(screen.getByRole("dialog", { name: "벤치프레스 1세트 후 휴식" })).toBeTruthy();
    expect((await timers.loadRestTimer(USER, sessionId, Date.now()))?.timer).toEqual(timer?.timer);
    expect((await positionStore.readPosition(USER, sessionId)).position?.planned_set_id).toBe(
      source.id,
    );
    expect((await sessionDb.drafts.get([USER, sessionId, source.id]))?.actual_weight).toBe(75);
    expect(await sessionDb.outbox.get(c)).toBeUndefined();
  } finally {
    hold.release();
  }
});

it("reverse postcommit reads cannot restore a row removed by a newer same-route deletion", async () => {
  const rows = sets.map((set, i) => ({
    ...set,
    id: `00000000-0000-4000-8000-00000000001${i + 1}`,
    correlation_id: null,
  }));
  mocks.session.mockResolvedValue({ ...session(), planned_sets: rows });
  mount();
  await screen.findByLabelText("벤치프레스 3세트 무게, 킬로그램");
  const hold = holdNextMirrorRead("A");
  let draftReadsFinished = 0;
  const loadDrafts = sessionPersistence.loadDrafts;
  vi.spyOn(sessionPersistence, "loadDrafts").mockImplementation(async (...args) => {
    const result = await loadDrafts(...args);
    draftReadsFinished++;
    return result;
  });
  const remove = (index: number) =>
    new SyncCoordinator({
      userId: USER,
      transport: async () => ({
        applied: [],
        conflicts: [],
        planned_set_mappings: [],
        next_cursor: String(index),
        changes: [
          {
            entity: "session_routine",
            entity_id: "A",
            op: "upsert",
            server_seq: String(index),
            data: {
              tombstones: [
                { planned_set_id: rows[index].id, correlation_id: null, exercise_id: "bench" },
              ],
            },
          },
        ],
      }),
    }).request();
  try {
    await act(async () => {
      await remove(0);
      await hold.entered;
    });
    await act(async () => {
      await remove(1);
    });
    await waitFor(() =>
      expect(document.querySelector(`[data-planned-set-id="${rows[1].id}"]`)).toBeNull(),
    );
    const beforeRelease = draftReadsFinished;
    await act(async () => {
      hold.release();
    });
    await waitFor(() => expect(draftReadsFinished).toBeGreaterThan(beforeRelease));
    expect(document.querySelector(`[data-planned-set-id="${rows[0].id}"]`)).toBeNull();
    expect(document.querySelector(`[data-planned-set-id="${rows[1].id}"]`)).toBeNull();
    expect(document.querySelector(`[data-planned-set-id="${rows[2].id}"]`)).not.toBeNull();
  } finally {
    hold.release();
  }
});

it("actual FinishSheet keeps an append-dependent completion pending during transport outage without summary or cleanup", async () => {
  const { sessionId, source, server } = await preparePendingAppend();
  mount(sessionId);
  await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
  const before = await positionStore.readPosition(USER, sessionId);
  fireEvent.click(screen.getByRole("button", { name: "운동 종료" }));
  fireEvent.click(await screen.findByRole("button", { name: "그래도 종료" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
  expect(await positionStore.readPosition(USER, sessionId)).toEqual(before);
  const c = (await sessionDb.outbox.toArray()).find((row) => row.entity === "session");
  expect(c?.append_dependencies?.client_ids).toEqual(["00000000-0000-4000-8000-000000000100"]);
  expect((await sessionDb.sessions.get([USER, sessionId]))?.session).toMatchObject({
    status: "in_progress",
  });
  fireEvent.click(screen.getByRole("button", { name: "그래도 종료" }));
  await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "그래도 종료" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  expect((await sessionDb.outbox.toArray()).filter((row) => row.entity === "session")).toEqual([c]);
  const refreshed = await refetchAuthoritativeSession(clients[0], sessionId, async () => server);
  expect(refreshed?.planned_sets.map((row) => row.id)).toEqual([
    source.id,
    "00000000-0000-4000-8000-000000000101",
  ]);
  expect((await sessionDb.outbox.toArray()).filter((row) => row.entity === "session")).toEqual([c]);
});

it("actual offline QueryClient completes the local FinishSheet read without pausing or clearing fixed append facts", async () => {
  const { sessionId } = await preparePendingAppend();
  const previousOnline = onlineManager.isOnline();
  const view = mount(sessionId);
  try {
    await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
    fireEvent.click(screen.getByRole("button", { name: "벤치프레스 2세트 완료 처리" }));
    await screen.findByRole("dialog", { name: "벤치프레스 2세트 후 휴식" });
    fireEvent.click(screen.getByRole("button", { name: "휴식 종료" }));
    await waitFor(async () =>
      expect(await timers.loadRestTimer(USER, sessionId, Date.now())).toBeNull(),
    );
    const drafts = await sessionDb.drafts.toArray();
    const x = (await sessionDb.outbox.toArray()).find((row) => row.entity === "performed_set")!;
    expect(x).toBeDefined();
    const position = await positionStore.readPosition(USER, sessionId);
    await act(async () => onlineManager.setOnline(false));
    const serverQuery = vi.fn(async () => "authoritative server result");
    const serverResult = clients[0].fetchQuery({
      queryKey: ["default-server-query"],
      queryFn: serverQuery,
    });
    // A failed assertion still cancels this pending query during cleanup.
    void serverResult.catch(() => {});
    expect(clients[0].getQueryState(["default-server-query"])?.fetchStatus).toBe("paused");
    expect(serverQuery).not.toHaveBeenCalled();
    mocks.sync.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "운동 종료" }));
    fireEvent.click(await screen.findByRole("button", { name: "그래도 종료" }));
    await waitFor(async () => {
      const c = (await sessionDb.outbox.toArray()).find((row) => row.entity === "session");
      expect(c?.append_dependencies).toEqual({
        session_id: sessionId,
        client_ids: ["00000000-0000-4000-8000-000000000100"],
        performed_client_ids: [x.client_id],
      });
    });
    await waitFor(() =>
      expect(clients[0].getQueryState(["append-completion", sessionId])?.fetchStatus).toBe("idle"),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "계속하기" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("수고했어요")).toBeNull();
    expect(onlineManager.isOnline()).toBe(false);
    const outbox = await sessionDb.outbox.toArray();
    expect(outbox.find((row) => row.client_id === x.client_id)).toEqual(x);
    expect(await sessionDb.drafts.toArray()).toEqual(drafts);
    expect(await positionStore.readPosition(USER, sessionId)).toEqual(position);
    expect((await sessionDb.sessions.get([USER, sessionId]))?.session).toMatchObject({
      status: "in_progress",
    });
    fireEvent.click(screen.getByRole("button", { name: "그래도 종료" }));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "계속하기" }).hasAttribute("disabled")).toBe(false),
    );
    expect(await sessionDb.outbox.toArray()).toEqual(outbox);
    expect(await sessionDb.drafts.toArray()).toEqual(drafts);
    expect(onlineManager.isOnline()).toBe(false);
    expect(clients[0].getQueryState(["default-server-query"])?.fetchStatus).toBe("paused");
    expect(serverQuery).not.toHaveBeenCalled();
    await act(async () => {
      onlineManager.setOnline(true);
      expect(await serverResult).toBe("authoritative server result");
    });
    expect(serverQuery).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    await clients[0].cancelQueries();
    onlineManager.setOnline(previousOnline);
  }
});

it.each(["ACK first", "GET first"])(
  "an append ACK preserves the focused input node and uncommitted text after the initial focus effect (%s)",
  async (order) => {
    const { sessionId, server } = await preparePendingAppend();
    mount(sessionId);
    const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    const input = (await screen.findByLabelText(
      "벤치프레스 3세트 무게, 킬로그램",
    )) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "73." } });
    const reps = screen.getByLabelText("벤치프레스 3세트 횟수, 회") as HTMLInputElement;
    fireEvent.change(reps, { target: { value: "09" } });
    input.setSelectionRange(1, 2);
    const append = await import("../components/session/session-set-append-db");
    const before = await append.readAppendState({ user_id: USER, session_id: sessionId });
    const originalOutbox = await sessionDb.outbox.toArray();
    const sourceInput = screen.getByLabelText("벤치프레스 1세트 무게, 킬로그램");
    const mappings = before.entries.map((entry, index) => {
      const canonical = {
        ...entry.provisional,
        id: `00000000-0000-4000-8000-00000000050${index}`,
      } as PlannedSet;
      return {
        correlation_id: entry.provisional.id,
        planned_set_id: canonical.id,
        planned_set: canonical,
      };
    });
    const sent = vi.fn();
    mocks.session.mockResolvedValue({
      ...server,
      planned_sets: [...server.planned_sets, ...mappings.map((mapping) => mapping.planned_set)],
    });
    expect(await sessionDb.drafts.count()).toBe(0);
    if (order === "GET first") {
      await act(async () => {
        await clients[0].refetchQueries({ queryKey: ["session", sessionId], exact: true });
      });
      // Query completion precedes the observer's scheduled React notification.
      // Require the GET alone to render the canonical identity before sending ACK.
      await waitFor(() => expect(input.id).toBe(`set-${mappings[1].planned_set_id}-weight`));
      expect(input.isConnected).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(await sessionDb.outbox.toArray()).toEqual(originalOutbox);
    }
    await act(async () => {
      await new SyncCoordinator({
        userId: USER,
        transport: async (request) => {
          sent(request.mutations);
          return {
            applied: before.entries.map((entry) => entry.intent.transport.client_id),
            conflicts: [],
            changes: [],
            next_cursor: "append-focus-ack",
            planned_set_mappings: mappings,
          };
        },
      }).request();
    });
    const canonicalId = mappings[1].planned_set_id;
    await waitFor(() =>
      expect(document.getElementById(`set-${canonicalId}-weight`)).not.toBeNull(),
    );
    expect.soft(input.isConnected).toBe(true);
    expect
      .soft((document.getElementById(`set-${canonicalId}-weight`) as HTMLInputElement).value)
      .toBe("73.");
    expect
      .soft((document.getElementById(`set-${canonicalId}-reps`) as HTMLInputElement).value)
      .toBe("09");
    expect(document.getElementById(`set-${canonicalId}-weight`)).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("73.");
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
    expect(document.getElementById(`set-${canonicalId}-reps`)).toBe(reps);
    expect(reps.value).toBe("09");
    expect(sourceInput.isConnected).toBe(true);
    expect(screen.getByLabelText("벤치프레스 1세트 무게, 킬로그램")).toBe(sourceInput);
    const rowKeys = clients[0]
      .getQueryData<Session>(["session", sessionId])!
      .planned_sets.map((row) => row.correlation_id ?? row.id);
    expect(rowKeys).toHaveLength(3);
    expect(new Set(rowKeys).size).toBe(3);
    expect(document.querySelectorAll(`[data-planned-set-id="${canonicalId}"]`)).toHaveLength(1);
    expect(
      document.querySelector(`[data-planned-set-id="${before.entries[1].provisional.id}"]`),
    ).toBeNull();
    expect(sent).toHaveBeenCalledWith(before.entries.map((entry) => entry.intent.transport));
    expect(originalOutbox).toHaveLength(2);
    expect(await sessionDb.outbox.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
    expect((await positionStore.readPosition(USER, sessionId)).position?.planned_set_id).toBe(
      canonicalId,
    );
    expect(await timers.loadRestTimer(USER, sessionId, Date.now())).toBeNull();
  },
);

it.each(["mirror", "append state"])(
  "an ACK before append's first focus effect uses the canonical row after the creation %s read resumes",
  async (read) => {
    const { sessionId, server } = await preparePendingAppend();
    mount(sessionId);
    const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    const append = await import("../components/session/session-set-append-db");
    let hold: { entered: Promise<void>; release: () => void };
    if (read === "mirror") {
      hold = holdNextMirrorRead(sessionId);
    } else {
      const original = append.readAppendState;
      let signal!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The mirror reader also reads append metadata for safety. Hold the
      // mutation's following state read, not that earlier nested safety read.
      let armed = false;
      let mirrorReturned = false;
      const originalMirror = sessionPersistence.readMirroredSession;
      vi.spyOn(sessionPersistence, "readMirroredSession").mockImplementation(async (...args) => {
        const value = await originalMirror(...args);
        if (!mirrorReturned) {
          mirrorReturned = true;
          armed = true;
        }
        return value;
      });
      vi.spyOn(append, "readAppendState").mockImplementation(async (...args) => {
        const value = await original(...args);
        if (armed && value.entries.length === 2) {
          armed = false;
          signal();
          await pending;
        }
        return value;
      });
      hold = { entered, release };
    }
    try {
      fireEvent.click(button);
      await hold.entered;
      const before = await append.readAppendState({ user_id: USER, session_id: sessionId });
      expect(before.entries).toHaveLength(2);
      expect(screen.queryByLabelText("벤치프레스 3세트 무게, 킬로그램")).toBeNull();
      const mappings = before.entries.map((entry, index) => {
        const canonical = {
          ...entry.provisional,
          id: `00000000-0000-4000-8000-00000000050${index}`,
          source_revision: `ack-revision-${index}`,
          append_eligibility: {
            version: 1,
            source_revision: `ack-revision-${index}`,
            cohort_revision: "ack-cohort",
            status: "allowed",
            reason: null,
          },
        } as PlannedSet;
        return {
          correlation_id: entry.provisional.id,
          planned_set_id: canonical.id,
          planned_set: canonical,
        };
      });
      mocks.session.mockResolvedValue({
        ...server,
        planned_sets: [...server.planned_sets, ...mappings.map((mapping) => mapping.planned_set)],
      });
      await act(async () => {
        await new SyncCoordinator({
          userId: USER,
          transport: async () => ({
            applied: before.entries.map((entry) => entry.intent.transport.client_id),
            conflicts: [],
            changes: [],
            next_cursor: "append-before-focus",
            planned_set_mappings: mappings,
          }),
        }).request();
      });
      expect(await sessionDb.outbox.count()).toBe(0);
      const canonicalId = mappings[1].planned_set_id;
      const mountedBeforeFocus = await screen.findByLabelText("벤치프레스 3세트 무게, 킬로그램");
      expect(mountedBeforeFocus.id).toBe(`set-${canonicalId}-weight`);
      expect(document.activeElement).not.toBe(mountedBeforeFocus);
      await waitFor(() =>
        expect(
          clients[0].getQueryData<typeof before>(["session-append", sessionId])!.generation,
        ).toBeGreaterThan(before.generation),
      );
      const currentState = clients[0].getQueryData<typeof before>(["session-append", sessionId])!;
      const currentView = clients[0].getQueryData<Session>(["session", sessionId])!;
      expect(currentView.planned_sets).toEqual([
        ...server.planned_sets,
        ...mappings.map((mapping) => mapping.planned_set),
      ]);
      const views: Session[] = [];
      const publishedStates: (typeof before)[] = [];
      const unsubscribe = clients[0].getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.query.queryKey[0] === "session-append" &&
          event.query.queryKey[1] === sessionId
        )
          publishedStates.push(structuredClone(event.query.state.data as typeof before));
        if (
          event.type === "updated" &&
          event.query.queryKey[0] === "session" &&
          event.query.queryKey[1] === sessionId
        )
          views.push(event.query.state.data as Session);
      });
      try {
        await act(async () => hold.release());
        await waitFor(() => expect(document.activeElement).toBe(mountedBeforeFocus));
      } finally {
        unsubscribe();
      }
      expect(mountedBeforeFocus.isConnected).toBe(true);
      expect(mountedBeforeFocus.id).toBe(`set-${canonicalId}-weight`);
      expect(views.length).toBeGreaterThan(0);
      for (const view of views) expect(view).toEqual(currentView);
      expect(publishedStates.length).toBeGreaterThan(0);
      for (const published of publishedStates) expect(published).toEqual(currentState);
      expect(clients[0].getQueryData(["session-append", sessionId])).toEqual(currentState);
      expect(currentState.entries.map((entry) => entry.intent)).toEqual(
        before.entries.map((entry) => entry.intent),
      );
      expect(document.querySelectorAll(`[data-planned-set-id="${canonicalId}"]`)).toHaveLength(1);
      expect(
        document.querySelector(`[data-planned-set-id="${before.entries[1].provisional.id}"]`),
      ).toBeNull();
      expect((await positionStore.readPosition(USER, sessionId)).position?.planned_set_id).toBe(
        canonicalId,
      );
      expect(await sessionDb.drafts.count()).toBe(0);
      expect(await timers.loadRestTimer(USER, sessionId, Date.now())).toBeNull();
    } finally {
      await act(async () => hold.release());
    }
  },
);

it("actual append affordance commits a copied pending child and focuses its row without creating actuals or timers", async () => {
  const { sessionId } = await preparePendingAppend();
  mount(sessionId);
  const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  const input = await screen.findByLabelText("벤치프레스 3세트 무게, 킬로그램");
  await waitFor(() => expect(document.activeElement).toBe(input));
  const state = await (
    await import("../components/session/session-set-append-db")
  ).readAppendState({ user_id: USER, session_id: sessionId });
  expect(state.entries).toHaveLength(2);
  expect(state.entries[1].intent.transport.payload.source).toEqual({
    source_correlation_id: state.entries[0].provisional.id,
  });
  expect((await positionStore.readPosition(USER, sessionId)).position?.planned_set_id).toBe(
    state.entries[1].provisional.id,
  );
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(await timers.loadRestTimer(USER, sessionId, Date.now())).toBeNull();
  fireEvent.click(button);
  await screen.findByLabelText("벤치프레스 4세트 무게, 킬로그램");
  expect(await sessionDb.outbox.where("user_id").equals(USER).count()).toBe(3);
});

it("an explicit blocked append permit shows the approved reason without inventing a retry or writing an intent", async () => {
  const { sessionId, source, server } = await preparePendingAppend();
  await sessionDb.syncMeta.delete([USER, `session-set-append:${sessionId}`]);
  await sessionDb.outbox.clear();
  mocks.session.mockResolvedValue({
    ...server,
    planned_sets: [
      {
        ...source,
        append_eligibility: {
          ...source.append_eligibility,
          status: "blocked",
          reason: "unsafe_assistance_snapshot",
        },
      },
    ],
  });
  mount(sessionId);
  await screen.findByText("이 운동은 지금 세트를 추가할 수 없어요.");
  const button = screen.getByRole("button", { name: "벤치프레스 세트 추가" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
    "이 운동은 지금 세트를 추가할 수 없어요.",
  );
  expect(screen.queryByRole("button", { name: "다시 불러오기" })).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("a new append and its focused position survive an older same-route completion read", async () => {
  const { sessionId } = await preparePendingAppend();
  const c = "00000000-0000-4000-8000-000000000400";
  await sessionPersistence.commitSessionCompletion(
    USER,
    sessionId,
    {},
    c,
    new Date().toISOString(),
  );
  mount(sessionId);
  const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  const hold = holdNextMirrorRead(sessionId);
  try {
    await act(async () => {
      await new SyncCoordinator({
        userId: USER,
        transport: async () => ({
          applied: [c],
          conflicts: [],
          changes: [],
          next_cursor: "1",
          planned_set_mappings: [],
        }),
      }).request();
      await hold.entered;
    });
    fireEvent.click(button);
    const input = await screen.findByLabelText("벤치프레스 3세트 무게, 킬로그램");
    await waitFor(() => expect(document.activeElement).toBe(input));
    const position = await positionStore.readPosition(USER, sessionId);
    await act(async () => {
      hold.release();
    });
    await waitFor(() =>
      expect(clients[0].getQueryData<Session>(["session", sessionId])?.planned_sets).toHaveLength(
        3,
      ),
    );
    expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(await positionStore.readPosition(USER, sessionId)).toEqual(position);
    expect(await sessionDb.outbox.get(c)).toBeUndefined();
    expect((await sessionDb.outbox.toArray()).map((row) => row.entity)).toEqual([
      "session_set",
      "session_set",
    ]);
  } finally {
    hold.release();
  }
});

it("append remains disabled for an old mirror without eligibility and a full ten-row exercise", async () => {
  const { sessionId, source, server } = await preparePendingAppend();
  await sessionDb.syncMeta.delete([USER, `session-set-append:${sessionId}`]);
  await sessionDb.outbox.clear();
  const old = { ...server, planned_sets: [{ ...source, append_eligibility: null }] };
  mocks.session.mockResolvedValue(old);
  mount(sessionId);
  const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await screen.findByText("세트를 추가할 수 있는지 확인하지 못했어요. 다시 불러와 주세요.");
  mocks.session.mockResolvedValue(server);
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  const full = {
    ...server,
    planned_sets: Array.from({ length: 10 }, (_, i) => ({
      ...source,
      id: `00000000-0000-4000-8000-${String(i + 20).padStart(12, "0")}`,
      set_no: i + 1,
    })),
  };
  await act(async () => {
    await refetchAuthoritativeSession(clients[0], sessionId, async () => full);
  });
  await screen.findByLabelText("벤치프레스 10세트 무게, 킬로그램");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("세트 수는 1~10 사이로 정해 주세요.")).toBeTruthy();
  expect(await sessionDb.outbox.count()).toBe(0);
});

it.each(["2026-08-13", "2026-08-15"])(
  "append alone explains the non-today date %s without changing other edit controls",
  async (scheduled_date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-14T23:59:59.000Z"));
    try {
      const { sessionId, server } = await preparePendingAppend();
      await sessionDb.syncMeta.delete([USER, `session-set-append:${sessionId}`]);
      await sessionDb.outbox.clear();
      mocks.session.mockResolvedValue({ ...server, scheduled_date });
      mount(sessionId);
      const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
      await screen.findByText("세트는 오늘 운동에만 추가할 수 있어요.");
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByLabelText("벤치프레스 1세트 무게, 킬로그램").hasAttribute("disabled"),
      ).toBe(false);
      expect(await sessionDb.outbox.count()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("UTC today completed edit can append at the KST next-day boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-14T23:59:59.000Z"));
  try {
    const { sessionId, server } = await preparePendingAppend();
    await sessionDb.syncMeta.delete([USER, `session-set-append:${sessionId}`]);
    await sessionDb.outbox.clear();
    mocks.session.mockResolvedValue({
      ...server,
      scheduled_date: "2026-08-14",
      status: "completed",
    });
    mount(sessionId);
    fireEvent.click(await screen.findByRole("button", { name: "기록 더하거나 고치기" }));
    const button = await screen.findByRole("button", { name: "벤치프레스 세트 추가" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByLabelText("벤치프레스 2세트 무게, 킬로그램");
    expect((await sessionDb.outbox.toArray()).map((row) => row.entity)).toEqual(["session_set"]);
    expect(await sessionDb.drafts.count()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("reload keeps durable C waiting without summary, then completion-only coordinator ACK shows summary and clears timer once", async () => {
  const { sessionId, source } = await preparePendingAppend();
  const { commitSessionCompletion } = await import("../components/session/session-db");
  const provisional = "00000000-0000-4000-8000-000000000101";
  const c = "00000000-0000-4000-8000-000000000400";
  const appendId = "00000000-0000-4000-8000-000000000100";
  const canonical = {
    ...source,
    set_no: 2,
    id: "00000000-0000-4000-8000-000000000500",
    correlation_id: provisional,
  };
  await new SyncCoordinator({
    userId: USER,
    transport: async () => ({
      applied: [appendId],
      conflicts: [],
      changes: [],
      next_cursor: "1",
      planned_set_mappings: [
        { correlation_id: provisional, planned_set_id: canonical.id, planned_set: canonical },
      ],
    }),
  }).request();
  await useSessionLog.getState().begin(sessionId);
  for (const id of [source.id, canonical.id])
    await useSessionLog.getState().completeSet(id, { weight: 60, reps: 8, rir: 2, timeSec: null });
  await sessionDb.syncMeta.delete(key(sessionId)); // No position + all completed normally selects summary.
  await commitSessionCompletion(USER, sessionId, {}, c, new Date().toISOString());
  const timer = { totalSec: 90, endsAt: Date.now() + 60000 };
  await timers.saveRestTimer(USER, sessionId, canonical.id, "완료 대기 중 휴식", timer);
  const original = await sessionDb.outbox.get(c);
  const view = mount(sessionId);
  await screen.findByRole("heading", { name: "오늘 운동" });
  await screen.findByText("인터넷 연결이 불안정해요. 연결되면 자동으로 이어서 진행할게요.");
  expect(screen.queryByText("수고했어요")).toBeNull();
  expect(await sessionDb.outbox.get(c)).toEqual(original);
  await screen.findByRole("dialog", { name: "완료 대기 중 휴식" });
  view.unmount();
  mount(sessionId);
  await screen.findByText("인터넷 연결이 불안정해요. 연결되면 자동으로 이어서 진행할게요.");
  await act(async () => {
    await new SyncCoordinator({
      userId: USER,
      transport: async () => ({
        applied: [c],
        conflicts: [],
        changes: [],
        next_cursor: "2",
        planned_set_mappings: [],
      }),
    }).request();
  });
  await screen.findByText("수고했어요");
  expect(screen.queryByRole("dialog", { name: "완료 대기 중 휴식" })).toBeNull();
  expect(await timers.loadRestTimer(USER, sessionId, Date.now())).toBeNull();
  expect(await sessionDb.outbox.get(c)).toBeUndefined();
});

it("a postcommit identity-only remote deletion updates an ordinary visible session without append, preserving facts and re-added identity", async () => {
  const old = { ...sets[0], id: "00000000-0000-4000-8000-000000000011", correlation_id: null };
  const readded = {
    ...sets[1],
    id: "00000000-0000-4000-8000-000000000012",
    correlation_id: "00000000-0000-4000-8000-000000000112",
  };
  const server = { ...session(), planned_sets: [old, readded] };
  mocks.session.mockResolvedValue(server);
  mount();
  await screen.findByLabelText("벤치프레스 1세트 무게, 킬로그램");
  await useSessionLog
    .getState()
    .completeSet(old.id, { weight: 60, reps: 8, rir: 2, timeSec: null });
  const facts = await sessionDb.drafts.toArray();
  const mutations = await sessionDb.outbox.toArray();
  const sync = new SyncCoordinator({
    userId: USER,
    transport: async () => ({
      applied: [],
      conflicts: [],
      planned_set_mappings: [],
      next_cursor: "1",
      changes: [
        {
          entity: "session_routine",
          entity_id: "A",
          op: "upsert",
          server_seq: "1",
          data: {
            tombstones: [{ planned_set_id: old.id, correlation_id: null, exercise_id: "bench" }],
          },
        },
      ],
    }),
  });
  await act(async () => {
    await sync.request();
  });
  await waitFor(() =>
    expect(document.querySelector(`[data-planned-set-id="${old.id}"]`)).toBeNull(),
  );
  expect(document.querySelector(`[data-planned-set-id="${readded.id}"]`)).not.toBeNull();
  await act(async () => {
    await sync.request();
    await refetchAuthoritativeSession(clients[0], "A", async () => server);
  });
  expect(document.querySelector(`[data-planned-set-id="${old.id}"]`)).toBeNull();
  expect(await sessionDb.drafts.toArray()).toEqual(facts);
  expect((await sessionDb.outbox.toArray()).map(({ attempts: _a, ...row }) => row)).toEqual(
    mutations.map(({ attempts: _a, ...row }) => row),
  );
});

it.each([false, true])(
  "completed GET cannot hide durable C after reload (terminal=%s)",
  async (blocked) => {
    const { sessionId, server } = await preparePendingAppend();
    const { commitSessionCompletion } = await import("../components/session/session-db");
    const c = "00000000-0000-4000-8000-000000000400";
    await commitSessionCompletion(USER, sessionId, {}, c, new Date().toISOString());
    if (blocked)
      await new SyncCoordinator({
        userId: USER,
        transport: async () => ({
          applied: [],
          changes: [],
          next_cursor: "1",
          planned_set_mappings: [],
          conflicts: [
            { client_id: c, entity_id: sessionId, reason: "dependent_conflict", retryable: false },
          ],
        }),
      }).request();
    const before = await sessionDb.outbox.get(c);
    mocks.session.mockResolvedValue({ ...server, status: "completed" });
    const view = mount(sessionId);
    const message = blocked
      ? "다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요."
      : "인터넷 연결이 불안정해요. 연결되면 자동으로 이어서 진행할게요.";
    await screen.findByText(message);
    expect(screen.queryByText("수고했어요")).toBeNull();
    view.unmount();
    mount(sessionId);
    await screen.findByText(message);
    expect(screen.queryByText("수고했어요")).toBeNull();
    expect(await sessionDb.outbox.get(c)).toEqual(before);
  },
);

it("rolled-back remote deletion emits no mirror notification and late A commit never changes B", async () => {
  const old = { ...sets[0], id: "00000000-0000-4000-8000-000000000011", correlation_id: null };
  mocks.session.mockImplementation(async (id) =>
    id === "A" ? { ...session(), planned_sets: [old, sets[1]] } : session(id),
  );
  const view = mount();
  await screen.findByLabelText("벤치프레스 1세트 무게, 킬로그램");
  const { SYNC_RESPONSE_EVENT } = await import("../components/session/sync-coordinator");
  const notified = vi.fn();
  window.addEventListener(SYNC_RESPONSE_EVENT, notified);
  const wire = {
    applied: [],
    conflicts: [],
    planned_set_mappings: [],
    next_cursor: "1",
    changes: [
      {
        entity: "session_routine" as const,
        entity_id: "A",
        op: "upsert" as const,
        server_seq: "1",
        data: {
          tombstones: [{ planned_set_id: old.id, correlation_id: null, exercise_id: "bench" }],
        },
      },
    ],
  };
  try {
    const originalPut = sessionDb.syncMeta.put.bind(sessionDb.syncMeta);
    const fault = vi.spyOn(sessionDb.syncMeta, "put").mockImplementation((...args) => {
      if (args[0].key === "cursor") throw new Error("cursor commit fault");
      return originalPut(...args);
    });
    await expect(
      new SyncCoordinator({ userId: USER, transport: async () => wire }).request(),
    ).rejects.toThrow("cursor commit fault");
    fault.mockRestore();
    expect(notified).not.toHaveBeenCalled();
    expect(document.querySelector(`[data-planned-set-id="${old.id}"]`)).not.toBeNull();
    await putPosition(record("set-3", false, "B"));
    view.rerender(
      <QueryClientProvider client={clients[0]}>
        <SessionScreen sessionId="B" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-session-current="true"]')
          ?.getAttribute("data-planned-set-id"),
      ).toBe("set-3"),
    );
    await act(async () => {
      await new SyncCoordinator({ userId: USER, transport: async () => wire }).request();
    });
    expect(notified).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-session-current="true"]')?.getAttribute("data-planned-set-id"),
    ).toBe("set-3");
    expect(screen.queryByText("수고했어요")).toBeNull();
  } finally {
    window.removeEventListener(SYNC_RESPONSE_EVENT, notified);
  }
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
