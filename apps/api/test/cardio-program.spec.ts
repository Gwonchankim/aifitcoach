import type { INestApplication } from "@nestjs/common";
import { RULES_BUNDLE_V2_SPLIT } from "shared";
import { cardioProgramPlan } from "../src/programs/cardio-program-plan";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService } from "../src/programs/programs.service";
import { createTestApp, resetUserData } from "./support/app";

const input = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
  equipment: ["bodyweight", "barbell", "dumbbell", "machine", "cable", "stationary_bike"],
  pain_areas: [],
} as const;
const request = () => ({ ...input, equipment: [...input.equipment], pain_areas: [] as string[] });

describe("S2 actual cardio program persistence", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let programs: ProgramsService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    programs = app.get(ProgramsService);
  }, 60_000);
  afterAll(async () => app?.close());
  beforeEach(async () => resetUserData(prisma, devUserId()));

  it("persists an actual canonical block through immutable template and two lazy weeks", async () => {
    const result = await programs.generateWithRulesVersion(
      devUserId(),
      request(),
      RULES_BUNDLE_V2_SPLIT,
    );
    const template = result.sessions.flatMap((session) => session.exercises);
    const cardio = template.filter((item) => item.exercise_id === "e_stationary_bike");
    expect(cardio).toHaveLength(1);
    expect(cardio[0]).toMatchObject({
      prescription_kind: "steady_cardio",
      duration_sec: 600,
      rpe_scale_id: "relative_effort_0_10_v1",
      target_rpe_low: 5,
      target_rpe_high: 6,
      source_day: "FRI",
      source_ordinal: 4,
      intensity_seconds: { moderate: 600, high: 0, recovery: 0 },
    });
    expect(await prisma.workoutSession.count({ where: { programId: result.program_id } })).toBe(0);
    await programs.current(devUserId());
    const blocks = await prisma.plannedSet.findMany({
      where: { session: { programId: result.program_id }, exerciseId: "e_stationary_bike" },
      orderBy: { session: { scheduledDate: "asc" } },
    });
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toMatchObject({
        prescriptionKind: "steady_cardio",
        durationSec: 600,
        sourceDay: "FRI",
        sourceOrdinal: 4,
        targetRepsLow: null,
        targetTimeHighSec: null,
        targetRir: null,
        recommendedWeight: null,
        reasonCode: null,
        confidence: null,
        restSec: null,
        loadSemantics: null,
        assistanceStepKg: null,
        assistanceProvenance: null,
      });
    }
    expect(blocks[0]!.id).not.toBe(blocks[1]!.id);
    const stored = await prisma.program.findUniqueOrThrow({ where: { id: result.program_id } });
    expect(stored.template).toEqual(result.sessions);
    await programs.current(devUserId());
    expect(
      await prisma.plannedSet.count({
        where: { session: { programId: result.program_id }, exerciseId: "e_stationary_bike" },
      }),
    ).toBe(2);
  });

  it.each([
    undefined,
    ["knee"],
    ["lower_back"],
    ["shoulder"],
    ["elbow"],
    ["wrist"],
    ["hip"],
    ["neck"],
    ["ankle"],
  ])("fails closed for missing or denied pain context %j without partial writes", async (pain) => {
    const dto = request();
    if (pain === undefined) delete (dto as { pain_areas?: string[] }).pain_areas;
    else dto.pain_areas = pain;
    await expect(
      programs.generateWithRulesVersion(devUserId(), dto, RULES_BUNDLE_V2_SPLIT),
    ).rejects.toThrow();
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(0);
  });

  it("generic machine is not an available stationary bike", async () => {
    await expect(
      programs.generateWithRulesVersion(
        devUserId(),
        { ...request(), equipment: ["machine"] },
        RULES_BUNDLE_V2_SPLIT,
      ),
    ).rejects.toThrow();
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(0);
  });

  it("fails atomically when an inherited pure-cardio block exceeds the total time budget", async () => {
    const dto = {
      ...request(),
      goal: "diet" as const,
      days_per_week: 3,
      minutes_per_day: 60 as const,
    };
    const plan = cardioProgramPlan(dto, await prisma.exercise.findMany());
    const slots = [...plan.byDay.values()];
    const pureDay = plan.composition.slots.findIndex((slot) => slot.container === "C");
    expect(pureDay).toBeGreaterThanOrEqual(0);
    const slot = slots[pureDay]!;
    expect(slot.descriptor).not.toBeNull();
    slots[pureDay] = {
      ...slot,
      cardio_fallback: null,
      descriptor: { ...slot.descriptor!, duration_sec: 3600 },
    };
    await expect(
      programs.generateWithRulesVersion(devUserId(), dto, RULES_BUNDLE_V2_SPLIT, {
        mandatoryBlocksByDay: {},
        cardioSlots: slots,
      }),
    ).rejects.toMatchObject({
      response: { details: { reason: "insufficient_time_for_mixed_focus" } },
    });
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(0);
  });

  it("rejects a tampered lazy cardio source ordinal without inserting any session", async () => {
    const result = await programs.generateWithRulesVersion(
      devUserId(),
      request(),
      RULES_BUNDLE_V2_SPLIT,
    );
    const template = JSON.parse(JSON.stringify(result.sessions));
    const cardio = template
      .flatMap(
        (day: { exercises: { exercise_id: string; source_ordinal: number }[] }) => day.exercises,
      )
      .find((item: { exercise_id: string }) => item.exercise_id === "e_stationary_bike");
    cardio.source_ordinal = 1;
    await prisma.program.update({ where: { id: result.program_id }, data: { template } });
    await expect(programs.current(devUserId())).rejects.toMatchObject({
      response: { details: { reason: "cardio_preservation_failed" } },
    });
    expect(await prisma.workoutSession.count({ where: { programId: result.program_id } })).toBe(0);
  });

  it("rejects frozen mixed time failure atomically instead of shrinking the donor", async () => {
    await expect(
      programs.generateWithRulesVersion(
        devUserId(),
        { ...request(), goal: "diet", minutes_per_day: 30 },
        RULES_BUNDLE_V2_SPLIT,
      ),
    ).rejects.toMatchObject({
      response: { details: { reason: "insufficient_time_for_mixed_focus" } },
    });
    expect(await prisma.program.count({ where: { userId: devUserId() } })).toBe(0);
  });
});
