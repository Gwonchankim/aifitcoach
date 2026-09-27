import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  planCardioWeek,
  parseCardioSnapshot,
  toCardioSnapshot,
  RULES_BUNDLE_V2_SPLIT,
  type CardioEligibility,
  type CardioBlockDescriptor,
  type CardioBaselineInput,
} from "shared";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService } from "../src/programs/programs.service";
import { recoveryReason, WEEK_SWAP_INCLUDE } from "../src/programs/week-swap-projection";
import { storedCardioSnapshot } from "../src/sessions/planned-prescription";
import { plannedSetResponse } from "../src/sync/sync.service";
import { AggregationProjector } from "../src/analytics/aggregation.projector";
import { createTestApp, resetUserData } from "./support/app";

// Health qualification exists only in this pure-function input. The persistence entry receives
// the resulting immutable descriptor slots, never eligibility or a cleared health context.
interface FrozenCase {
  id: string;
  slots: {
    ordinal: number;
    day_offset: number;
    original_container: "S" | "C" | "H";
    descriptor: CardioBlockDescriptor | null;
  }[];
  original_lower_days: number[];
  profile: {
    screening: CardioEligibility["screening"];
    readiness: CardioEligibility["readiness"];
    recent_two_successful_cardio: boolean;
    latest_cardio_difficulty: CardioEligibility["latestCardioDifficulty"];
  };
}
function purePlan(days: number, minutes: 30 | 45 | 60 | 75 | 90 = 60) {
  const frozen = JSON.parse(
    readFileSync(resolve(__dirname, "../../../docs/specs/cardio_baseline_golden.json"), "utf8"),
  ) as { cases: FrozenCase[] };
  const fixture = frozen.cases.find((row) => row.id === `diet-${days}-${minutes}-cleared`);
  if (!fixture) throw new Error("Missing frozen source case");
  const input: CardioBaselineInput = {
    goal: "diet",
    minutesPerDay: minutes,
    slots: fixture.slots.map((slot) => ({
      ordinal: slot.ordinal,
      day_offset: slot.day_offset,
      container: slot.original_container,
    })),
    lowerExposureDays: fixture.original_lower_days.flatMap((day) => [day - 7, day, day + 7]),
    eligibility: {
      screening: fixture.profile.screening,
      readiness: fixture.profile.readiness,
      recentTwoSuccessfulCardio: fixture.profile.recent_two_successful_cardio,
      latestCardioDifficulty: fixture.profile.latest_cardio_difficulty,
    },
  };
  return {
    source: fixture,
    plan: planCardioWeek({ ...input, rulesVersion: RULES_BUNDLE_V2_SPLIT }),
  };
}
const generateInput = (days: number, minutes: 30 | 45 | 60 | 75 | 90 = 60) => ({
  goal: "diet" as const,
  days_per_week: days,
  minutes_per_day: minutes,
  experience_level: "intermediate" as const,
  equipment: ["bodyweight", "barbell", "dumbbell", "machine", "cable", "stationary_bike"],
  pain_areas: [] as string[],
});

describe("S2 qualified pure result to health-free descriptor persistence", () => {
  let app: INestApplication, prisma: PrismaService, programs: ProgramsService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    programs = app.get(ProgramsService);
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, devUserId()));
  afterAll(async () => app?.close());
  async function persist(days: number, minutes: 30 | 45 | 60 | 75 | 90 = 60) {
    const { source, plan } = purePlan(days, minutes);
    const result = await programs.generateWithRulesVersion(
      devUserId(),
      generateInput(days, minutes),
      RULES_BUNDLE_V2_SPLIT,
      { mandatoryBlocksByDay: {}, cardioSlots: plan.slots },
    );
    return { result, source, plan };
  }
  async function assertRoundTrip(value: Awaited<ReturnType<typeof persist>>) {
    const { result, plan } = value;
    const saved = await prisma.program.findUniqueOrThrow({ where: { id: result.program_id } });
    expect(saved.template).toEqual(result.sessions);
    const input = saved.generationInput as Record<string, unknown>;
    for (const key of [
      "eligibility",
      "screening",
      "readiness",
      "recentTwoSuccessfulCardio",
      "cleared",
    ])
      expect(input).not.toHaveProperty(key);
    expect(await prisma.workoutSession.count({ where: { programId: result.program_id } })).toBe(0);
    const expected = plan.slots.filter((slot) => slot.descriptor !== null).map(toCardioSnapshot);
    const templateSnapshots = result.sessions
      .flatMap((day) => day.exercises)
      .filter((row) => row.exercise_id === "e_stationary_bike")
      .map(parseCardioSnapshot);
    expect(templateSnapshots).toEqual(expected);
    await programs.current(devUserId());
    const rows = await prisma.plannedSet.findMany({
      where: { session: { programId: result.program_id }, exerciseId: "e_stationary_bike" },
      include: { exercise: true },
      orderBy: [{ session: { scheduledDate: "asc" } }, { orderIndex: "asc" }],
    });
    expect(rows).toHaveLength(expected.length * 2);
    for (const row of rows) {
      const wanted = expected.find((snapshot) => snapshot.source_ordinal === row.sourceOrdinal);
      expect(wanted).toBeDefined();
      expect(storedCardioSnapshot(row)).toEqual(wanted);
      const response = await request(app.getHttpServer())
        .get(`/v1/sessions/${row.sessionId}`)
        .expect(200);
      const wire = response.body.planned_sets.find((set: { id: string }) => set.id === row.id);
      const sync = plannedSetResponse(row, 0, undefined, row.exercise);
      expect(wire).toEqual(sync);
      expect(parseCardioSnapshot(wire)).toEqual(wanted);
      // The same strict codec is used after IndexedDB JSON persistence/reload.
      expect(parseCardioSnapshot(JSON.parse(JSON.stringify(wire)))).toEqual(wanted);
      expect(wire.recommendation_state).toBe("ready");
      expect(wire).not.toHaveProperty("recommendation");
      expect(row.recommendedWeight).toBeNull();
      expect(row.reasonCode).toBeNull();
    }
    const before = JSON.stringify(rows);
    await programs.current(devUserId());
    expect(
      JSON.stringify(
        await prisma.plannedSet.findMany({
          where: { session: { programId: result.program_id }, exerciseId: "e_stationary_bike" },
          include: { exercise: true },
          orderBy: [{ session: { scheduledDate: "asc" } }, { orderIndex: "asc" }],
        }),
      ),
    ).toBe(before);
    return { saved, rows };
  }
  it.each([4, 5])(
    "persists qualified %i-day D5(i) same-slot steady with positive total delta and exact original interval",
    async (days) => {
      const value = await persist(days);
      expect(value.plan.totals.total_sec - value.plan.source_totals.total_sec).toBeGreaterThan(0);
      expect(value.plan.totals.vigorous_sec).toBe(0);
      const fallbacks = value.plan.slots.filter(
        (slot) => slot.cardio_fallback?.cause === "redesign_recovery",
      );
      expect(fallbacks).toHaveLength(1);
      const slot = fallbacks[0]!;
      expect(slot.cardio_fallback!.original_descriptor).toEqual(
        value.source.slots[slot.source_ordinal - 1]!.descriptor,
      );
      expect(slot.cardio_fallback!.original_descriptor.kind).toBe("interval");
      expect(slot.cardio_fallback!.effective_descriptor).toEqual(slot.descriptor);
      expect(slot.descriptor!.kind).toBe("steady");
      expect(
        slot.descriptor!.duration_sec - slot.cardio_fallback!.original_descriptor.duration_sec,
      ).toBeGreaterThan(0);
      const { rows } = await assertRoundTrip(value);
      for (const row of rows) {
        expect(row.prescriptionKind).toBe("steady_cardio");
        expect(row.intensitySeconds).toEqual({ moderate: row.durationSec, high: 0, recovery: 0 });
      }
    },
  );
  it("persists qualified 3-day interval including final recovery through both lazy weeks", async () => {
    const value = await persist(3);
    const slot = value.plan.slots.find((row) => row.descriptor?.kind === "interval")!;
    expect(slot).toBeDefined();
    expect(slot.cardio_fallback).toBeNull();
    expect(slot.descriptor).toEqual(value.source.slots[slot.source_ordinal - 1]!.descriptor);
    expect(slot.descriptor!.final_recovery_included).toBe(true);
    const { rows } = await assertRoundTrip(value);
    const intervals = rows.filter((row) => row.prescriptionKind === "interval_cardio");
    expect(intervals).toHaveLength(2);
    for (const row of intervals) {
      expect(row.finalRecoveryIncluded).toBe(true);
      expect(row.durationSec).toBe((row.workSec! + row.recoverySec!) * row.rounds!);
      expect(row.intensitySeconds).toEqual({
        moderate: 0,
        high: row.workSec! * row.rounds!,
        recovery: row.recoverySec! * row.rounds!,
      });
    }
  });
  it("refuses mixed time overflow atomically while preserving the full donor", async () => {
    const { plan } = purePlan(4, 30);
    const frozen = JSON.stringify(plan);
    await expect(
      programs.generateWithRulesVersion(devUserId(), generateInput(4, 30), RULES_BUNDLE_V2_SPLIT, {
        mandatoryBlocksByDay: {},
        cardioSlots: plan.slots,
      }),
    ).rejects.toMatchObject({
      response: { details: { reason: "insufficient_time_for_mixed_focus" } },
    });
    expect(JSON.stringify(plan)).toBe(frozen);
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(0);
    expect(await prisma.workoutSession.count({ where: { program: { userId: devUserId() } } })).toBe(
      0,
    );
    expect(
      await prisma.plannedSet.count({ where: { session: { program: { userId: devUserId() } } } }),
    ).toBe(0);
  });
  it("actual cardio sessions remain unverifiable for weekly swap without changing persisted dates or rows", async () => {
    const { result } = await persist(3);
    await programs.current(devUserId());
    const program = await prisma.program.findUniqueOrThrow({ where: { id: result.program_id } });
    const actual = await prisma.workoutSession.findMany({
      where: { programId: program.id },
      include: WEEK_SWAP_INCLUDE,
      orderBy: { scheduledDate: "asc" },
    });
    const catalog = await prisma.exercise.findMany();
    expect(
      actual.some((session) =>
        session.plannedSets.some((row) => row.prescriptionKind === "interval_cardio"),
      ),
    ).toBe(true);
    const before = JSON.stringify(actual);
    expect(
      recoveryReason(program, actual, catalog, [actual[0]!.id, actual[2]!.id], utcToday()),
    ).toBe("recovery_unverifiable");
    expect(
      JSON.stringify(
        await prisma.workoutSession.findMany({
          where: { programId: program.id },
          include: WEEK_SWAP_INCLUDE,
          orderBy: { scheduledDate: "asc" },
        }),
      ),
    ).toBe(before);
  });
  it("cardio has no resistance recommendation or volume and leaves actual resistance aggregates exact", async () => {
    const { result } = await persist(3);
    await programs.current(devUserId());
    const resistance = await prisma.plannedSet.findFirstOrThrow({
      where: {
        session: { programId: result.program_id },
        exercise: { metric: "reps", modality: "resistance", loadSemantics: "external_load" },
      },
      include: { exercise: true },
    });
    await prisma.workoutSession.update({
      where: { id: resistance.sessionId },
      data: { status: "completed", completedAt: new Date() },
    });
    await prisma.performedSet.create({
      data: {
        plannedSetId: resistance.id,
        clientId: randomUUID(),
        performedAt: new Date(),
        actualWeight: 40,
        actualReps: 10,
        actualRir: 2,
        completed: true,
      },
    });
    await app.get(AggregationProjector).rebuildUser(devUserId());
    const loads = await prisma.muscleWeeklyLoad.findMany({ where: { userId: devUserId() } });
    expect(loads).toHaveLength(new Set(resistance.exercise.primaryMuscles).size);
    for (const row of loads) {
      expect(row.hardSets).toBe(1);
      expect(Number(row.volumeLoad)).toBe(400);
    }
    expect(
      await prisma.estimated1rm.count({
        where: { userId: devUserId(), exerciseId: "e_stationary_bike" },
      }),
    ).toBe(0);
    expect(
      await prisma.performedSet.count({
        where: {
          plannedSet: {
            exerciseId: "e_stationary_bike",
            session: { programId: result.program_id },
          },
        },
      }),
    ).toBe(0);
    const response = await request(app.getHttpServer())
      .get("/v1/analytics/e1rm")
      .query({ exercise_id: "e_stationary_bike" })
      .expect(200);
    expect(response.body).toMatchObject({
      exercise_id: "e_stationary_bike",
      sample_session_count: 0,
      observations: [],
      points: [],
      next_recommendation: null,
    });
    expect(await prisma.muscleWeeklyLoad.findMany({ where: { userId: devUserId() } })).toEqual(
      loads,
    );
  });
});
