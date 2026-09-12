import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecommendationStateInput } from "shared";
import { recommendationStateFixtures } from "../../../packages/shared/test/fixtures/recommendation-state";
import { mirrorSession, readMirroredSession, sessionDb } from "../components/session/session-db";

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});

describe("ADR-70 Dexie read-normalize-rewrite", () => {
  it.each(recommendationStateFixtures)("$name", async (fixture) => {
    const input: RecommendationStateInput = fixture.input;
    const row = {
      id: "set",
      exercise_id: "exercise",
      set_no: 1,
      reason_code: input.reason,
      recommended_weight: input.weight,
      recommendation_state: input.state,
      load_kind: input.load_kind,
      recommendation_gate: "early",
      confidence: null,
    };
    // Old mirrors bypass today's writer. Reading must persist the repair, not just return a view.
    await sessionDb.sessions.put({
      user_id: "u",
      session_id: "s",
      session: { planned_sets: [row] },
      updated_at: "old",
    });
    const read = await readMirroredSession<{ planned_sets: (typeof row)[] }>("u", "s");
    expect(read?.planned_sets[0].recommendation_state).toBe(fixture.expected);
    expect((await sessionDb.sessions.get(["u", "s"]))?.session).toEqual(read);
    expect(await readMirroredSession("u", "s")).toEqual(read);
    expect(read?.planned_sets[0].reason_code).toBe(input.reason);
    if (input.load_kind) {
      expect(await mirrorSession("u", "write", { planned_sets: [row] })).toBe(true);
      const stored = (await sessionDb.sessions.get(["u", "write"]))?.session as {
        planned_sets: (typeof row)[];
      };
      expect(stored.planned_sets[0].recommendation_state).toBe(fixture.expected);
    }
  });

  it("provisional local row round-trip 무변경", async () => {
    const session = {
      planned_sets: [
        {
          id: "local",
          exercise_id: "exercise",
          set_no: 1,
          reason_code: "BASELINE",
          recommended_weight: 0,
        },
      ],
    };
    expect(await mirrorSession("u", "local-session", session, new Set(["local"]))).toBe(true);
    expect(await readMirroredSession("u", "local-session")).toEqual(session);
    expect((await sessionDb.sessions.get(["u", "local-session"]))?.session).toEqual(session);
  });
});
