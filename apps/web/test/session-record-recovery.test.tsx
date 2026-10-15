// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectPrivateEqual, expectPrivateMatch } from "./support/private-record-assertions";
import type { DashboardSummary, Session } from "../lib/api";
import { RECORDED_BENCH_TEXT, recordedText, recordInput } from "./support/record-controls";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  sync: vi.fn(),
  complete: vi.fn(),
  currentWeek: vi.fn(),
  dashboard: vi.fn(),
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  const replacements: Partial<typeof actual.api> = {
    session: mocks.session,
    completeSession: mocks.complete,
    currentWeek: mocks.currentWeek,
    dashboard: mocks.dashboard,
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
const { ActualWeekDays } = await import("../components/program/ActualWeekDays");
const { refreshAfterWeekSwap } = await import("../lib/week-swap-refresh");
const { sessionDb } = await import("../components/session/session-db");
const database = await import("../components/session/session-db");
const { api } = await import("../lib/api");
const { useSessionLog } = await import("../components/session/session-store");
const { resolveSessionPosition } = await import("../components/session/session-position");
const { isResistancePlannedSet } = await import("../components/session/cardio-read");
const clients: QueryClient[] = [];
const subscriptions: (() => void)[] = [];
const SID = "10000000-0000-4000-8000-000000000001";
const PID = "20000000-0000-4000-8000-000000000001";
const SET = "30000000-0000-4000-8000-000000000001";
const OTHER_SID = "10000000-0000-4000-8000-000000000002";
const OTHER_SET = "30000000-0000-4000-8000-000000000501";
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
function otherSession(): Session {
  return {
    ...makeSession(false),
    id: OTHER_SID,
    scheduled_date: "2026-08-15",
    planned_sets: makeSession(false).planned_sets.map((row, index) => ({
      ...row,
      id: index === 0 ? OTHER_SET : "30000000-0000-4000-8000-000000000502",
    })),
  };
}
const readScenarios = ["server", "local", "uncheck", "orphan-delete", "switch"] as const;
type ReadScenario = (typeof readScenarios)[number];
async function prepareReadIntent(
  scenario: ReadScenario,
  view: ReturnType<typeof render>,
  client: QueryClient,
) {
  const put = vi.spyOn(sessionDb.drafts, "put");
  if (scenario === "switch") {
    await act(async () => {
      view.rerender(
        <QueryClientProvider client={client}>
          <SessionScreen sessionId={OTHER_SID} />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(useSessionLog.getState().sessionId).toBe(OTHER_SID));
    await waitFor(() =>
      expect(client.getQueryData<Session>(["session", OTHER_SID])?.id).toBe(OTHER_SID),
    );
  } else if (scenario !== "server") {
    // Keep this user's new intent pending while the earlier read finishes.
    mocks.sync.mockResolvedValue(null);
    await act(async () => {
      await useSessionLog
        .getState()
        .completeSet(SET, { weight: 80, reps: 8, rir: 1, timeSec: null });
      if (scenario !== "local") await useSessionLog.getState().uncompleteSet(SET);
    });
    expect(put).toHaveBeenCalled();
    if (scenario === "orphan-delete") await sessionDb.drafts.delete(["dev-user", SID, SET]);
  }
  put.mockClear();
  return {
    client,
    memory: useSessionLog.getState().drafts,
    put,
    pending: (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set"),
  };
}
async function assertReadIntent(
  scenario: ReadScenario,
  before: Awaited<ReturnType<typeof prepareReadIntent>>,
) {
  expectPrivateEqual(
    (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set"),
    before.pending,
  );
  if (scenario !== "server") expectPrivateEqual(useSessionLog.getState().drafts, before.memory);
  if (scenario === "orphan-delete") {
    expect(await sessionDb.drafts.get(["dev-user", SID, SET])).toBeUndefined();
    expect(before.put).not.toHaveBeenCalled();
  }
  if (scenario === "switch") {
    expect(useSessionLog.getState().sessionId).toBe(OTHER_SID);
    expect(before.client.getQueryData<Session>(["session", OTHER_SID])?.id).toBe(OTHER_SID);
    assertQueryIdentities(before.client);
    return; // This future session is readonly; its memory bytes are the SID-isolation oracle.
  }
  const setId = SET;
  expect(document.querySelector(`[data-set-check="${setId}"]`)?.getAttribute("aria-pressed")).toBe(
    scenario === "server" || scenario === "local" ? "true" : "false",
  );
  assertQueryIdentities(before.client);
}
function assertQueryIdentities(client: QueryClient) {
  for (const [key, session] of client.getQueriesData<Session>({ queryKey: ["session"] })) {
    if (session && key.length === 2) expect(session.id).toBe(key[1]);
  }
}
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
  mocks.currentWeek.mockReset();
  mocks.dashboard.mockReset();
  mocks.sync.mockResolvedValue(null);
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  vi.restoreAllMocks();
  clients.splice(0).forEach((client) => client.clear());
  await sessionDb.delete();
  vi.useRealTimers();
});

it("publication callee rejects mismatched payload identity before reading intent", async () => {
  await useSessionLog.getState().begin(SID);
  const memory = useSessionLog.getState().drafts;
  const load = vi.spyOn(database, "loadDrafts");
  const pending = vi.spyOn(database, "pendingPerformedIds");
  const wrong: Session = {
    ...otherSession(),
    program_id: "20000000-0000-4000-8000-000000000002",
    scheduled_date: "2026-08-14",
  };
  await expect(useSessionLog.getState().publishSessionRead(SID, wrong)).rejects.toThrow(
    "Session read identity mismatch",
  );
  expect(load).not.toHaveBeenCalled();
  expect(pending).not.toHaveBeenCalled();
  expectPrivateEqual(useSessionLog.getState().drafts, memory);
  expect(await sessionDb.outbox.count()).toBe(0);

  await useSessionLog.getState().publishSessionRead(SID, makeSession(true));
  expect(load).toHaveBeenCalledOnce();
  expect(pending).toHaveBeenCalledOnce();
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  await useSessionLog.getState().uncompleteSet(SET);
  const intents = (await sessionDb.outbox.toArray()).filter(
    (row) => row.entity === "performed_set",
  );
  expect(intents).toHaveLength(1);
  expect(intents[0].op).toBe("delete");
});

it.each(readScenarios)(
  "R2: explicit authority refresh preserves %s intent and session identity",
  async (scenario) => {
    mocks.session.mockImplementation(async (id) =>
      id === OTHER_SID ? otherSession() : makeSession(false),
    );
    const view = mount();
    await screen.findByRole("button", { name: "벤치프레스 메뉴" });
    expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    let resolve!: (value: Session) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Session>((done) => {
          resolve = done;
        }),
    );
    const read = refetchAuthoritativeSession(clients[0], SID, fetch);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const before = await prepareReadIntent(scenario, view, clients[0]);
    await act(async () => {
      resolve(makeSession(true));
      await read;
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
    await assertReadIntent(scenario, before);
  },
);

it("R2: a real routine conflict refresh supplies a usable check before asking to uncheck", async () => {
  mocks.session.mockResolvedValueOnce(makeSession(false)).mockResolvedValue(makeSession(true));
  mocks.sync.mockImplementation(async () => {
    const routine = (await sessionDb.outbox.toArray()).find(
      (row) => row.entity === "session_routine",
    );
    if (!routine) return null;
    const { SyncCoordinator } = await import("../components/session/sync-coordinator");
    return new SyncCoordinator({
      userId: "dev-user",
      transport: async () => ({
        applied: [],
        conflicts: [{ client_id: routine.client_id, entity_id: SID, reason: "conflict" }],
        changes: [],
        planned_set_mappings: [],
        next_cursor: "authority-conflict-cursor",
      }),
    }).request();
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "벤치프레스 메뉴" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "벤치프레스 삭제" }));
  fireEvent.click(await screen.findByRole("button", { name: "루틴에서 빼기" }));
  await screen.findAllByText("기록이 남은 운동은 뺄 수 없어요. 완료 체크를 먼저 해제해 주세요.");
  expect(mocks.session).toHaveBeenCalledTimes(2);
  expect((await sessionDb.drafts.toArray()).filter((row) => row.completed).length).toBe(1);
  expect(
    (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set"),
  ).toHaveLength(0);
  expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
    "true",
  );
});

it.each(readScenarios)(
  "R3: the GET after exact routine ACK preserves %s intent and session identity",
  async (scenario) => {
    mocks.session.mockResolvedValueOnce(makeSession(false));
    let resolve!: (session: Session) => void;
    let entered!: () => void;
    const readStarted = new Promise<void>((done) => {
      entered = done;
    });
    const fresh = makeSession(true);
    fresh.planned_sets[1].performed_set = record;
    const source = makeSession(false).planned_sets[0];
    if (!isResistancePlannedSet(source)) throw new Error("R3 fixture requires a resistance source");
    const canonical: Session["planned_sets"] = [1, 2, 3].map((setNo) => ({
      ...source,
      id: `30000000-0000-4000-8000-00000000010${setNo}`,
      exercise_id: "e_plank",
      set_no: setNo,
      load_kind: "not_applicable",
      recommended_weight: null,
      recommended_reps: null,
      target_reps_low: null,
      target_reps_high: null,
      target_rir: null,
      target_time_low_sec: 20,
      target_time_high_sec: 60,
      performed_set: null,
    }));
    fresh.planned_sets.push(...canonical);
    const mapped = makeSession(false);
    mapped.planned_sets[1].performed_set = record;
    mapped.planned_sets.push(...canonical);
    let authorityFetch = false;
    const readThrough = database.readThroughSession;
    vi.spyOn(database, "readThroughSession").mockImplementation((userId, id, fetch, options) =>
      readThrough(
        userId,
        id,
        () => {
          const prior = authorityFetch;
          authorityFetch = options?.offlineFallback === false;
          try {
            return fetch();
          } finally {
            authorityFetch = prior;
          }
        },
        options,
      ),
    );
    mocks.session.mockImplementation((id) => {
      if (id === OTHER_SID) return Promise.resolve(otherSession());
      if (!authorityFetch) return Promise.resolve(mapped);
      entered();
      return new Promise<Session>((done) => {
        resolve = done;
      });
    });
    let routineClient: string | undefined;
    const { SyncCoordinator } = await import("../components/session/sync-coordinator");
    const sync = new SyncCoordinator({
      userId: "dev-user",
      transport: async (body) => {
        const routine = body.mutations.find((mutation) => mutation.entity === "session_routine");
        expect(routine).toBeDefined();
        routineClient = routine!.client_id;
        const saved = (await sessionDb.routines.get(["dev-user", SID]))!;
        expect(saved.correlations).toHaveLength(3);
        return {
          applied: [routineClient],
          conflicts: [],
          changes: [
            {
              entity: "performed_set",
              entity_id: fresh.planned_sets[1].id,
              session_id: SID,
              op: "upsert",
              server_seq: "1",
              data: record,
            },
          ],
          next_cursor: "exact-routine-read",
          planned_set_mappings: saved.correlations.map((correlation, index) => ({
            correlation_id: correlation.correlation_id,
            planned_set_id: canonical[index].id,
            planned_set: canonical[index],
          })),
        };
      },
    });
    mocks.sync.mockImplementation(() => sync.request());
    try {
      const view = mount();
      await screen.findByRole("button", { name: "벤치프레스 메뉴" });
      fireEvent.click(screen.getByRole("button", { name: "운동 추가" }));
      fireEvent.click(screen.getByRole("tab", { name: "코어" }));
      fireEvent.click(await screen.findByRole("button", { name: /플랭크/ }));
      await readStarted;
      const receipt = await mocks.sync.mock.results[0].value;
      expect(receipt.applied).toEqual([routineClient]);
      await waitFor(() =>
        expect(useSessionLog.getState().drafts[fresh.planned_sets[1].id]?.completed).toBe(true),
      );
      expect(Boolean(useSessionLog.getState().drafts[SET]?.completed)).toBe(false);
      const before = await prepareReadIntent(scenario, view, clients[0]);
      await act(async () => {
        resolve(fresh);
      });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "운동 추가" })).toBeNull());
      await waitFor(() =>
        expect(
          clients[0]
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.status === "pending"),
        ).toBe(false),
      );
      expect(mocks.session.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.session.mock.calls.every(([id]) => id === SID || id === OTHER_SID)).toBe(true);
      await assertReadIntent(scenario, before);
    } finally {
      resolve?.(fresh);
    }
  },
);

it.each(readScenarios)(
  "R7: remediation's later GET preserves %s intent and session identity",
  async (scenario) => {
    mocks.session.mockImplementation(async (id) =>
      id === OTHER_SID ? otherSession() : makeSession(false),
    );
    const view = mount();
    await screen.findByRole("button", { name: "벤치프레스 메뉴" });
    await database.markRemediationPending("dev-user", SID);
    const actualProcessor = database.processRemediationMarkers;
    let finished = false;
    vi.spyOn(database, "processRemediationMarkers").mockImplementation(async (...args) => {
      try {
        return await actualProcessor(...args);
      } finally {
        finished = true;
      }
    });
    const { SyncCoordinator } = await import("../components/session/sync-coordinator");
    let resolve!: (value: Session) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Session>((done) => {
          resolve = done;
        }),
    );
    const transport = vi.fn(async () => ({
      applied: [],
      conflicts: [],
      changes: [],
      planned_set_mappings: [],
      next_cursor: "remediation-read",
    }));
    await act(async () => {
      await new SyncCoordinator({ userId: "dev-user", fetchSession: fetch, transport }).request();
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(SID));
    const before = await prepareReadIntent(scenario, view, clients[0]);
    await act(async () => {
      resolve(makeSession(true));
    });
    await waitFor(() => expect(finished).toBe(true));
    expect(fetch).toHaveBeenCalledWith(SID);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await database.isRemediationPending("dev-user", SID)).toBe(false);
    await assertReadIntent(scenario, before);
  },
);

it.each(readScenarios)(
  "R4: program-detail GET at re-entry preserves %s intent and session identity",
  async (scenario) => {
    await useSessionLog.getState().begin(SID);
    const ids = makeSession(false).planned_sets.map((set) => set.id);
    mocks.currentWeek.mockResolvedValue({
      program_id: PID,
      week_start: "2026-08-10",
      sessions: [
        {
          id: SID,
          scheduled_date: "2026-08-14",
          focus: "upper",
          status: "scheduled",
          origin: "planned",
          revision: "entry-revision",
          planned_set_ids: ids,
          exercises: [{ exercise_id: "bench", set_count: ids.length, planned_set_ids: ids }],
        },
      ],
    });
    let resolve!: (session: Session) => void;
    mocks.session.mockImplementation((id) =>
      id === OTHER_SID
        ? Promise.resolve(otherSession())
        : new Promise<Session>((done) => {
            resolve = done;
          }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const view = render(
      <QueryClientProvider client={client}>
        <ActualWeekDays programId={PID} names={new Map([["bench", "벤치프레스"]])} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(document.querySelector(`[data-week-session-id="${SID}"] button`)).not.toBeNull(),
    );
    fireEvent.click(document.querySelector(`[data-week-session-id="${SID}"] button`)!);
    await waitFor(() => expect(mocks.session).toHaveBeenCalledTimes(1));
    const completion = client
      .getQueryCache()
      .find({ queryKey: ["session", SID], exact: true })?.promise;
    expect(completion).toBeDefined();
    view.rerender(
      <QueryClientProvider client={client}>
        <SessionScreen sessionId={SID} />
      </QueryClientProvider>,
    );
    expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
    const before = await prepareReadIntent(scenario, view, client);
    await act(async () => {
      resolve(makeSession(true));
      await completion;
    });
    await screen.findByRole("button", { name: "벤치프레스 메뉴" });
    expect(mocks.session).toHaveBeenCalledTimes(scenario === "switch" ? 2 : 1);
    await assertReadIntent(scenario, before);
  },
);

it.each(readScenarios)(
  "R5: week-swap refresh settling after re-entry preserves %s intent and session identity",
  async (scenario) => {
    await useSessionLog.getState().begin(SID);
    const ids = makeSession(false).planned_sets.map((set) => set.id);
    mocks.currentWeek.mockResolvedValue({
      program_id: PID,
      week_start: "2026-08-10",
      sessions: [
        {
          id: SID,
          scheduled_date: "2026-08-14",
          focus: "upper",
          status: "scheduled",
          origin: "planned",
          revision: "swap-revision",
          planned_set_ids: ids,
          exercises: [{ exercise_id: "bench", set_count: ids.length, planned_set_ids: ids }],
        },
      ],
    });
    const dashboard: DashboardSummary = {
      date: "2026-08-14",
      today: {
        status: "unperformed",
        session_id: SID,
        routine_summary: { exercise_count: 1, focus: "upper" },
        done_summary: null,
      },
      tomorrow: { status: "rest", routine_summary: null },
      streak_days: 0,
      weekly_completion_rate: 0,
      weekly_rhythm: [],
      primary_e1rm: null,
    };
    mocks.dashboard.mockResolvedValue(dashboard);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const view = render(
      <QueryClientProvider client={client}>
        <ActualWeekDays programId={PID} names={new Map()} />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(document.querySelector(`[data-week-session-id="${SID}"]`)).not.toBeNull(),
    );
    let resolve!: (session: Session) => void;
    let entered!: () => void;
    const readStarted = new Promise<void>((done) => {
      entered = done;
    });
    let authorityFetch = false,
      freshAvailable = false;
    const readThrough = database.readThroughSession;
    vi.spyOn(database, "readThroughSession").mockImplementation((userId, id, fetch, options) =>
      readThrough(
        userId,
        id,
        () => {
          const prior = authorityFetch;
          authorityFetch = options?.offlineFallback === false;
          try {
            return fetch();
          } finally {
            authorityFetch = prior;
          }
        },
        options,
      ),
    );
    mocks.session.mockImplementation((id) => {
      if (id === OTHER_SID) return Promise.resolve(otherSession());
      if (!authorityFetch) return Promise.resolve(makeSession(freshAvailable));
      entered();
      return new Promise<Session>((done) => {
        resolve = done;
      });
    });
    const refresh = refreshAfterWeekSwap(client, PID, [SID]);
    try {
      await readStarted;
      view.rerender(
        <QueryClientProvider client={client}>
          <SessionScreen sessionId={SID} />
        </QueryClientProvider>,
      );
      await screen.findByRole("button", { name: "벤치프레스 메뉴" });
      expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
      const before = await prepareReadIntent(scenario, view, client);
      freshAvailable = true;
      await act(async () => {
        resolve(makeSession(true));
        await refresh;
      });
      expect(mocks.dashboard).toHaveBeenCalledTimes(1);
      expect(mocks.session.mock.calls.every(([id]) => id === SID || id === OTHER_SID)).toBe(true);
      await assertReadIntent(scenario, before);
    } finally {
      resolve?.(makeSession(true));
      await refresh.catch(() => undefined);
    }
  },
);

const restorationMatrix = ["fresh", "same-day-resume", "past-completed"].flatMap((phase) =>
  [false, true].flatMap((completed) =>
    ["entry", "reload"].flatMap((entry) =>
      ["server", "pending"].map((intent) => ({ phase, completed, entry, intent })),
    ),
  ),
);
it.each([false, true])(
  "B7: append check=%s keeps display, lock and identity through GET/ACK/reload",
  async (completed) => {
    const original = makeSession(false).planned_sets[0];
    if (!isResistancePlannedSet(original)) throw new Error("B7 requires resistance source");
    if (typeof original.rest_sec !== "number") throw new Error("B7 requires numeric source rest");
    const source = {
      ...original,
      confidence: 0.3,
      append_eligibility: {
        version: 1 as const,
        source_revision: original.source_revision!,
        cohort_revision: "b7-cohort",
        status: "allowed" as const,
        reason: null,
      },
    };
    const baseline: Session = { ...makeSession(false), planned_sets: [source] };
    await database.readThroughSession("dev-user", SID, async () => baseline);
    const append = await import("../components/session/session-set-append-db");
    const parentId = "40000000-0000-4000-8000-000000000700";
    const provisionalId = "30000000-0000-4000-8000-000000000701";
    const canonicalId = "30000000-0000-4000-8000-000000000702";
    const entry = await append.commitSessionSetAppend(
      { user_id: "dev-user", session_id: SID },
      {
        exercise_id: "bench",
        today: "2026-08-14",
        generation: 0,
        client_id: parentId,
        correlation_id: provisionalId,
        updated_at: new Date().toISOString(),
      },
    );
    await useSessionLog.getState().begin(SID);
    if (completed)
      await useSessionLog
        .getState()
        .completeSet(provisionalId, { weight: 80, reps: 8, rir: 1, timeSec: null });
    const child = (await sessionDb.outbox.toArray()).find((row) => row.entity === "performed_set");
    expect(Boolean(child)).toBe(completed);
    const canonical = {
      ...entry.provisional,
      rest_sec: original.rest_sec,
      id: canonicalId,
      correlation_id: provisionalId,
    };
    let server: Session = baseline;
    mocks.session.mockImplementation(async () => server);
    const checkStage = async (id: string) => {
      await waitFor(() =>
        expect(
          document.querySelector(`[data-set-check="${id}"]`)?.getAttribute("aria-pressed"),
        ).toBe(String(completed)),
      );
      expect(document.querySelector(`[data-planned-set-id="${id}"]`)).not.toBeNull();
      if (completed) expect(recordedText(id)).toContain("80");
      fireEvent.click(screen.getByRole("button", { name: "벤치프레스 메뉴" }));
      for (const action of ["삭제", "교체"]) {
        expect(
          screen
            .getByRole("menuitem", { name: `벤치프레스 ${action}` })
            .getAttribute("aria-disabled"),
        ).toBe(completed ? "true" : null);
      }
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(useSessionLog.getState().drafts[id]?.planned_set_id ?? id).toBe(id);
      const position = await import("../components/session/session-position");
      expect((await position.readPosition("dev-user", SID)).position?.planned_set_id).toBe(id);
    };
    mount();
    await screen.findByRole("button", { name: "벤치프레스 메뉴" });
    await checkStage(provisionalId);
    const originalTransport = await sessionDb.outbox.get(parentId);
    server = { ...baseline, planned_sets: [source, canonical] };
    await act(async () => {
      await refetchAuthoritativeSession(clients[0], SID, async () => server);
    });
    await checkStage(canonicalId);
    expect(await sessionDb.drafts.get(["dev-user", SID, provisionalId])).toBeUndefined();
    expectPrivateEqual(await sessionDb.outbox.get(parentId), originalTransport);
    expect(
      (await append.readAppendState({ user_id: "dev-user", session_id: SID })).entries[0].execution
        .phase,
    ).toBe("pending");
    const { SyncCoordinator } = await import("../components/session/sync-coordinator");
    const transport = vi.fn(async () => ({
      applied: [parentId, ...(child ? [child.client_id] : [])],
      conflicts: [],
      changes: [],
      next_cursor: "b7-ack",
      planned_set_mappings: [
        { correlation_id: provisionalId, planned_set_id: canonicalId, planned_set: canonical },
      ],
    }));
    await act(async () => {
      await new SyncCoordinator({ userId: "dev-user", transport }).request();
    });
    server = {
      ...server,
      planned_sets: [
        source,
        { ...canonical, performed_set: completed ? { ...record, actual_weight: 80 } : null },
      ],
    };
    await act(async () => {
      await refetchAuthoritativeSession(clients[0], SID, async () => server);
    });
    await checkStage(canonicalId);
    expect(
      (await append.readAppendState({ user_id: "dev-user", session_id: SID })).entries[0].execution
        .phase,
    ).toBe("applied");
    expect(await sessionDb.outbox.count()).toBe(0);
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    sessionDb.close();
    await sessionDb.open();
    useSessionLog.setState({ sessionId: null, drafts: {} });
    mount();
    await screen.findByRole("button", { name: "벤치프레스 메뉴" });
    await checkStage(canonicalId);
    expect(document.querySelector(`[data-planned-set-id="${provisionalId}"]`)).toBeNull();
    expect(await sessionDb.outbox.count()).toBe(0);
  },
);
it.each(
  ["swap", "delete-readd"].flatMap((operation) =>
    ["empty", "complete", "uncheck", "orphan-delete", "latest"].map((intent) => ({
      operation,
      intent,
      completed: intent === "complete" || intent === "latest",
    })),
  ),
)(
  "B7: $operation $intent check=$completed keeps new lineage through GET/ACK/reload",
  async ({ operation, completed, intent }) => {
    const { buildProvisionalRoutineSets } = await import("shared");
    const { fetchAllExercises, requireResistanceCatalogExercise } =
      await import("../components/session/exercise-catalog");
    const exercise = (await fetchAllExercises()).find((item) => item.id === "e_plank");
    if (!exercise) throw new Error("B7 canonical seed missing");
    const ids = [711, 712, 713].map((n) => `30000000-0000-4000-8000-000000000${n}`);
    const source = makeSession(false).planned_sets[0];
    if (!isResistancePlannedSet(source)) throw new Error("B7 requires resistance source");
    const build = (keys: string[]) =>
      buildProvisionalRoutineSets("hypertrophy", requireResistanceCatalogExercise(exercise), keys);
    const serverRows = (keys: string[]) =>
      build(keys).map((row) => ({
        ...source,
        ...row,
        load_kind: "not_applicable" as const,
        source_revision: "b7-lineage",
        correlation_id: row.id,
        append_eligibility: null,
      }));
    const baseline: Session = {
      ...makeSession(false),
      planned_sets: operation === "swap" ? makeSession(false).planned_sets : serverRows([SET]),
    };
    await database.readThroughSession("dev-user", SID, async () => baseline);
    // A same-exercise completion from another session/date must not lock these new rows.
    vi.setSystemTime(new Date("2026-08-12T09:00:00.000Z"));
    await useSessionLog.getState().begin(OTHER_SID);
    await useSessionLog
      .getState()
      .completeSet(OTHER_SET, { weight: null, reps: null, rir: null, timeSec: 20 });
    vi.setSystemTime(new Date("2026-08-14T10:00:00.000Z"));
    const foreign = (await sessionDb.outbox.toArray()).filter(
      (row) => row.entity === "performed_set",
    );
    await useSessionLog.getState().begin(SID);
    const { SyncCoordinator } = await import("../components/session/sync-coordinator");
    if (operation === "delete-readd") {
      await useSessionLog
        .getState()
        .completeSet(SET, { weight: null, reps: null, rir: null, timeSec: 30 });
      await useSessionLog.getState().uncompleteSet(SET);
      const oldIntents = (await sessionDb.outbox.toArray()).filter(
        (row) => row.entity === "performed_set" && row.entity_id === SET,
      );
      const deletion = oldIntents.find((row) => row.op === "delete")!;
      expect(deletion.op).toBe("delete");
      await new SyncCoordinator({
        userId: "dev-user",
        transport: async () => ({
          applied: oldIntents.map((row) => row.client_id),
          conflicts: [],
          changes: [],
          planned_set_mappings: [],
          next_cursor: "b7-delete",
        }),
      }).request();
      await database.commitRoutineSnapshot(
        "dev-user",
        SID,
        [],
        "40000000-0000-4000-8000-000000000710",
        new Date().toISOString(),
        [],
        { ...baseline, planned_sets: [] },
      );
      await new SyncCoordinator({
        userId: "dev-user",
        transport: async () => ({
          applied: ["40000000-0000-4000-8000-000000000710"],
          conflicts: [],
          changes: [],
          planned_set_mappings: [],
          next_cursor: "b7-remove",
        }),
      }).request();
      expect((await database.readMirroredSession<Session>("dev-user", SID))?.planned_sets).toEqual(
        [],
      );
    }
    const parent = "40000000-0000-4000-8000-000000000711";
    // The production builder emits the local envelope, which deliberately has no server load_kind.
    // SessionScreen passes that same envelope through this API-shaped adapter and localIds.
    const local = { ...baseline, planned_sets: build(ids) } as Session;
    const correlations = ids.map((id, index) => ({
      correlation_id: id,
      exercise_id: "e_plank",
      set_no: index + 1,
    }));
    const committed = await database.commitRoutineSnapshot(
      "dev-user",
      SID,
      ["e_plank"],
      parent,
      new Date().toISOString(),
      correlations,
      local,
      new Set(ids),
    );
    expect(committed?.planned_sets.map((row) => row.id)).toEqual(ids);
    if (intent !== "empty")
      await useSessionLog
        .getState()
        .completeSet(ids[0], { weight: null, reps: null, rir: null, timeSec: 40 });
    if (intent === "uncheck" || intent === "orphan-delete")
      await useSessionLog.getState().uncompleteSet(ids[0]);
    if (intent === "orphan-delete") await sessionDb.drafts.delete(["dev-user", SID, ids[0]]);
    let actualTime = 40;
    let server = baseline;
    let onlineView = false;
    mocks.session.mockImplementation(async () => {
      if (!onlineView) throw new TypeError("B7 initial document is offline");
      return server;
    });
    const assertStage = async (keys: string[]) => {
      await screen.findByRole("button", { name: "플랭크 메뉴" });
      await waitFor(() =>
        expect(
          document.querySelector(`[data-set-check="${keys[0]}"]`)?.getAttribute("aria-pressed"),
        ).toBe(String(completed)),
      );
      for (const id of keys)
        expect(document.querySelector(`[data-planned-set-id="${id}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-planned-set-id="${SET}"]`)).toBeNull();
      expect(document.querySelector(`[data-planned-set-id="${OTHER_SET}"]`)).toBeNull();
      if (completed) expect(recordedText(keys[0])).toContain(String(actualTime));
      fireEvent.click(screen.getByRole("button", { name: "플랭크 메뉴" }));
      for (const action of ["삭제", "교체"])
        expect(
          screen.getByRole("menuitem", { name: `플랭크 ${action}` }).getAttribute("aria-disabled"),
        ).toBe(completed ? "true" : null);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      if (completed) expect(useSessionLog.getState().drafts[keys[0]]?.planned_set_id).toBe(keys[0]);
    };
    mount();
    await assertStage(ids);
    const canonicalIds = [721, 722, 723].map((n) => `30000000-0000-4000-8000-000000000${n}`);
    const canonical = serverRows(canonicalIds).map((row, index) => ({
      ...row,
      correlation_id: ids[index],
    }));
    if (intent === "uncheck" || intent === "orphan-delete")
      canonical[0].performed_set = {
        ...record,
        actual_weight: null,
        actual_reps: null,
        actual_rir: null,
        actual_time_sec: 40,
      };
    server = { ...local, planned_sets: canonical };
    const before = await sessionDb.outbox.get(parent);
    if (completed)
      expect((await sessionDb.drafts.get(["dev-user", SID, ids[0]]))?.completed).toBe(true);
    await act(async () => {
      await refetchAuthoritativeSession(clients[0], SID, async () => server);
    });
    expect(
      clients[0].getQueryData<Session>(["session", SID])?.planned_sets.map((row) => row.id),
    ).toEqual(canonicalIds);
    expect(await sessionDb.outbox.get(parent)).toBeDefined();
    if (completed) {
      expect((await sessionDb.drafts.get(["dev-user", SID, canonicalIds[0]]))?.completed).toBe(
        true,
      );
      expect(await sessionDb.drafts.get(["dev-user", SID, ids[0]])).toBeUndefined();
      expect(
        (await sessionDb.outbox.toArray()).filter(
          (row) => row.entity === "performed_set" && row.entity_id === ids[0],
        ),
      ).toHaveLength(1);
    }
    await assertStage(canonicalIds);
    expectPrivateEqual(await sessionDb.outbox.get(parent), before);
    let overwritten = false;
    let unsubscribe = () => {};
    let latestWrites: typeof foreign = [];
    if (intent === "latest") {
      actualTime = 55;
      vi.setSystemTime(new Date("2026-08-14T10:00:00.001Z"));
      await act(async () => {
        await useSessionLog.getState().completeSet(canonicalIds[0], {
          weight: null,
          reps: null,
          rir: null,
          timeSec: actualTime,
        });
      });
      unsubscribe = useSessionLog.subscribe((state) => {
        if (
          state.sessionId === SID &&
          state.drafts[canonicalIds[0]]?.actual_time_sec !== actualTime
        )
          overwritten = true;
      });
      subscriptions.push(unsubscribe);
      await act(async () => {
        await useSessionLog
          .getState()
          .completeSet(canonicalIds[0], { weight: null, reps: null, rir: null, timeSec: 45 });
      });
      expect(overwritten).toBe(true); // The same subscription observes a real user change.
      await act(async () => {
        await useSessionLog
          .getState()
          .completeSet(canonicalIds[0], {
            weight: null,
            reps: null,
            rir: null,
            timeSec: actualTime,
          });
      });
      overwritten = false;
      latestWrites = (await sessionDb.outbox.toArray()).filter(
        (row) => row.entity === "performed_set" && row.entity_id === canonicalIds[0],
      );
      expect(latestWrites).toHaveLength(3);
    }
    const originalChildren = (await sessionDb.outbox.toArray()).filter(
      (row) => row.entity === "performed_set" && row.entity_id === ids[0],
    );
    await act(async () => {
      await new SyncCoordinator({
        userId: "dev-user",
        transport: async () => ({
          applied: [parent, ...originalChildren.map((child) => child.client_id)],
          conflicts: [],
          changes: [],
          next_cursor: "b7-routine-ack",
          planned_set_mappings: canonical.map((row, index) => ({
            correlation_id: ids[index],
            planned_set_id: row.id,
            planned_set: row,
          })),
        }),
      }).request();
    });
    server = {
      ...server,
      planned_sets: canonical.map((row, index) => ({
        ...row,
        performed_set:
          completed && index === 0
            ? {
                ...record,
                actual_weight: null,
                actual_reps: null,
                actual_rir: null,
                actual_time_sec: 40,
              }
            : null,
      })),
    };
    onlineView = true;
    await act(async () => {
      await refetchAuthoritativeSession(clients[0], SID, async () => server);
    });
    await assertStage(canonicalIds);
    expect(overwritten).toBe(false);
    unsubscribe();
    for (const id of ids) expect(await sessionDb.drafts.get(["dev-user", SID, id])).toBeUndefined();
    const remaining = (await sessionDb.outbox.toArray()).filter(
      (row) => row.entity === "performed_set",
    );
    expectPrivateEqual(
      remaining.filter((row) => row.entity_id === OTHER_SET),
      foreign,
    );
    if (intent === "latest")
      expectPrivateEqual(
        remaining.filter((row) => row.entity_id === canonicalIds[0]),
        latestWrites,
      );
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    sessionDb.close();
    await sessionDb.open();
    useSessionLog.setState({ sessionId: null, drafts: {} });
    mount();
    await assertStage(canonicalIds);
    expectPrivateEqual(
      (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set"),
      remaining,
    );
    if (intent === "empty") {
      server.planned_sets[1].performed_set = {
        ...record,
        actual_weight: null,
        actual_reps: null,
        actual_rir: null,
        actual_time_sec: 30,
      };
      await act(async () => {
        await refetchAuthoritativeSession(clients[0], SID, async () => server);
      });
      await waitFor(() =>
        expect(
          document
            .querySelector(`[data-set-check="${canonicalIds[1]}"]`)
            ?.getAttribute("aria-pressed"),
        ).toBe("true"),
      );
      expect(recordedText(canonicalIds[1])).toContain("30");
      expectPrivateEqual(
        (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set"),
        remaining,
      );
    }
  },
);
it.each(restorationMatrix)(
  "B10: $phase check=$completed $entry preserves $intent records",
  async ({ phase, completed, entry, intent }) => {
    const session: Session = {
      ...makeSession(completed),
      status: phase === "fresh" ? "scheduled" : "completed",
      scheduled_date: phase === "past-completed" ? "2026-08-12" : "2026-08-14",
    };
    if (intent === "pending") {
      // These are real writes made while the session date was editable, then left unsent.
      vi.setSystemTime(new Date(`${session.scheduled_date}T09:00:00.000Z`));
      await useSessionLog.getState().begin(SID);
      await useSessionLog
        .getState()
        .completeSet(SET, { weight: 80, reps: 8, rir: 1, timeSec: null });
      if (!completed) await useSessionLog.getState().uncompleteSet(SET);
      vi.setSystemTime(new Date("2026-08-14T10:00:00.000Z"));
    }
    const writes = (await sessionDb.outbox.toArray()).filter(
      (row) => row.entity === "performed_set",
    );
    const drafts = await database.loadDrafts("dev-user", SID);
    mocks.session.mockResolvedValue(session);
    const observe = async () => {
      mount();
      if (phase !== "fresh") {
        if (phase === "same-day-resume") {
          fireEvent.click(await screen.findByRole("button", { name: "기록 더하거나 고치기" }));
        } else {
          await screen.findAllByText("이 기록은 편집할 수 있는 기간이 지났어요.");
          expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
        }
      }
      await waitFor(() => expect(useSessionLog.getState().sessionId).toBe(SID));
      await waitFor(() => expect(mocks.session.mock.calls[0]?.[0]).toBe(SID));
      if (completed)
        await waitFor(() => expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true));
      else expect(useSessionLog.getState().drafts[SET]?.completed === true).toBe(false);
      if (phase !== "past-completed") {
        await waitFor(() =>
          expect(
            document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed"),
          ).toBe(String(completed)),
        );
        if (completed) expect(recordedText(SET)).toContain(intent === "pending" ? "80" : "72.5");
      } else {
        expect(document.querySelector(`[data-set-check="${SET}"]`)).toBeNull();
        expect(screen.queryByText(/완료 체크를 해제해 주세요/)).toBeNull();
      }
      expectPrivateEqual(
        (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set"),
        writes,
      );
      if (intent === "pending")
        expectPrivateEqual(await database.loadDrafts("dev-user", SID), drafts);
    };
    await observe();
    if (entry === "reload") {
      cleanup();
      clients.splice(0).forEach((client) => client.clear());
      sessionDb.close();
      await sessionDb.open();
      useSessionLog.setState({ sessionId: null, drafts: {} });
      await observe();
      expect(mocks.session).toHaveBeenCalledTimes(2);
    }
  },
);

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

it.each([false, true])(
  "B5: prefill, unchecked inputs and pain-only=%s do not become completed records",
  async (painOnly) => {
    await useSessionLog.getState().begin(SID);
    if (painOnly) await useSessionLog.getState().reportPain([SET], 2);
    mocks.session.mockResolvedValue(makeSession(false));
    mount();
    await screen.findByRole("button", { name: "벤치프레스 메뉴" });
    const check = document.querySelector(`[data-set-check="${SET}"]`)!;
    expect(check.getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(recordInput(SET, "weight"), { target: { value: "80" } });
    fireEvent.change(recordInput(SET, "reps"), { target: { value: "9" } });
    expect(check.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "벤치프레스 메뉴" }));
    for (const action of ["삭제", "교체"])
      expect(
        screen
          .getByRole("menuitem", { name: `벤치프레스 ${action}` })
          .getAttribute("aria-disabled"),
      ).toBeNull();
    expect(await sessionDb.outbox.count()).toBe(0);
    expect(
      Object.values(useSessionLog.getState().drafts).filter((draft) => draft.completed).length,
    ).toBe(0);
    expect(mocks.sync).not.toHaveBeenCalled();
  },
);

it("cold partial server completion stays in the routine without a local draft", async () => {
  expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
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
  expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
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
  expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  await waitFor(() => expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true));
  expectPrivateMatch((await sessionDb.drafts.toArray())[0], {
    session_id: SID,
    planned_set_id: SET,
    completed: true,
  });
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(`[data-set-check="${SET}"]`)!);
  await waitFor(async () => expect(await sessionDb.outbox.count()).toBe(1));
  expectPrivateMatch((await sessionDb.outbox.toArray())[0], {
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
  expectPrivateEqual(useSessionLog.getState().drafts[SET], intent);
  expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  expectPrivateEqual(await sessionDb.outbox.toArray(), writes);
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
  expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
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
  expectPrivateEqual(useSessionLog.getState().drafts[SET], intent);
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
  const put = vi.spyOn(sessionDb.drafts, "put");
  await database.readThroughSession("dev-user", SID, async () => makeSession(true));
  await useSessionLog.getState().publishSessionRead(SID, makeSession(true));
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
  expect(await sessionDb.outbox.count()).toBe(1);
  expect(put).not.toHaveBeenCalled();
});

it("a pending uncheck allows no read placeholder put over the local intent", async () => {
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 10, rir: 2, timeSec: null });
  await useSessionLog.getState().uncompleteSet(SET);
  const before = await database.loadDrafts("dev-user", SID);
  const put = vi.spyOn(sessionDb.drafts, "put");
  await database.readThroughSession("dev-user", SID, async () => makeSession(true));
  await useSessionLog.getState().publishSessionRead(SID, makeSession(true));
  expect(put).not.toHaveBeenCalled();
  expectPrivateEqual(await database.loadDrafts("dev-user", SID), before);
  expect(useSessionLog.getState().drafts[SET].completed).toBe(false);
});

it("an outbox read failure in the authority cache writer defers every placeholder put", async () => {
  await useSessionLog.getState().begin(SID);
  const put = vi.spyOn(sessionDb.drafts, "put");
  const pendingRead = vi.spyOn(sessionDb.outbox, "where").mockImplementationOnce(() => {
    throw new Error("pending intent read unavailable");
  });
  const fetch = vi.fn(async () => makeSession(true));
  await database.readThroughSession("dev-user", SID, fetch);
  expect(fetch).toHaveBeenCalledExactlyOnceWith();
  expect(pendingRead).toHaveBeenCalledExactlyOnceWith("user_id");
  expect(put).not.toHaveBeenCalled();
  expect(await sessionDb.drafts.count()).toBe(0);
  // Only this read failed. The next authority read can write through normally.
  await database.readThroughSession("dev-user", SID, fetch);
  expect(put).toHaveBeenCalledTimes(1);
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("unknown pending intent defers projection visibly to developers and the next successful GET retries", async () => {
  await useSessionLog.getState().begin(SID);
  vi.spyOn(database, "pendingPerformedIds").mockRejectedValueOnce(new Error("read unavailable"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await useSessionLog.getState().publishSessionRead(SID, makeSession(true));
  expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
  expect(await sessionDb.drafts.count()).toBe(0);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "Session record hydration deferred: local intent unavailable",
  );
  const read = await database.readThroughSession("dev-user", SID, async () => makeSession(true));
  await useSessionLog.getState().publishSessionRead(SID, read);
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("a cold completed read restores values without starting a new rest timer", async () => {
  const timers = await import("../components/session/rest-timer-store");
  const save = vi.spyOn(timers.restTimerStore, "save");
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("button", { name: "벤치프레스 메뉴" });
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  expect(await timers.loadRestTimer("dev-user", SID, Date.now())).toBeNull();
  expect(screen.queryByRole("dialog", { name: /후 휴식/ })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("a cold completed read preserves and restores an existing eligible rest timer", async () => {
  const timers = await import("../components/session/rest-timer-store");
  await timers.saveRestTimer("dev-user", SID, SET, "벤치프레스 1세트 후 휴식", {
    totalSec: 90,
    endsAt: Date.now() + 60_000,
  });
  const before = await timers.loadRestTimer("dev-user", SID, Date.now());
  expect(before?.plannedSetId).toBe(SET);
  mocks.session.mockResolvedValue(makeSession(true));
  mount();
  await screen.findByRole("dialog", { name: "벤치프레스 1세트 후 휴식" });
  expect(await timers.loadRestTimer("dev-user", SID, Date.now())).toEqual(before);
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  expect(await sessionDb.outbox.count()).toBe(0);
});

it.each([undefined, null])(
  "unknown completed=%s defers a read draft without overriding existing timer eligibility",
  async (unknownCompleted) => {
    const timers = await import("../components/session/rest-timer-store");
    // Deliberately invalid wire data: absence/null is unknown, never an uncomplete intent.
    const session = makeSession(true);
    (session.planned_sets[0].performed_set as unknown as Record<string, unknown>).completed =
      unknownCompleted;
    expect(typeof session.planned_sets[0].performed_set?.completed).not.toBe("boolean");
    await timers.saveRestTimer("dev-user", SID, SET, "벤치프레스 1세트 후 휴식", {
      totalSec: 90,
      endsAt: Date.now() + 60_000,
    });
    expect((await timers.loadRestTimer("dev-user", SID, Date.now()))?.plannedSetId).toBe(SET);
    const put = vi.spyOn(sessionDb.drafts, "put");
    mocks.session.mockResolvedValue(session);
    mount();
    await screen.findByRole("dialog", { name: "벤치프레스 1세트 후 휴식" });
    expect(await sessionDb.drafts.count()).toBe(0);
    expect(Object.keys(useSessionLog.getState().drafts)).toEqual([]);
    expect(await sessionDb.outbox.count()).toBe(0);
    expect(put).not.toHaveBeenCalled();
  },
);

it("characterization: a completed=false server actual still qualifies an existing timer before read projection", async () => {
  const timers = await import("../components/session/rest-timer-store");
  const session = makeSession(true);
  session.planned_sets[0].performed_set!.completed = false;
  expect(session.planned_sets[0].performed_set?.completed).toBe(false);
  expect(await sessionDb.drafts.count()).toBe(0);
  await timers.saveRestTimer("dev-user", SID, SET, "벤치프레스 1세트 후 휴식", {
    totalSec: 90,
    endsAt: Date.now() + 60_000,
  });
  const outcome = await timers.readRestoreSnapshot("dev-user", SID, session, Date.now());
  expect(outcome.kind).toBe("restored");
  expect((await timers.loadRestTimer("dev-user", SID, Date.now()))?.plannedSetId).toBe(SET);
});

it("characterization: GET of a completed=false actual makes current timer restoration none", async () => {
  const timers = await import("../components/session/rest-timer-store");
  const session = makeSession(true);
  session.planned_sets[0].performed_set!.completed = false;
  expect(session.planned_sets[0].performed_set?.completed).toBe(false);
  expect(await sessionDb.drafts.count()).toBe(0);
  await timers.saveRestTimer("dev-user", SID, SET, "벤치프레스 1세트 후 휴식", {
    totalSec: 90,
    endsAt: Date.now() + 60_000,
  });
  await database.readThroughSession("dev-user", SID, async () => session);
  const outcome = await timers.readRestoreSnapshot("dev-user", SID, session, Date.now());
  // Observed HEAD behavior, not a verdict about the timer contract.
  expect(outcome.kind).toBe("none");
  expect(await timers.loadRestTimer("dev-user", SID, Date.now())).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(0);
});
it("characterization: a completed=false actual stays unchecked, unlocked, and outside the summary count", async () => {
  const session = makeSession(true);
  session.planned_sets[0].performed_set!.completed = false;
  expect(session.planned_sets[0].performed_set?.completed).toBe(false);
  mocks.session.mockResolvedValue(session);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "벤치프레스 메뉴" }));
  expect(document.querySelector(`[data-set-check="${SET}"]`)?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(
    screen.getByRole("menuitem", { name: "벤치프레스 삭제" }).getAttribute("aria-disabled"),
  ).toBeNull();
  expect(screen.getByText("0세트 완료 · 계획 2세트")).toBeTruthy();
  expect(await sessionDb.outbox.count()).toBe(0);
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  mocks.session.mockResolvedValue({ ...session, status: "completed" });
  mount();
  await screen.findByRole("heading", { name: "오늘은 기록이 없어요" });
  expect(await sessionDb.outbox.count()).toBe(0);
});
