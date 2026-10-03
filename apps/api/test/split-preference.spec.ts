import type { INestApplication } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import request from "supertest";
import { RULES_BUNDLE_V2_SPLIT } from "shared";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramRulesBundleProvider } from "../src/programs/program-rules-bundle.provider";
import { PlannedSetFactory } from "../src/programs/planned-set.factory";
import { ProgramsService } from "../src/programs/programs.service";
import { createTestApp, resetUserData } from "./support/app";

const input = {
  goal: "hypertrophy",
  days_per_week: 5,
  minutes_per_day: 60,
  experience_level: "intermediate",
  equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "stationary_bike"],
  pain_areas: [],
} as const;

describe("S3 split preference profile and immutable generated plan", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bundle: jest.SpyInstance;
  const profile = () => request(app.getHttpServer()).get("/v1/me");
  const patch = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).patch("/v1/me").send(body);
  const generate = (body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...input, ...body });
  const counts = async () => ({
    programs: await prisma.program.count({ where: { userId: devUserId() } }),
    sessions: await prisma.workoutSession.count({ where: { program: { userId: devUserId() } } }),
    planned: await prisma.plannedSet.count({
      where: { session: { program: { userId: devUserId() } } },
    }),
  });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    bundle = jest.spyOn(app.get(ProgramRulesBundleProvider), "current");
  }, 60_000);
  beforeEach(async () => {
    bundle.mockReturnValue(RULES_BUNDLE_V2_SPLIT);
    await resetUserData(prisma, devUserId());
    await patch({ split_preference: null });
  });
  afterAll(async () => {
    await patch({ split_preference: null });
    bundle.mockRestore();
    await app?.close();
  });

  it("saves and clears only preference; capability follows the same generation provider", async () => {
    expect((await profile().expect(200)).body).toMatchObject({
      split_preference: null,
      split_preference_supported: true,
    });
    for (const preference of ["balanced", "upper_priority", "lower_priority"]) {
      expect(
        (await patch({ split_preference: preference }).expect(200)).body.split_preference,
      ).toBe(preference);
      expect((await profile()).body.split_preference).toBe(preference);
    }
    const before = await prisma.user.findUniqueOrThrow({ where: { id: devUserId() } });
    await patch({}).expect(501);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: devUserId() } })).toEqual(before);
    bundle.mockReturnValue("2026.08.1");
    expect((await profile()).body).toMatchObject({
      split_preference: "lower_priority",
      split_preference_supported: false,
    });
    await patch({ split_preference: null }).expect(200);
    expect((await profile()).body.split_preference).toBeNull();
  });

  it.each([
    { weight_kg: 70 },
    { body_fat_pct: 20 },
    { goal: "strength" },
    { days_per_week: 4 },
    { minutes_per_day: 45 },
    { experience_level: "advanced" },
  ])("retains the original 501 atomically for existing unsupported field %j", async (body) => {
    await patch({ split_preference: "upper_priority" }).expect(200);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: devUserId() } });
    for (const payload of [body, { ...body, split_preference: "lower_priority" }]) {
      const rejected = await patch(payload).expect(501);
      expect(rejected.body.error.code).toBe("NOT_IMPLEMENTED");
      expect(await prisma.user.findUniqueOrThrow({ where: { id: devUserId() } })).toEqual(before);
    }
  });

  it.each(["unknown", "", 1, {}, []])("rejects invalid profile preference %j", async (value) => {
    await patch({ split_preference: value }).expect(400);
    expect((await profile()).body.split_preference).toBeNull();
  });

  it("generate null is 400 while profile null clears and omission chooses balanced", async () => {
    await patch({ split_preference: "lower_priority" }).expect(200);
    await generate({ split_preference: null }).expect(400);
    expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
    await patch({ split_preference: null }).expect(200);
    const generated = (await generate().expect(201)).body;
    expect(generated.split_preference_snapshot).toEqual({
      requested_preference: null,
      effective_preference: "balanced",
      applicable: true,
      reason: null,
      upper_days: 3,
      lower_days: 2,
    });
  });

  it("explicit request outranks a saved preference and snapshot remains immutable after profile edit", async () => {
    await patch({ split_preference: "upper_priority" }).expect(200);
    const generated = (await generate({ split_preference: "lower_priority" }).expect(201)).body;
    expect(
      generated.sessions.map((day: { day: string; focus: string }) => [day.day, day.focus]),
    ).toEqual([
      ["MON", "lower"],
      ["TUE", "upper"],
      ["WED", "lower"],
      ["FRI", "upper"],
      ["SAT", "lower"],
    ]);
    expect(generated.split_preference_snapshot).toEqual({
      requested_preference: "lower_priority",
      effective_preference: "lower_priority",
      applicable: true,
      reason: null,
      upper_days: 2,
      lower_days: 3,
    });
    const before = await prisma.program.findUniqueOrThrow({ where: { id: generated.program_id } });
    expect((before.generationInput as Record<string, unknown>).split_preference_snapshot).toEqual(
      generated.split_preference_snapshot,
    );
    await patch({ split_preference: "balanced" }).expect(200);
    const current = (await request(app.getHttpServer()).get("/v1/programs/current").expect(200))
      .body;
    expect(current.split_preference_snapshot).toEqual(generated.split_preference_snapshot);
    expect(await prisma.program.findUniqueOrThrow({ where: { id: generated.program_id } })).toEqual(
      before,
    );
    const catalog = new Map((await prisma.exercise.findMany()).map((row) => [row.id, row]));
    const sessions = await prisma.workoutSession.findMany({
      where: { programId: generated.program_id },
      include: { plannedSets: true },
    });
    expect(sessions).toHaveLength(10);
    for (const session of sessions) {
      const nonCore = session.plannedSets.filter((row) => {
        const exercise = catalog.get(row.exerciseId)!;
        return (
          exercise.modality === "resistance" &&
          exercise.region === session.focus &&
          exercise.movementPattern !== "core"
        );
      });
      expect(nonCore.length).toBeGreaterThanOrEqual(2);
      const firstExerciseId = nonCore[0]!.exerciseId;
      expect(nonCore.filter((row) => row.exerciseId === firstExerciseId)).toHaveLength(
        session.plannedSets.filter((row) => row.exerciseId === firstExerciseId).length,
      );
      expect(
        nonCore.filter((row) => row.exerciseId === firstExerciseId).length,
      ).toBeGreaterThanOrEqual(2);
    }
    expect(
      sessions
        .flatMap((day) => day.plannedSets)
        .filter((row) => row.exerciseId === "e_stationary_bike"),
    ).toHaveLength(2);
  });

  it("omission never silently reads a saved priority", async () => {
    await patch({ split_preference: "lower_priority" }).expect(200);
    expect((await generate().expect(201)).body.split_preference_snapshot).toMatchObject({
      requested_preference: null,
      effective_preference: "balanced",
      upper_days: 3,
      lower_days: 2,
    });
  });

  it.each([2, 3, 4, 6])("rejects priority on %i days without any partial write", async (days) => {
    for (const preference of ["upper_priority", "lower_priority"]) {
      await generate({ days_per_week: days, split_preference: preference }).expect(400);
      expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
    }
  });

  it.each(["2026.08.1", "2026.09.0"])("does not apply split priority in %s", async (version) => {
    bundle.mockReturnValue(version);
    await generate({ split_preference: "lower_priority" }).expect(400);
    expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
    const omitted = (await generate().expect(201)).body;
    const balanced = (await generate({ split_preference: "balanced" }).expect(201)).body;
    expect(balanced.sessions).toEqual(omitted.sessions);
    expect(balanced.split_preference_snapshot).toMatchObject({
      applicable: false,
      reason: "legacy_input",
    });
  });

  it("emits all four reserved snapshot reasons and legacy reads never write a snapshot", async () => {
    const four = (await generate({ days_per_week: 4 }).expect(201)).body;
    expect(four.split_preference_snapshot).toMatchObject({
      applicable: true,
      reason: "four_day_balanced_only",
      upper_days: 2,
      lower_days: 2,
    });
    const five = (await generate().expect(201)).body;
    const two = (await generate({ days_per_week: 2 }).expect(201)).body;
    expect(two.split_preference_snapshot).toMatchObject({
      applicable: false,
      reason: "unsupported_days",
      upper_days: 0,
      lower_days: 0,
    });
    const legacy = await prisma.program.update({
      where: { id: two.program_id },
      data: { generationInput: {} },
    });
    const read = (await request(app.getHttpServer()).get("/v1/programs/current").expect(200)).body;
    expect(read.split_preference_snapshot).toMatchObject({
      applicable: false,
      reason: "legacy_input",
      requested_preference: null,
    });
    expect(await prisma.program.findUniqueOrThrow({ where: { id: two.program_id } })).toEqual(
      legacy,
    );
    expect(
      new Set([four, five, two, read].map((row) => row.split_preference_snapshot.reason)),
    ).toEqual(new Set([null, "unsupported_days", "four_day_balanced_only", "legacy_input"]));
  });

  it("fails before persistence when a declared focus has no actual primary working sets", async () => {
    const factory = jest.spyOn(app.get(PlannedSetFactory), "build").mockResolvedValue([]);
    try {
      await generate({ split_preference: "lower_priority" }).expect(400);
      expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
    } finally {
      factory.mockRestore();
    }
  });

  it.each([
    ["non-null historical object", { sentinel: "preserve" }],
    ["historical JSON null", Prisma.JsonNull],
  ] as const)(
    "reads %s without retroactively adding or rewriting a snapshot",
    async (_label, generationInput) => {
      const generated = (await generate({ days_per_week: 4 }).expect(201)).body;
      const before = await prisma.program.update({
        where: { id: generated.program_id },
        data: { generationInput },
      });
      const current = (await request(app.getHttpServer()).get("/v1/programs/current").expect(200))
        .body;
      expect(current.split_preference_snapshot).toEqual({
        requested_preference: null,
        effective_preference: null,
        applicable: false,
        reason: "legacy_input",
        upper_days: 2,
        lower_days: 2,
      });
      expect(current.sessions.map((slot: { focus: string }) => slot.focus)).toEqual([
        "upper",
        "lower",
        "upper",
        "lower",
      ]);
      expect(
        await prisma.program.findUniqueOrThrow({ where: { id: generated.program_id } }),
      ).toEqual(before);
    },
  );

  it("rejects a core-only candidate pool atomically even when pain filters removed real exercises", async () => {
    const avoid = (await prisma.exercise.findMany())
      .filter((row) => row.modality === "resistance" && row.movementPattern !== "core")
      .map((row) => row.id);
    await generate({ split_preference: "lower_priority", avoid_exercises: avoid }).expect(400);
    expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
  });

  it("missing candidates on a later focus return 400 before an earlier mixed time conflict", async () => {
    const avoid = (await prisma.exercise.findMany())
      .filter((row) => row.modality === "resistance" && row.region === "lower")
      .map((row) => row.id);
    await generate({
      goal: "diet",
      days_per_week: 4,
      minutes_per_day: 30,
      avoid_exercises: avoid,
    }).expect(400);
    expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
  });

  it("rollback removes the just-created Program on an in-transaction persistence failure", async () => {
    const programs = app.get(ProgramsService);
    const original = prisma.$transaction.bind(prisma);
    const transaction = jest.spyOn(prisma, "$transaction").mockImplementation((callback: unknown) =>
      original(async (tx) => {
        const result = await (callback as (client: typeof tx) => Promise<unknown>)(tx);
        expect(await tx.program.count({ where: { userId: devUserId() } })).toBe(1);
        void result;
        throw new Error("injected persistence failure");
      }),
    );
    try {
      await expect(
        programs.generate(devUserId(), {
          ...input,
          equipment: [...input.equipment],
          pain_areas: [],
        }),
      ).rejects.toThrow("injected persistence failure");
    } finally {
      transaction.mockRestore();
    }
    expect(await counts()).toEqual({ programs: 0, sessions: 0, planned: 0 });
  });
});
