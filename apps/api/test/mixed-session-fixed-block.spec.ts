import type { INestApplication } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RULES_BUNDLE_V2_SPLIT, mandatoryBlockSeconds, MixedSessionPlanError } from "shared";
import type { CardioBlockDescriptor } from "shared";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService } from "../src/programs/programs.service";
import { createTestApp, resetUserData } from "./support/app";

const frozen = JSON.parse(
  readFileSync(resolve(__dirname, "../../../docs/specs/cardio_baseline_golden.json"), "utf8"),
) as {
  cases: { id: string; slots: { ordinal: number; descriptor: CardioBlockDescriptor | null }[] }[];
};

const descriptor = (id: string, ordinal: number) => {
  const value = frozen.cases
    .find((row) => row.id === id)
    ?.slots.find((slot) => slot.ordinal === ordinal)?.descriptor;
  if (!value) throw new Error(`Missing frozen descriptor ${id}/${ordinal}`);
  const block = value as CardioBlockDescriptor;
  mandatoryBlockSeconds([block]);
  return block;
};
const base = {
  goal: "diet",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

describe("mixed mandatory block persistence", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let programs: ProgramsService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    programs = app.get(ProgramsService);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await resetUserData(prisma, devUserId());
  });

  it("descriptor_total_reaches_packer_and_persisted_plan", async () => {
    const block = descriptor("diet-4-60-not_cleared", 3);
    const result = await programs.generateWithRulesVersion(
      devUserId(),
      base,
      RULES_BUNDLE_V2_SPLIT,
      { mandatoryBlocksByDay: { MON: [block] } },
    );
    const monday = result.sessions.find((row) => row.day === "MON")!;
    const thursday = result.sessions.find((row) => row.day === "THU")!;
    expect(monday.focus).toBe(thursday.focus);
    expect(monday.exercises.reduce((sum, row) => sum + row.sets, 0)).toBeLessThan(
      thursday.exercises.reduce((sum, row) => sum + row.sets, 0),
    );
    expect(await prisma.workoutSession.count({ where: { programId: result.program_id } })).toBe(0);
    await programs.current(devUserId());
    const sessions = await prisma.workoutSession.findMany({
      where: { programId: result.program_id },
      orderBy: { scheduledDate: "asc" },
      include: {
        plannedSets: {
          orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }],
          include: { exercise: true },
        },
      },
    });
    expect(sessions).toHaveLength(8);
    for (const session of sessions) {
      const isMonday = session.scheduledDate.getUTCDay() === 1;
      const expected = isMonday
        ? monday
        : result.sessions.find(
            (row) =>
              row.day ===
              ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][session.scheduledDate.getUTCDay()],
          )!;
      const groups = expected.exercises.map((item) =>
        session.plannedSets.filter((row) => row.exerciseId === item.exercise_id),
      );
      expect(groups.map((rows) => [rows[0]?.exerciseId, rows.length])).toEqual(
        expected.exercises.map((item) => [item.exercise_id, item.sets]),
      );
      const seconds =
        780 +
        Math.max(0, groups.length - 1) * 90 +
        groups.reduce((sum, rows) => {
          const row = rows[0]!;
          const work = row.targetTimeHighSec ?? Math.max(20, Math.min(90, row.targetRepsHigh! * 4));
          return (
            sum +
            rows.length * work * (row.exercise.unilateral ? 2 : 1) +
            Math.max(0, rows.length - 1) * row.restSec
          );
        }, 0) +
        (isMonday ? block.duration_sec : 0);
      expect(seconds).toBeLessThanOrEqual(3600);
      expect(session.plannedSets.length).toBeLessThanOrEqual(16);
      expect(groups[0]!.length).toBeGreaterThanOrEqual(2);
      expect(session.plannedSets.every((row) => row.rulesVersion === RULES_BUNDLE_V2_SPLIT)).toBe(
        true,
      );
    }
  });

  it("frozen_T_case_fails_before_any_program_template_session_or_planned_write", async () => {
    const block = descriptor("diet-4-30-not_cleared", 3);
    await expect(
      programs.generateWithRulesVersion(
        devUserId(),
        { ...base, minutes_per_day: 30 },
        RULES_BUNDLE_V2_SPLIT,
        { mandatoryBlocksByDay: { THU: [block] } },
      ),
    ).rejects.toEqual(new MixedSessionPlanError("mixed_time_budget"));
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(0);
    expect(await prisma.workoutSession.count({ where: { program: { userId: devUserId() } } })).toBe(
      0,
    );
    expect(
      await prisma.plannedSet.count({ where: { session: { program: { userId: devUserId() } } } }),
    ).toBe(0);
  });

  it.each(["general_fitness", "endurance"] as const)(
    "internal %s preserves original goal and persists the diet resistance policy",
    async (goal) => {
      const result = await programs.generateWithRulesVersion(
        devUserId(),
        { ...base, goal, days_per_week: 3 },
        RULES_BUNDLE_V2_SPLIT,
      );
      expect(result.goal).toBe(goal);
      const program = await prisma.program.findUniqueOrThrow({ where: { id: result.program_id } });
      expect(program.goal).toBe(goal);
      expect(program.generationInput).toMatchObject({ goal });
      await programs.current(devUserId());
      const rows = await prisma.plannedSet.findMany({
        where: { session: { programId: result.program_id } },
        include: { exercise: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.restSec).toBe(90);
        expect(row.rulesVersion).toBe(RULES_BUNDLE_V2_SPLIT);
        if (row.exercise.metric === "reps") {
          expect([row.targetRepsLow, row.targetRepsHigh, row.targetRir]).toEqual([6, 12, 3]);
        } else {
          expect([row.targetRepsLow, row.targetRepsHigh, row.targetRir]).toEqual([
            null,
            null,
            null,
          ]);
          expect([row.targetTimeLowSec, row.targetTimeHighSec]).toEqual([
            row.exercise.defaultTimeLowSec,
            row.exercise.defaultTimeHighSec,
          ]);
        }
      }
    },
  );
});
