// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Exercise, Session } from "../lib/api";
import { SessionScreen } from "../components/session/SessionScreen";
import {
  DEV_USER_SCOPE,
  mirrorCatalog,
  mirrorSession,
  sessionDb,
} from "../components/session/session-db";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      session: vi.fn().mockRejectedValue(new TypeError("offline")),
      exercises: vi.fn().mockRejectedValue(new TypeError("offline")),
    },
  };
});
vi.mock("../components/session/sync-coordinator", async () => {
  const actual = await vi.importActual<typeof import("../components/session/sync-coordinator")>(
    "../components/session/sync-coordinator",
  );
  return { ...actual, requestForegroundSync: () => Promise.resolve(null) };
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
});

it("renders the durable session and catalog when the query manager is already offline", async () => {
  // This worker uses fake-indexeddb only; it cannot access the user's browser storage.
  const id = "offline-catalog-session";
  const exercise = {
    id: "e_chest_press_machine",
    name_ko: "체스트 프레스 머신",
    name_en: "Chest Press Machine",
    movement_pattern: "horizontal_push",
    primary_muscles: ["chest"],
    equipment: "machine",
    difficulty: "beginner",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    step_kg: 5,
    default_time_low_sec: null,
    default_time_high_sec: null,
    substitutions: [],
    media_url: null,
  } as Exercise;
  await mirrorCatalog(DEV_USER_SCOPE, [exercise]);
  await mirrorSession(DEV_USER_SCOPE, id, {
    id,
    goal: "hypertrophy",
    scheduled_date: "2026-08-14",
    status: "scheduled",
    planned_sets: [],
  } as unknown as Session);
  const before = await sessionDb.catalogs.get(DEV_USER_SCOPE);
  onlineManager.setOnline(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <SessionScreen sessionId={id} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("heading", { name: "오늘 운동" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "운동 추가" })).toBeTruthy();
  expect(client.getQueryData(["exercises"])).toEqual([exercise]);
  expect(await sessionDb.catalogs.get(DEV_USER_SCOPE)).toEqual(before);
  client.clear();
});
