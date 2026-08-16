import { readFileSync } from "node:fs";
import path from "node:path";
import {
  projectFacts,
  weekStart,
  type ProjectorSession,
} from "../src/analytics/aggregation.projector";

const fixture = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "..", "..", "..", "docs", "specs", "m4_aggregation_fixture.json"),
    "utf8",
  ),
) as {
  sessions: {
    session_id: string;
    date: string;
    exercise_id: string;
    primary_muscles: string[];
    sets: { weight: number; reps: number; rir: number }[];
  }[];
  expected: {
    first_e1rm: number;
    ordered_session_ids: string[];
    week_2026_07_27_chest: { hard_sets: number; volume_load: number; avg_rir: number };
  };
};

function facts(order = fixture.sessions): ProjectorSession[] {
  return order.map((session) => ({
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: session.session_id,
    scheduledDate: new Date(`${session.date}T00:00:00.000Z`),
    completed: true,
    exercises: [
      {
        exerciseId: session.exercise_id,
        metric: "reps",
        hasExternalLoad: true,
        primaryMuscles: session.primary_muscles,
        sets: session.sets.map((set) => ({
          completed: true,
          weight: set.weight,
          reps: set.reps,
          rir: set.rir,
        })),
      },
    ],
  }));
}

describe("M-4′ aggregation projector", () => {
  it("uses the corrected-RIR low-rep Epley result, not raw Epley", () => {
    expect(projectFacts(facts()).e1rm.find((row) => row.sessionId === "s-01")?.e1rm).toBe(
      fixture.expected.first_e1rm,
    );
  });

  it("is byte-identical despite source insertion order", () => {
    const normal = JSON.stringify(projectFacts(facts()));
    const reversed = JSON.stringify(projectFacts(facts([...fixture.sessions].reverse())));
    expect(reversed).toBe(normal);
    expect(projectFacts(facts()).e1rm.map((row) => row.sessionId)).toEqual(
      fixture.expected.ordered_session_ids,
    );
  });

  it("gives the same affected week rows as a full rebuild and excludes secondary muscles", () => {
    const all = projectFacts(facts());
    const week = weekStart(new Date("2026-08-01T00:00:00.000Z")).getTime();
    const incremental = projectFacts(
      facts().filter((row) => weekStart(row.scheduledDate).getTime() === week),
    );
    expect(JSON.stringify(incremental.muscleLoad)).toBe(
      JSON.stringify(all.muscleLoad.filter((row) => row.weekStart.getTime() === week)),
    );
    expect(all.muscleLoad[0]).toMatchObject({
      muscle: "chest",
      hardSets: fixture.expected.week_2026_07_27_chest.hard_sets,
      volumeLoad: fixture.expected.week_2026_07_27_chest.volume_load,
      avgRir: fixture.expected.week_2026_07_27_chest.avg_rir,
    });
  });

  it("replaces a changed/deleted fact bucket and keeps missing RIR as null", () => {
    const changed = facts().map((session) =>
      session.sessionId === "s-01"
        ? {
            ...session,
            exercises: session.exercises.map((exercise) => ({ ...exercise, sets: [] })),
          }
        : session,
    );
    expect(projectFacts(changed).e1rm.map((row) => row.sessionId)).not.toContain("s-01");
    const noHardSets = facts([
      { ...fixture.sessions[0]!, sets: [{ weight: 100, reps: 5, rir: 4 }] },
    ]);
    expect(projectFacts(noHardSets).muscleLoad[0]).toMatchObject({
      hardSets: 0,
      volumeLoad: 500,
      avgRir: 4,
    });
    const missingRir = facts([
      { ...fixture.sessions[0]!, sets: [{ weight: 100, reps: 5, rir: 1 }] },
    ]);
    missingRir[0]!.exercises[0]!.sets[0]!.rir = null;
    expect(projectFacts(missingRir).muscleLoad[0]?.avgRir).toBeNull();
  });

  it("is tenant-isolated and idempotent", () => {
    const mine = facts();
    const other = facts().map((session) => ({
      ...session,
      userId: "00000000-0000-4000-8000-000000000002",
    }));
    const combined = projectFacts([...mine, ...other]);
    expect(combined.e1rm.filter((row) => row.userId === mine[0]!.userId)).toHaveLength(3);
    expect(combined.e1rm.filter((row) => row.userId === other[0]!.userId)).toHaveLength(3);
    expect(JSON.stringify(projectFacts([...other, ...mine]))).toBe(JSON.stringify(combined));
    expect(projectFacts([...mine, ...mine])).toEqual(projectFacts(mine));
  });
});
