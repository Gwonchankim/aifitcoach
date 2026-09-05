// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import Dexie from "dexie";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Exercise, Session } from "../lib/api";
import { useModal } from "../components/session/useModal";

const apiMocks = vi.hoisted(() => ({ session: vi.fn(), exercises: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: () => Promise.resolve(null) };
});

afterEach(cleanup);

function FocusGuard({ open, target }: { open: boolean; target: HTMLElement }) {
  useModal(open, "focus-guard-dialog", () => {}, "focus-guard-initial", target);
  return open ? (
    <div id="focus-guard-dialog">
      <button id="focus-guard-initial">닫기</button>
    </div>
  ) : null;
}

it.each(["disabled", "aria-disabled", "detached"])(
  "does not attempt to focus an explicit opener that became %s",
  async (state) => {
    const target = document.createElement("button");
    document.body.append(target);
    const focus = vi.spyOn(target, "focus");
    const view = render(<FocusGuard open target={target} />);
    try {
      await waitFor(() => expect(document.activeElement?.id).toBe("focus-guard-initial"));
      if (state === "detached") target.remove();
      else target.setAttribute(state, state === "aria-disabled" ? "true" : "");
      view.rerender(<FocusGuard open={false} target={target} />);
      expect(focus).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      focus.mockRestore();
      target.remove();
    }
  },
);
it("returns from the actual SessionScreen picker to its clicked add opener when body had focus", async () => {
  vi.resetModules();
  Dexie.dependencies.indexedDB = new IDBFactory();
  const { sessionDb } = await import("../components/session/session-db");
  const { SessionScreen } = await import("../components/session/SessionScreen");
  const session = {
    id: "focus-session",
    program_id: "focus-program",
    goal: "hypertrophy",
    status: "scheduled",
    scheduled_date: "2026-08-14",
    planned_sets: [],
  } as Session;
  const exercise: Exercise = {
    id: "e_chest_press_machine",
    name_ko: "체스트 프레스 머신",
    name_en: "Chest Press Machine",
    primary_muscles: ["chest"],
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
  };
  apiMocks.session.mockResolvedValue(session);
  apiMocks.exercises.mockResolvedValue({ items: [exercise], next_cursor: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SessionScreen sessionId={session.id} />
    </QueryClientProvider>,
  );
  try {
    const opener = await screen.findByRole("button", { name: "운동 추가" });
    expect(document.activeElement).toBe(document.body);
    // fireEvent.click intentionally supplies no browser focus default, matching the WebKit probe.
    fireEvent.click(opener);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "가슴" })),
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "운동 검색" }), {
      target: { value: "머신" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "운동 추가" })).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
    fireEvent.click(opener);
    expect((screen.getByRole("searchbox", { name: "운동 검색" }) as HTMLInputElement).value).toBe(
      "",
    );
  } finally {
    view.unmount();
    client.clear();
    sessionDb.close();
  }
});
