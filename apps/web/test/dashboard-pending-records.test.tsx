// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectPrivateMatch } from "./support/private-record-assertions";
import type { DashboardSummary, Session } from "../lib/api";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  sync: vi.fn(),
  complete: vi.fn(),
  dashboard: vi.fn(),
  currentProgram: vi.fn(),
  analyticsVolume: vi.fn(),
  exercises: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  const replacements: Partial<typeof actual.api> = {
    session: mocks.session,
    completeSession: mocks.complete,
    dashboard: mocks.dashboard,
    currentProgram: mocks.currentProgram,
    analyticsVolume: mocks.analyticsVolume,
    exercises: mocks.exercises,
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
const { DashboardScreen } = await import("../components/dashboard/DashboardScreen");
const { sessionDb } = await import("../components/session/session-db");
const database = await import("../components/session/session-db");
const { api } = await import("../lib/api");
const { useSessionLog } = await import("../components/session/session-store");
const { dashboardReadModel } = await import("../lib/read-model-data");
const { hasSwapPending } = await import("../lib/week-swap-db");
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
      <DashboardScreen />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-14T10:00:00.000Z"));
  mocks.session.mockReset();
  mocks.sync.mockReset();
  mocks.complete.mockReset();
  mocks.dashboard.mockReset();
  mocks.currentProgram.mockResolvedValue({ program_id: PID });
  mocks.analyticsVolume.mockRejectedValue(new TypeError("diagnostic unavailable"));
  mocks.exercises.mockResolvedValue({ items: [], next_cursor: null });
  mocks.sync.mockResolvedValue(null);
  await sessionDb.delete();
  await sessionDb.open();
  useSessionLog.setState({ sessionId: null, drafts: {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

const earlierDashboard: DashboardSummary = {
  date: "2026-08-14",
  today: {
    status: "done",
    session_id: SID,
    routine_summary: null,
    done_summary: { sets_completed: 0, total_volume: 0, pr_count: 0 },
  },
  tomorrow: { status: "rest", routine_summary: null },
  streak_days: 0,
  weekly_completion_rate: 0,
  weekly_rhythm: [],
  primary_e1rm: null,
};
const deviceOnlyCopy =
  "오늘 1세트를 기록했어요. 이 기기에만 있는 기록이라 연결되면 요약에 반영돼요.";
const noLocalCopy = "오늘 운동을 마쳤어요. 기록한 세트는 없어요.";

it("an authoritative hydrated row must not create a device-only claim in a normal stale dashboard mirror", async () => {
  const earlier: DashboardSummary = {
    date: "2026-08-14",
    today: {
      status: "done",
      session_id: SID,
      routine_summary: null,
      done_summary: { sets_completed: 0, total_volume: 0, pr_count: 0 },
    },
    tomorrow: { status: "rest", routine_summary: null },
    streak_days: 0,
    weekly_completion_rate: 0,
    weekly_rhythm: [],
    primary_e1rm: null,
  };
  mocks.dashboard.mockResolvedValueOnce(earlier);
  const first = await dashboardReadModel();
  expect(first.source).toBe("server");
  expect(first.data.today.done_summary?.sets_completed).toBe(0);
  mocks.dashboard.mockRejectedValue(new TypeError("transport unavailable"));
  const stale = await dashboardReadModel();
  expect(stale.source).toBe("mirror");
  expect(stale.stale).toBe(true);
  expect(stale.data.today.session_id).toBe(SID);
  expect(await sessionDb.drafts.count()).toBe(0);
  await useSessionLog.getState().begin(SID);
  mocks.session.mockResolvedValue({ ...makeSession(true), status: "completed" });
  mount();
  await screen.findByText("오늘 운동을 마쳤어요. 기록한 세트는 없어요.");
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  // A later successful session GET and an independently failing dashboard GET are separate requests.
  const authoritative = await database.readThroughSession("dev-user", SID, () => api.session(SID));
  expect(authoritative.planned_sets[0].performed_set?.completed).toBe(true);
  await useSessionLog.getState().publishSessionRead(SID, authoritative);
  expect(useSessionLog.getState().drafts[SET]?.completed).toBe(true);
  expect(await sessionDb.outbox.count()).toBe(0);
  mount();
  await screen.findByText(noLocalCopy);
  expect(screen.queryByText(deviceOnlyCopy)).toBeNull();
  expect(mocks.dashboard).toHaveBeenCalled();
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("an offline local completion has a pending upsert and retains the device-only claim", async () => {
  mocks.dashboard.mockResolvedValue(earlierDashboard);
  mocks.session.mockResolvedValue(makeSession(false));
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 8, rir: 1, timeSec: null });
  expect(await sessionDb.outbox.count()).toBe(1);
  mount();
  await screen.findByText(deviceOnlyCopy);
});

it("a canonical remap preserves the latest pending completion join before ACK", async () => {
  const { SyncCoordinator } = await import("../components/session/sync-coordinator");
  const canonicalId = "30000000-0000-4000-8000-000000000003";
  const session = makeSession(false);
  const canonical = { ...session.planned_sets[0], id: canonicalId };
  mocks.dashboard.mockResolvedValue(earlierDashboard);
  mocks.session.mockResolvedValue({
    ...session,
    planned_sets: [canonical, session.planned_sets[1]],
  });
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 8, rir: 1, timeSec: null });
  const original = useSessionLog.getState().drafts[SET].client_id;
  await new SyncCoordinator({
    userId: "dev-user",
    transport: async () => ({
      applied: [],
      conflicts: [],
      changes: [],
      next_cursor: "mapped",
      planned_set_mappings: [
        { correlation_id: SET, planned_set_id: canonicalId, planned_set: canonical },
      ],
    }),
  }).request();
  expect(await sessionDb.drafts.get(["dev-user", SID, SET])).toBeUndefined();
  expectPrivateMatch(await sessionDb.drafts.get(["dev-user", SID, canonicalId]), {
    client_id: original,
    completed: true,
  });
  expect(await sessionDb.outbox.count()).toBe(1);
  await useSessionLog.getState().refreshFromMirror(SID);
  mount();
  await screen.findByText(deviceOnlyCopy);
});

it("a newer uncomplete intent cannot count its older pending upsert as device-only", async () => {
  mocks.dashboard.mockResolvedValue(earlierDashboard);
  mocks.session.mockResolvedValue(makeSession(false));
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 8, rir: 1, timeSec: null });
  await useSessionLog.getState().uncompleteSet(SET);
  expect(await sessionDb.outbox.count()).toBe(2);
  expect(useSessionLog.getState().drafts[SET].completed).toBe(false);
  mount();
  await screen.findByText(noLocalCopy);
  expect(screen.queryByText(deviceOnlyCopy)).toBeNull();
});

it("ACK removes the device-only claim even while the server summary remains stale", async () => {
  mocks.dashboard.mockResolvedValue(earlierDashboard);
  mocks.session.mockResolvedValue(makeSession(false));
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 8, rir: 1, timeSec: null });
  mount();
  await screen.findByText(deviceOnlyCopy);
  await sessionDb.outbox.clear();
  expect(await sessionDb.outbox.count()).toBe(0);
  await waitFor(() => expect(screen.queryByText(deviceOnlyCopy)).toBeNull());
  expect(screen.getByText(noLocalCopy)).toBeTruthy();
});

it("an unreadable outbox cannot justify a device-only record count", async () => {
  mocks.dashboard.mockResolvedValue(earlierDashboard);
  mocks.session.mockResolvedValue(makeSession(false));
  await useSessionLog.getState().begin(SID);
  await useSessionLog.getState().completeSet(SET, { weight: 65, reps: 8, rir: 1, timeSec: null });
  expect(await sessionDb.outbox.count()).toBe(1);
  vi.spyOn(sessionDb.outbox, "where").mockImplementation(() => {
    throw new Error("read unavailable");
  });
  mount();
  await screen.findByText(noLocalCopy);
  expect(screen.queryByText(deviceOnlyCopy)).toBeNull();
});

it("diagnostic: hydrated draft blocks its own week-swap pair but not an unrelated pair", async () => {
  expect(await hasSwapPending("dev-user", [SID, "target"])).toBe(false);
  await database.readThroughSession("dev-user", SID, async () => makeSession(true));
  expect(await sessionDb.drafts.count()).toBe(1);
  expect(await sessionDb.outbox.count()).toBe(0);
  expect(await hasSwapPending("dev-user", [SID, "target"])).toBe(true);
  expect(await hasSwapPending("dev-user", ["other-today", "other-target"])).toBe(false);
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  clients.splice(0).forEach((client) => client.clear());
  await sessionDb.delete();
  vi.useRealTimers();
});
