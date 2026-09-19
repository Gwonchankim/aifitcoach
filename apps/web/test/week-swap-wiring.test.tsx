// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import Dexie from "dexie";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WeekSwapEntry } from "../components/program/WeekSwapSheet";
import { sessionDb, DEV_USER_SCOPE } from "../components/session/session-db";
import { SWAP_COPY, type WeekSwapRequest } from "../lib/week-swap";

const mocks = vi.hoisted(() => ({
  currentWeek: vi.fn(),
  weekSwapCandidates: vi.fn(),
  weekSwap: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      currentWeek: mocks.currentWeek,
      weekSwapCandidates: mocks.weekSwapCandidates,
      weekSwap: mocks.weekSwap,
    },
  };
});
vi.mock("../lib/week-swap-refresh", () => ({ refreshAfterWeekSwap: mocks.refresh }));
const programId = "00000000-0000-4000-8000-000000000001";
const today = {
  id: "00000000-0000-4000-8000-000000000002",
  scheduled_date: "2026-08-14",
  focus: "upper",
  status: "scheduled",
  origin: "planned",
  revision: "r1",
  planned_set_ids: [],
  exercises: [],
};
const target = {
  ...today,
  id: "00000000-0000-4000-8000-000000000003",
  scheduled_date: "2026-08-16",
  focus: "lower",
  revision: "r2",
};
const candidates = {
  program_id: programId,
  week_start: "2026-08-10",
  today_session_id: today.id,
  today_revision: today.revision,
  today_eligible: true,
  today_reason: null,
  candidates: [{ session: target, eligible: true, reason: null }],
};
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <WeekSwapEntry programId={programId} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: SWAP_COPY.title }));
  await screen.findByRole("radio", { name: /2026-08-16/ });
}
async function select() {
  fireEvent.click(await screen.findByRole("radio", { name: /2026-08-16/ }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "교환하기", exact: true }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  sessionDb.close();
  Dexie.dependencies.indexedDB = new IDBFactory();
  await sessionDb.open();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.currentWeek.mockResolvedValue({
    program_id: programId,
    week_start: "2026-08-10",
    sessions: [today, target],
  });
  mocks.weekSwapCandidates.mockResolvedValue(candidates);
  mocks.refresh.mockResolvedValue({ todaySessionId: target.id });
});
afterEach(async () => {
  cleanup();
  await sessionDb.delete();
});
it("opens default swap, keeps one-off explicit, and resets mode after close with no POST", async () => {
  mount();
  await open();
  expect(
    (screen.getByRole("radio", { name: "두 운동일 교환", exact: true }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "오늘만 운동 바꾸기", exact: true }));
  await screen.findByRole("button", { name: "오늘 루틴 편집하기" });
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  await open();
  expect(
    (screen.getByRole("radio", { name: "두 운동일 교환", exact: true }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(mocks.weekSwap).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});
it("lost response survives reload and explicit result check replays exact body then routes by latest today", async () => {
  const view = mount();
  await open();
  await select();
  mocks.weekSwap.mockRejectedValueOnce(new TypeError("lost response"));
  fireEvent.click(screen.getByRole("button", { name: "교환하기", exact: true }));
  await screen.findByRole("button", { name: "결과 확인" });
  const original = mocks.weekSwap.mock.calls[0][1] as WeekSwapRequest;
  expect(
    (await sessionDb.syncMeta.get([DEV_USER_SCOPE, `week-swap-intent:${programId}`]))?.value,
  ).toBe(JSON.stringify(original));
  expect(mocks.push).not.toHaveBeenCalled();
  view.unmount();
  view.client.clear();
  mount();
  await open();
  const check = await screen.findByRole("button", { name: "결과 확인" });
  expect(mocks.weekSwap).toHaveBeenCalledTimes(1);
  const laterToday = "00000000-0000-4000-8000-000000000099";
  mocks.refresh.mockResolvedValueOnce({ todaySessionId: laterToday });
  mocks.weekSwap.mockResolvedValueOnce({
    client_id: original.client_id,
    program_id: programId,
    week_start: "2026-08-10",
    today_session_id: target.id,
    sessions: [today, target],
  });
  fireEvent.click(check);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/session/${laterToday}`));
  expect(mocks.weekSwap.mock.calls[1][1]).toEqual(original);
  expect(await sessionDb.outbox.count()).toBe(0);
});
it("malformed success remains unresolved and never routes to a guessed session", async () => {
  mount();
  await open();
  await select();
  mocks.weekSwap.mockResolvedValueOnce({ ok: true });
  fireEvent.click(screen.getByRole("button", { name: "교환하기", exact: true }));
  await screen.findByRole("button", { name: "결과 확인" });
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});
it("offline disables selected swap and reconnect requires explicit fresh candidates", async () => {
  mount();
  await open();
  await select();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  fireEvent(window, new Event("offline"));
  await screen.findByText(SWAP_COPY.offline);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  fireEvent(window, new Event("online"));
  expect((screen.getByRole("radio", { name: /2026-08-16/ }) as HTMLInputElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "일정 다시 확인" }));
  await waitFor(() =>
    expect((screen.getByRole("radio", { name: /2026-08-16/ }) as HTMLInputElement).disabled).toBe(
      false,
    ),
  );
  expect(mocks.weekSwap).not.toHaveBeenCalled();
});
it("local pair draft blocks without clearing it or automatically selecting one-off", async () => {
  await sessionDb.drafts.put({
    user_id: DEV_USER_SCOPE,
    session_id: today.id,
    planned_set_id: "draft",
    client_id: "draft-intent",
    actual_weight: 20,
    actual_reps: 8,
    actual_rir: 2,
    actual_time_sec: null,
    pain_score: null,
    completed: false,
    updated_at: "2026-08-14T10:00:00Z",
  });
  mount();
  await open();
  fireEvent.click(screen.getByRole("radio", { name: /2026-08-16/ }));
  await screen.findByText(SWAP_COPY.pending);
  expect(
    ((await screen.findByRole("button", { name: "교환하기", exact: true })) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(await sessionDb.drafts.count()).toBe(1);
  expect(mocks.weekSwap).not.toHaveBeenCalled();
});
