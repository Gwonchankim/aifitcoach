// @vitest-environment jsdom
/**
 * BUG-10 D8 — the RENDERED SessionScreen follows session-edit-rights: facts (values, checks,
 * finish) and routine (add, exercise menu, append) open and close separately, and an approved
 * notice appears only where it is true. "Now" is pinned (Date only) and sessions are dated around
 * it; every locked case also proves nothing reached the outbox.
 */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session as ApiSession } from "../lib/api";
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
      {
        id: "e_chest_press_machine",
        name_ko: "체스트 프레스 머신",
        name_en: "Chest Press Machine",
        primary_muscles: ["chest"],
        modality: "resistance",
        cardio_movement_regions: [],
        prescription_kinds_supported: [],
        blocked_reported_pain_areas: [],
        movement_pattern: "horizontal_push",
        equipment: "machine",
        difficulty: "beginner",
        mechanic: "compound",
        region: "upper",
        metric: "reps",
        step_kg: 2.5,
        default_time_low_sec: null,
        default_time_high_sec: null,
        substitutions: [],
        media_url: null,
      },
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
const { useSessionLog } = await import("../components/session/session-store");
const { EDIT_WINDOW_COPY } = await import("../components/session/session-edit-rights");

const NOW = new Date("2026-08-14T10:00:00.000Z");
const sets = [1, 2].map((n) => ({
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
const session = (scheduled_date: string, status: Session["status"]) =>
  ({
    id: "A",
    program_id: "p",
    goal: "hypertrophy",
    status,
    scheduled_date,
    planned_sets: sets,
  }) as Session;
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <SessionScreen sessionId="A" />
    </QueryClientProvider>,
  );
}
const weight = (n = 1) => `벤치프레스 ${n}세트 무게, 킬로그램`;
/**
 * Every approved notice that is NOT `expected` must be absent (a notice never over-claims), and the
 * "which day this lands on" line exists only beside the previous-day notice.
 */
function expectOnlyNotice(expected: string | null) {
  for (const copy of Object.values(EDIT_WINDOW_COPY))
    if (copy !== expected) expect(screen.queryByText(copy)).toBeNull();
  if (expected) expect(screen.getByText(expected)).toBeTruthy();
  if (expected !== EDIT_WINDOW_COPY.previousCompleted)
    expect(screen.queryByText(/운동에 반영돼요\.$/)).toBeNull();
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

it("a finished previous-day session reopens for values only, and the notice says exactly that", async () => {
  mocks.session.mockResolvedValue(session("2026-08-13", "completed"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "기록 더하거나 고치기" }));
  // Values (facts) are open...
  const input = await screen.findByLabelText(weight());
  expectOnlyNotice(EDIT_WINDOW_COPY.previousCompleted);
  // The day it lands on, from the session's own date — not "오늘", not "어제".
  expect(screen.getByText("이 기록은 8월 13일 운동에 반영돼요.")).toBeTruthy();
  expect(screen.queryByText(/오늘 기록에 반영돼요/)).toBeNull();
  expect(screen.getByRole("button", { name: "수정 마치기" })).toBeTruthy();
  // ...the routine is not.
  expect(screen.queryByRole("button", { name: "운동 추가" })).toBeNull();
  expect(screen.queryByRole("button", { name: "벤치프레스 메뉴" })).toBeNull();
  // A value write really goes out (the server window accepts the previous day).
  fireEvent.change(input, { target: { value: "62.5" } });
  fireEvent.click(screen.getByRole("button", { name: /벤치프레스 1세트 완료/ }));
  await waitFor(async () =>
    expect((await sessionDb.outbox.toArray()).map((row) => row.entity)).toEqual(["performed_set"]),
  );
});

it("a finished older session stays on its summary with no way back into edits", async () => {
  mocks.session.mockResolvedValue(session("2026-08-12", "completed"));
  mount();
  await screen.findByRole("heading", { name: "오늘은 기록이 없어요" });
  expect(screen.queryByRole("button", { name: "기록 더하거나 고치기" })).toBeNull();
  expect(screen.queryByLabelText(weight())).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("an older scheduled session without records: logging is closed with the past notice, the plan stays readable, routine add stays", async () => {
  mocks.session.mockResolvedValue(session("2026-08-12", "scheduled"));
  mount();
  await screen.findByText(EDIT_WINDOW_COPY.pastUnlogged);
  expectOnlyNotice(EDIT_WINDOW_COPY.pastUnlogged);
  expect(screen.queryByLabelText(weight())).toBeNull();
  expect(screen.getAllByText(/목표 8~10회/).length).toBe(2);
  expect(screen.queryByText("종료한 운동이라 입력할 수 없어요.")).toBeNull();
  expect(screen.getByRole("button", { name: "운동 추가" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /운동 종료|수정 마치기/ })).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("an older scheduled session with a logged set: the expired notice, the logged value read-only", async () => {
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("set-1", { weight: 60, reps: 9, rir: 2, timeSec: null });
  const queued = await sessionDb.outbox.count();
  mocks.session.mockResolvedValue(session("2026-08-12", "in_progress"));
  mount();
  await screen.findByText(EDIT_WINDOW_COPY.expired);
  expectOnlyNotice(EDIT_WINDOW_COPY.expired);
  expect(document.querySelector('[data-planned-set-id="set-1"]')?.textContent).toMatch(
    /기록\s*60\s*kg × 9회 · RIR 2/,
  );
  expect(screen.queryByLabelText(weight())).toBeNull();
  expect(screen.queryByRole("button", { name: /운동 종료|수정 마치기/ })).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(queued);
});

it("a future scheduled session waits for its day; routine stays open and the pain item only explains", async () => {
  mocks.session.mockResolvedValue(session("2026-08-15", "scheduled"));
  mount();
  await screen.findByText(EDIT_WINDOW_COPY.upcoming);
  expectOnlyNotice(EDIT_WINDOW_COPY.upcoming);
  expect(screen.queryByLabelText(weight())).toBeNull();
  expect(screen.getByRole("button", { name: "운동 추가" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /운동 종료|수정 마치기/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "벤치프레스 메뉴" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "벤치프레스 통증 기록" }));
  // Pain is a set fact: no sheet, no write — the notice is announced instead.
  await waitFor(() =>
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe(
      EDIT_WINDOW_COPY.upcoming,
    ),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await sessionDb.outbox.count()).toBe(0);
});

it("today with a logged set (C-43/C-44): swap/remove are locked by the record, pain stays active and opens its sheet", async () => {
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("set-1", { weight: 60, reps: 9, rir: 2, timeSec: null });
  const queued = await sessionDb.outbox.count();
  mocks.session.mockResolvedValue(session("2026-08-14", "in_progress"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "벤치프레스 메뉴" }));
  const swap = await screen.findByRole("menuitem", { name: "벤치프레스 교체" });
  const remove = screen.getByRole("menuitem", { name: "벤치프레스 삭제" });
  const pain = screen.getByRole("menuitem", { name: "벤치프레스 통증 기록" });
  expect(swap.getAttribute("aria-disabled")).toBe("true");
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  expect(pain.hasAttribute("aria-disabled")).toBe(false);
  fireEvent.click(remove);
  expect(await sessionDb.outbox.count()).toBe(queued); // C-44: a locked item sends nothing…
  expect(screen.getByRole("menu")).toBeTruthy(); // …and the menu stays open
  fireEvent.click(pain);
  // Facts are open today, so the pain item does open its sheet (not the date notice).
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expectOnlyNotice(null);
});

it("today: logging and finishing as before, with no date notice", async () => {
  mocks.session.mockResolvedValue(session("2026-08-14", "scheduled"));
  mount();
  await screen.findByLabelText(weight());
  expectOnlyNotice(null);
  expect(screen.getByRole("button", { name: "운동 종료" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "운동 추가" })).toBeTruthy();
});

/**
 * A routine edit the screen believed open is refused (409) because the session turned out to be
 * finished on another day. The copy comes from the refetched session's date class; a finished
 * future session (abnormal, no approved copy) gets the generic 409 copy — never an action copy
 * that asserts a different cause ("이미 오늘 루틴에 있는 운동이에요.").
 */
it.each([
  ["2026-08-13", EDIT_WINDOW_COPY.previousCompleted],
  ["2026-08-12", EDIT_WINDOW_COPY.expired],
  ["2026-08-15", "다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요."],
] as const)("a refused routine edit on a session finished %s explains: %s", async (date, copy) => {
  let refused = false;
  mocks.session.mockImplementation(async () =>
    refused ? session(date, "completed") : session("2026-08-14", "scheduled"),
  );
  mocks.sync.mockImplementation(async () => {
    const routine = (await sessionDb.outbox.toArray()).find(
      (row) => row.entity === "session_routine",
    );
    if (!routine) return null;
    refused = true;
    return {
      applied: [],
      conflicts: [
        { client_id: routine.client_id, entity_id: routine.entity_id, reason: "conflict" },
      ],
      changes: [],
      planned_set_mappings: [],
      next_cursor: "v1.test",
    };
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 추가" }));
  fireEvent.click(await screen.findByRole("button", { name: /체스트 프레스 머신/ }));
  expect(await screen.findAllByText(copy)).not.toHaveLength(0);
  expect(screen.queryByText("이미 오늘 루틴에 있는 운동이에요.")).toBeNull();
});

it("KST 08:30 → 09:30: after UTC midnight logging stays open; one more midnight closes it", async () => {
  vi.setSystemTime(new Date("2026-09-18T00:30:00.000Z")); // KST 09:30 on the 18th
  mocks.session.mockResolvedValue(session("2026-09-17", "in_progress"));
  const view = mount();
  await screen.findByLabelText(weight());
  expect(screen.getByRole("button", { name: "운동 종료" })).toBeTruthy();
  expectOnlyNotice(null);
  view.unmount();

  vi.setSystemTime(new Date("2026-09-19T00:10:00.000Z"));
  mount();
  await screen.findByText(EDIT_WINDOW_COPY.pastUnlogged);
  expect(screen.queryByLabelText(weight())).toBeNull();
});
