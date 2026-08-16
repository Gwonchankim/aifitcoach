import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("M-4′ analytics API adapter", () => {
  it("serializes the bounded e1RM query from the generated contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          exercise_id: "e_bench_press",
          sample_session_count: 0,
          gate_state: "no_history",
          observations: [],
          points: [],
          next_recommendation: null,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.analyticsE1rm({
      exercise_id: "e_bench_press",
      from: "2026-05-25",
      to: "2026-08-16",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:3001/v1/analytics/e1rm?exercise_id=e_bench_press&from=2026-05-25&to=2026-08-16",
    );
  });

  it("serializes volume and completion windows without hand-written response types", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ weeks: [] }), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await api.analyticsVolume({ week_start: "2026-08-10", weeks: 12 });
    await api.analyticsCompletion({ week_start: "2026-08-10", weeks: 12 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3001/v1/analytics/volume?week_start=2026-08-10&weeks=12",
      "http://localhost:3001/v1/analytics/completion?week_start=2026-08-10&weeks=12",
    ]);
  });
});
