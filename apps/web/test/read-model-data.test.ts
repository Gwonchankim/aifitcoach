import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDb } from "../components/session/session-db";
import { api, type DashboardSummary } from "../lib/api";
import {
  dashboardReadModel,
  e1rmReadModel,
  recentAnalyticsWindow,
  volumeReadModel,
} from "../lib/read-model-data";

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sessionDb.delete();
});

const dashboard = {
  date: "2026-08-16",
  primary_e1rm: {
    exercise_id: "e_bench_press",
    sample_session_count: 2,
    gate_state: "early",
    latest_e1rm: null,
  },
} as DashboardSummary;

describe("M-4′ analytics/history data adapter", () => {
  it("keeps the server-gated dashboard snapshot authoritative when offline", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValueOnce(dashboard);
    await expect(dashboardReadModel("user-a")).resolves.toMatchObject({
      data: dashboard,
      source: "server",
      stale: false,
    });

    vi.spyOn(api, "dashboard").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(dashboardReadModel("user-a")).resolves.toMatchObject({
      data: dashboard,
      source: "mirror",
      stale: true,
    });
  });

  it("rejects unbounded analytics reads before calling the server", async () => {
    const e1rm = vi.spyOn(api, "analyticsE1rm");
    const volume = vi.spyOn(api, "analyticsVolume");
    expect(() =>
      e1rmReadModel({
        exercise_id: "e_bench_press",
        from: "2026-01-01",
        to: "2026-08-16",
      }),
    ).toThrow("e1RM window");
    expect(() => volumeReadModel({ weeks: 13 })).toThrow("analytics weeks");
    expect(e1rm).not.toHaveBeenCalled();
    expect(volume).not.toHaveBeenCalled();
  });

  it("builds the same deterministic recent 12-week windows for every caller", () => {
    expect(recentAnalyticsWindow("2026-08-16")).toEqual({
      e1rm: { from: "2026-05-25", to: "2026-08-16" },
      weekly: { week_start: "2026-05-25", weeks: 12 },
    });
  });
});
