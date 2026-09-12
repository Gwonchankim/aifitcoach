import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecommendationStateInput } from "shared";
import { recommendationStateFixtures } from "../../../packages/shared/test/fixtures/recommendation-state";
import {
  commitAuthoritativeSession,
  mirrorSession,
  readMirroredSession,
  sessionDb,
} from "../components/session/session-db";

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
      assistance_safety_status: input.load_kind === "assistance" ? "safe" : null,
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

  it.each([false, true])(
    "repairs old gated nulls and recovers without changing facts (quota rejection: %s)",
    async (rejectRepair) => {
      const draft = {
        user_id: "u",
        session_id: "s",
        planned_set_id: "set",
        client_id: "pending-set",
        actual_weight: 45,
        actual_reps: 10,
        actual_rir: 2,
        actual_time_sec: null,
        pain_score: 0,
        completed: true,
        updated_at: "2026-09-12T10:00:00.000Z",
      };
      const mutation = {
        client_id: draft.client_id,
        user_id: "u",
        entity: "performed_set" as const,
        entity_id: "set",
        op: "upsert" as const,
        updated_at: draft.updated_at,
        payload: { ...draft },
        attempts: 0,
      };
      const old = {
        id: "s",
        status: "in_progress",
        performed_sets: [{ ...draft }],
        planned_sets: [
          {
            id: "set",
            exercise_id: "exercise",
            set_no: 1,
            load_kind: "external",
            recommendation_gate: "early",
            recommendation_state: null,
            reason_code: null,
            recommended_weight: null,
            recommended_reps: null,
            confidence: null,
            performed_set: {
              planned_set_id: draft.planned_set_id,
              actual_weight: draft.actual_weight,
              actual_reps: draft.actual_reps,
              actual_rir: draft.actual_rir,
              actual_time_sec: draft.actual_time_sec,
              pain_score: draft.pain_score,
              completed: draft.completed,
              client_id: draft.client_id,
              updated_at: draft.updated_at,
            },
          },
        ],
      };
      await sessionDb.drafts.put(draft);
      await sessionDb.outbox.put(mutation);
      await sessionDb.sessions.put({
        user_id: "u",
        session_id: "s",
        session: old,
        updated_at: "old",
      });
      const repaired = {
        ...old,
        planned_sets: [{ ...old.planned_sets[0], recommendation_state: "unavailable" }],
      };
      if (rejectRepair) {
        const quota = new DOMException("Synthetic quota rejection", "QuotaExceededError");
        const put = vi.spyOn(sessionDb.sessions, "put").mockRejectedValue(quota);
        try {
          await expect(readMirroredSession("u", "s")).rejects.toMatchObject({
            name: "QuotaExceededError",
            inner: quota,
          });
          expect(put).toHaveBeenCalledTimes(1);
          expect(await sessionDb.sessions.get(["u", "s"])).toEqual({
            user_id: "u",
            session_id: "s",
            session: old,
            updated_at: "old",
          });
          expect(await sessionDb.drafts.toArray()).toEqual([draft]);
          expect(await sessionDb.outbox.toArray()).toEqual([mutation]);
        } finally {
          put.mockRestore();
        }
      }
      expect(await readMirroredSession("u", "s")).toEqual(repaired);
      expect((await sessionDb.sessions.get(["u", "s"]))?.session).toEqual(repaired);
      expect(await readMirroredSession("u", "s")).toEqual(repaired);
      expect(await sessionDb.drafts.toArray()).toEqual([draft]);
      expect(await sessionDb.outbox.toArray()).toEqual([mutation]);
      const fresh = {
        ...old,
        planned_sets: [
          {
            ...old.planned_sets[0],
            recommendation_state: "ready",
            reason_code: "ADD_ONE_REP",
            recommended_weight: 45,
            recommended_reps: 11,
          },
        ],
      };
      expect(await commitAuthoritativeSession("u", "s", fresh)).toBe(true);
      expect(await readMirroredSession("u", "s")).toEqual(fresh);
      expect((await sessionDb.sessions.get(["u", "s"]))?.session).toEqual(fresh);
      expect(await sessionDb.drafts.toArray()).toEqual([draft]);
      expect(await sessionDb.outbox.toArray()).toEqual([mutation]);
    },
  );

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
