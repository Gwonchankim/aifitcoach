// @vitest-environment jsdom
/**
 * BUG-10 D8 — the RENDERED SessionScreen follows session-edit-rights: facts (values, checks,
 * finish) and routine (add, exercise menu, append) open and close separately, and an approved
 * notice appears only where it is true. "Now" is pinned (Date only) and sessions are dated around
 * it; every locked case also proves nothing reached the outbox.
 */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const { sessionDb, DEV_USER_SCOPE } = await import("../components/session/session-db");
const { SyncCoordinator } = await import("../components/session/sync-coordinator");
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
  // The same notice may also stand as a locked exercise's reason (D8), so presence is ≥ 1.
  if (expected) expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
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

/**
 * The record lock ("기록이 있는 운동이라 빼거나 바꿀 수 없어요. 완료 체크를 해제해 주세요.") promises
 * that unchecking frees the exercise. That holds only where both the check and the routine are
 * open — today. A finished previous-day session closes the routine by date, an older session
 * closes the check: neither may show that promise (D8: copy never claims more than the rights).
 */
const RECORD_LOCK = /완료 체크를 해제해 주세요/;
it("a finished previous-day session with a logged set never says unchecking frees the exercise", async () => {
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("set-1", { weight: 60, reps: 9, rir: 2, timeSec: null });
  mocks.session.mockResolvedValue(session("2026-08-13", "completed"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "기록 더하거나 고치기" }));
  await screen.findByLabelText(weight(2));
  expectOnlyNotice(EDIT_WINDOW_COPY.previousCompleted);
  expect(screen.queryByText(RECORD_LOCK)).toBeNull();
});

it.each([
  ["2026-08-13", "이 기록은 8월 13일 운동에 반영돼요."],
  ["2026-08-14", "고친 내용을 오늘 기록에 반영할게요."],
] as const)("re-finishing the session of %s says where the edit lands: %s", async (date, copy) => {
  mocks.session.mockResolvedValue(session(date, "completed"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "기록 더하거나 고치기" }));
  fireEvent.click(await screen.findByRole("button", { name: "수정 마치기" }));
  const dialog = await screen.findByRole("dialog", { name: "수정 마치기" });
  expect(dialog.textContent).toContain(copy);
  if (date !== "2026-08-14") expect(dialog.textContent).not.toContain("오늘 기록에 반영");
});

it("a finished older session stays on its summary with no way back into edits", async () => {
  mocks.session.mockResolvedValue(session("2026-08-12", "completed"));
  mount();
  await screen.findByRole("heading", { name: "오늘은 기록이 없어요" });
  // D8: the summary says why (expired), and never "기록 값은 고칠 수 있어요".
  expectOnlyNotice(EDIT_WINDOW_COPY.expired);
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
  // Header notice + the logged exercise's lock reason: both say the date, never "uncheck".
  expect(await screen.findAllByText(EDIT_WINDOW_COPY.expired)).toHaveLength(2);
  expectOnlyNotice(EDIT_WINDOW_COPY.expired);
  expect(screen.queryByText(RECORD_LOCK)).toBeNull(); // the check is closed: unchecking is impossible
  expect(document.querySelector('[data-planned-set-id="set-1"]')?.textContent).toMatch(
    /기록\s*60\s*kg × 9회 · RIR 2/,
  );
  expect(screen.queryByLabelText(weight())).toBeNull();
  expect(screen.queryByRole("button", { name: /운동 종료|수정 마치기/ })).toBeNull();
  // The routine is open (not finished) but the logged exercise stays locked: pressing remove
  // explains the date, not "uncheck it" (the check is closed).
  fireEvent.click(screen.getByRole("button", { name: "벤치프레스 메뉴" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "벤치프레스 삭제" }));
  await waitFor(() =>
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe(EDIT_WINDOW_COPY.expired),
  );
  expect(screen.queryByText(RECORD_LOCK)).toBeNull();
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
  // Today both are open, so the record lock and its "uncheck" instruction are true here.
  expect(await screen.findByText(RECORD_LOCK)).toBeTruthy();
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

/**
 * C1 · P1 · C4 — a fact write refused by the server's date window is surfaced, never silent. The
 * screen refetches the authoritative session (routine's device): logging closed → that date
 * class's approved notice; still open → not the date window, so each path keeps its current
 * handling (the finish sheet's generic 409; set refusals stay with BUG-03). No new copy.
 */
const GENERIC_409 = "다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요.";
const refusal = (rows: { client_id: string; entity_id: string }[], reason: string) => ({
  applied: [],
  conflicts: rows.map((row) => ({ client_id: row.client_id, entity_id: row.entity_id, reason })),
  changes: [],
  planned_set_mappings: [],
  next_cursor: "v1.test",
});
async function logFirstSet() {
  await useSessionLog.getState().begin("A");
  await useSessionLog
    .getState()
    .completeSet("set-1", { weight: 60, reps: 9, rir: 2, timeSec: null });
}

it.each([
  // The UTC midnight that closes 08-13 passes while the sheet is open.
  ["2026-08-15T00:00:01.000Z", "conflict", EDIT_WINDOW_COPY.expired],
  // Logging is still open: not the date window, the generic 409 stays.
  [null, "stale_update", GENERIC_409],
] as const)("C1: a finish refused at %s (%s) explains: %s", async (closesAt, reason, copy) => {
  await logFirstSet();
  mocks.session.mockResolvedValue(session("2026-08-13", "in_progress"));
  mocks.sync.mockImplementation(async () => {
    const finish = (await sessionDb.outbox.toArray()).find((row) => row.entity === "session");
    if (!finish) return null;
    if (closesAt) vi.setSystemTime(new Date(closesAt));
    return refusal([finish], reason);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toBe(copy));
  if (copy !== GENERIC_409) expect(screen.queryByText(GENERIC_409)).toBeNull();
});

it.each([
  ["2026-08-15T00:00:01.000Z", "conflict", EDIT_WINDOW_COPY.expired],
  [null, "conflict", null], // refetched logging still open → not the date window
  ["2026-08-15T00:00:01.000Z", "stale_update", null], // another reason → BUG-03, as before
] as const)(
  "P1: a logged set refused by a background sync at %s (%s) surfaces: %s",
  async (closesAt, reason, copy) => {
    await logFirstSet();
    mocks.session.mockResolvedValue(session("2026-08-13", "in_progress"));
    mount();
    await screen.findByLabelText(weight(2));
    const rows = (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set");
    expect(rows).toHaveLength(1);
    if (closesAt) vi.setSystemTime(new Date(closesAt));
    const reads = mocks.session.mock.calls.length;
    await act(async () => {
      await new SyncCoordinator({
        userId: DEV_USER_SCOPE,
        transport: async () => refusal(rows, reason),
      }).request();
    });
    if (copy) {
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(copy));
    } else {
      // `conflict` is decided by the refetch; any other reason is not considered at all — no
      // refetch, given the time a refetch takes to land (real timers; only Date is faked).
      if (reason === "conflict")
        await waitFor(() => expect(mocks.session.mock.calls.length).toBeGreaterThan(reads));
      else {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(mocks.session.mock.calls.length).toBe(reads);
      }
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(screen.queryByRole("alert")).toBeNull();
    }
  },
);

/**
 * A finished previous-day session HAS an approved notice while logging is open. A `conflict` there
 * is not the date window, so neither path may borrow that notice (only closed logging speaks).
 */
it("C1: a re-finish refused while the previous day is still open keeps the generic 409", async () => {
  await logFirstSet();
  mocks.session.mockResolvedValue(session("2026-08-13", "completed"));
  mocks.sync.mockImplementation(async () => {
    const finish = (await sessionDb.outbox.toArray()).find((row) => row.entity === "session");
    return finish ? refusal([finish], "conflict") : null;
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "기록 더하거나 고치기" }));
  fireEvent.click(await screen.findByRole("button", { name: "수정 마치기" }));
  const sheet = await screen.findByRole("dialog", { name: "수정 마치기" });
  fireEvent.click(within(sheet).getByRole("button", { name: "기록 반영" }));
  await waitFor(() => expect(within(sheet).getByRole("alert").textContent).toBe(GENERIC_409));
});

it("P1: a `conflict` on a finished previous-day session with logging open stays silent (not the date window)", async () => {
  await logFirstSet();
  mocks.session.mockResolvedValue(session("2026-08-13", "completed"));
  mount();
  await screen.findByRole("heading", { name: "수고했어요" });
  const rows = (await sessionDb.outbox.toArray()).filter((row) => row.entity === "performed_set");
  const reads = mocks.session.mock.calls.length;
  await act(async () => {
    await new SyncCoordinator({
      userId: DEV_USER_SCOPE,
      transport: async () => refusal(rows, "conflict"),
    }).request();
  });
  await waitFor(() => expect(mocks.session.mock.calls.length).toBeGreaterThan(reads));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("P1: another session's refused set never alerts this screen", async () => {
  mocks.session.mockResolvedValue(session("2026-08-12", "in_progress")); // logging closed here
  mount();
  await screen.findByText(EDIT_WINDOW_COPY.pastUnlogged);
  const reads = mocks.session.mock.calls.length;
  await act(async () => {
    await new SyncCoordinator({
      userId: DEV_USER_SCOPE,
      transport: async () => refusal([{ client_id: "x", entity_id: "other-set" }], "conflict"),
    }).request();
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(mocks.session.mock.calls.length).toBe(reads);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("C1: a finish refused for the date window through the real coordinator is said once, in the sheet", async () => {
  await logFirstSet();
  mocks.session.mockResolvedValue(session("2026-08-13", "in_progress"));
  mocks.sync.mockImplementation(async () => {
    if (!(await sessionDb.outbox.toArray()).some((row) => row.entity === "session")) return null;
    vi.setSystemTime(new Date("2026-08-15T00:00:01.000Z"));
    return new SyncCoordinator({
      userId: DEV_USER_SCOPE,
      transport: async (body) => refusal(body.mutations, "conflict"),
    }).request();
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ }));
  await waitFor(() =>
    expect(within(sheet).getByRole("alert").textContent).toBe(EDIT_WINDOW_COPY.expired),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
});

it("C4: an offline finish refused later for the date window no longer claims the finish", async () => {
  await logFirstSet();
  mocks.session.mockResolvedValue(session("2026-08-13", "in_progress"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "운동 종료" }));
  const sheet = await screen.findByRole("dialog", { name: "운동 종료" });
  fireEvent.click(within(sheet).getByRole("button", { name: /종료$/ })); // offline: sync → null
  await screen.findByRole("heading", { name: "수고했어요" });
  const queued = (await sessionDb.outbox.toArray()).filter((row) =>
    ["performed_set", "session"].includes(row.entity),
  );
  expect(queued.map((row) => row.entity).sort()).toEqual(["performed_set", "session"]);
  // Back online two UTC days later: the server refuses both for the date window.
  vi.setSystemTime(new Date("2026-08-15T00:00:01.000Z"));
  await act(async () => {
    await new SyncCoordinator({
      userId: DEV_USER_SCOPE,
      transport: async () => refusal(queued, "conflict"),
    }).request();
  });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(EDIT_WINDOW_COPY.expired));
  expect(screen.queryByRole("heading", { name: "수고했어요" })).toBeNull();
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
