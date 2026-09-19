import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionDb } from "../components/session/session-db";
import {
  parseCandidates,
  parseSwapResult,
  candidateReasonCopy,
  swapReasonCopy,
} from "../lib/week-swap";
import {
  saveSwapIntent,
  readSwapIntent,
  clearSwapIntent,
  hasSwapPending,
} from "../lib/week-swap-db";

const session = {
  id: "00000000-0000-4000-8000-000000000002",
  scheduled_date: "2026-08-16",
  focus: "lower",
  status: "scheduled",
  origin: "planned",
  revision: "r2",
  planned_set_ids: [],
  exercises: [],
};
const candidates = {
  program_id: "00000000-0000-4000-8000-000000000001",
  week_start: "2026-08-10",
  today_session_id: "00000000-0000-4000-8000-000000000003",
  today_revision: "r1",
  today_eligible: true,
  today_reason: null,
  candidates: [{ session, eligible: true, reason: null }],
};
const request = {
  client_id: "00000000-0000-4000-8000-000000000004",
  today_session_id: candidates.today_session_id,
  target_session_id: session.id,
  today_revision: "r1",
  target_revision: "r2",
};
beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});

describe("weekly swap closed wire", () => {
  it("distinguishes valid empty, unavailable today and malformed payload", () => {
    expect(parseCandidates({ ...candidates, candidates: [] })).toEqual({
      ...candidates,
      candidates: [],
    });
    expect(
      parseCandidates({
        ...candidates,
        today_session_id: null,
        today_revision: null,
        today_eligible: false,
        today_reason: "ambiguous_schedule",
      })?.today_reason,
    ).toBe("ambiguous_schedule");
    for (const value of [
      null,
      {},
      { ...candidates, candidates: null },
      { ...candidates, today_eligible: true, today_reason: "readonly" },
      { ...candidates, today_session_id: null },
    ])
      expect(parseCandidates(value)).toBeNull();
  });
  it("unknown reasons and eligibility contradictions never become selectable", () => {
    for (const reason of ["append_limit", "future_unknown", undefined]) {
      expect(
        parseCandidates({ ...candidates, candidates: [{ session, eligible: false, reason }] }),
      ).toBeNull();
      expect(candidateReasonCopy(reason)).toBe(
        "교환할 수 없는 사유를 확인하지 못했어요. 최신 일정을 다시 확인해 주세요.",
      );
    }
    expect(
      parseCandidates({
        ...candidates,
        candidates: [{ session, eligible: true, reason: "readonly" }],
      }),
    ).toBeNull();
    expect(
      parseCandidates({ ...candidates, candidates: [{ session, eligible: false, reason: null }] }),
    ).toBeNull();
    expect(swapReasonCopy("readonly")).not.toContain("다른 운동일");
  });
  it("malformed success and wrong request identity remain unresolved", () => {
    const result = {
      client_id: request.client_id,
      program_id: candidates.program_id,
      week_start: candidates.week_start,
      today_session_id: session.id,
      sessions: [
        session,
        { ...session, id: request.today_session_id, scheduled_date: "2026-08-14" },
      ],
    };
    expect(parseSwapResult(result, request, candidates.program_id)).toEqual(result);
    for (const patch of [
      { sessions: [] },
      { client_id: "other" },
      { today_session_id: "other" },
      { sessions: [session, session] },
    ])
      expect(parseSwapResult({ ...result, ...patch }, request, candidates.program_id)).toBeNull();
  });
});

describe("weekly swap durable intent", () => {
  it("persists exact original identity before POST and survives reopen without creating outbox", async () => {
    await saveSwapIntent("owner", candidates.program_id, request);
    sessionDb.close();
    await sessionDb.open();
    expect(await readSwapIntent("owner", candidates.program_id)).toEqual(request);
    expect(await sessionDb.outbox.count()).toBe(0);
    expect(await readSwapIntent("other", candidates.program_id)).toBeNull();
    await expect(
      saveSwapIntent("owner", candidates.program_id, { ...request, client_id: "different" }),
    ).rejects.toThrow();
  });
  it("drafts and pending routine mutations block new swap without being deleted", async () => {
    await sessionDb.outbox.put({
      client_id: "pending",
      user_id: "owner",
      entity: "session_routine",
      entity_id: request.today_session_id,
      op: "upsert",
      updated_at: new Date().toISOString(),
      payload: {},
      attempts: 0,
    });
    expect(await hasSwapPending("owner")).toBe(true);
    await saveSwapIntent("owner", candidates.program_id, request);
    await clearSwapIntent("owner", candidates.program_id, request.client_id);
    expect(await sessionDb.outbox.count()).toBe(1);
    expect(await hasSwapPending("other")).toBe(false);
  });
});

import { readThroughReadModel } from "../lib/read-model-cache";
import { readThroughSession, SupersededWeekSwapRead } from "../components/session/session-db";
import { bumpWeekSwapEpoch } from "../lib/week-swap-db";

it.each(["dashboard", "history-session", "current-week"] as const)(
  "a pre-swap late %s GET cannot return stale DOM or overwrite durable mirror",
  async (kind) => {
    let release!: (value: { version: string }) => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const older = readThroughReadModel({
      userId: "owner",
      kind,
      cacheKey: kind,
      fetcher: () => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const rejected = expect(older).rejects.toBeInstanceOf(SupersededWeekSwapRead);
    await begun;
    await bumpWeekSwapEpoch("owner");
    await readThroughReadModel({
      userId: "owner",
      kind,
      cacheKey: kind,
      fetcher: async () => ({ version: "new" }),
    });
    release({ version: "old" });
    await rejected;
    expect((await sessionDb.readModels.get(["owner", kind]))?.data).toEqual({ version: "new" });
  },
);
it("a pre-swap session GET cannot overwrite the newly dated session mirror or DOM", async () => {
  let release!: (value: { planned_sets: []; scheduled_date: string }) => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const older = readThroughSession("owner", session.id, () => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const rejected = expect(older).rejects.toBeInstanceOf(SupersededWeekSwapRead);
  await begun;
  await bumpWeekSwapEpoch("owner");
  await readThroughSession("owner", session.id, async () => ({
    planned_sets: [],
    scheduled_date: "2026-08-14",
  }));
  release({ planned_sets: [], scheduled_date: "2026-08-16" });
  await rejected;
  expect((await sessionDb.sessions.get(["owner", session.id]))?.session).toMatchObject({
    scheduled_date: "2026-08-14",
  });
});
