import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient, type Exercise } from "@prisma/client";
import request from "supertest";
import {
  RULES_BUNDLE_V2_SPLIT,
  parseCardioSnapshot,
  type CardioBlockDescriptor,
  type Goal,
  type SplitPreference,
} from "shared";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService, type GenerateProgramInput } from "../src/programs/programs.service";
import { storedCardioSnapshot } from "../src/sessions/planned-prescription";
import { UsersService } from "../src/users/users.service";
import { resetUserData } from "./support/app";

interface FrozenCase {
  id: string;
  slots: { ordinal: number; descriptor: CardioBlockDescriptor | null }[];
}

const goals: Goal[] = ["diet", "hypertrophy", "strength", "general_fitness", "endurance"];
const policies: { days: number; preference: SplitPreference; focuses: string[] }[] = [
  { days: 4, preference: "balanced", focuses: ["upper", "lower", "upper", "lower"] },
  { days: 5, preference: "upper_priority", focuses: ["upper", "lower", "upper", "lower", "upper"] },
  { days: 5, preference: "lower_priority", focuses: ["lower", "upper", "lower", "upper", "lower"] },
];
const cases = goals.flatMap((goal) => policies.map((policy) => ({ goal, ...policy })));

describe("S3 actual five-goal split matrix and bounded reads", () => {
  let app: INestApplication;
  let client: PrismaClient;
  let prisma: PrismaService;
  let programs: ProgramsService;
  let catalog: Map<string, Exercise>;
  let golden: FrozenCase[];
  const queries: string[] = [];
  beforeAll(async () => {
    golden = (
      JSON.parse(
        readFileSync(resolve(__dirname, "../../../docs/specs/cardio_baseline_golden.json"), "utf8"),
      ) as { cases: FrozenCase[] }
    ).cases;
    const observed = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    observed.$on("query", (event) => {
      if (!/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(event.query)) queries.push(event.query);
    });
    client = observed;
    await client.$connect();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(observed)
      .compile();
    app = configureApp(module.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    programs = app.get(ProgramsService);
    await request(app.getHttpServer()).get("/v1/me").expect(200);
    catalog = new Map((await prisma.exercise.findMany()).map((row) => [row.id, row]));
  }, 60_000);
  beforeEach(async () => resetUserData(prisma, devUserId()));
  afterAll(async () => {
    await app?.close();
    await client?.$disconnect();
  });

  it.each(cases)(
    "$goal $days days $preference preserves frozen donors and actual focus sets",
    async ({ goal, days, preference, focuses }) => {
      const dto: GenerateProgramInput = {
        goal,
        days_per_week: days,
        minutes_per_day: 60,
        experience_level: "intermediate",
        split_preference: preference,
        equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "stationary_bike"],
        pain_areas: [],
      };
      queries.length = 0;
      const result = await programs.generateWithRulesVersion(
        devUserId(),
        dto,
        RULES_BUNDLE_V2_SPLIT,
      );
      const generationQueryCount = queries.length;
      // Diagnostic categories only: never print SQL values, user identifiers, or prescriptions.
      console.info(
        "S3_GENERATION_QUERY_CATEGORIES",
        queries.map((sql) => ({
          operation: sql.trim().split(/\s+/)[0],
          tables: [
            ...new Set(
              [...sql.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+"public"\."([a-z_]+)"/g)].map(
                (match) => match[1],
              ),
            ),
          ],
        })),
      );
      // S2 already reads calibration inside similar-history mapping and again for generation.
      // Exact categories make that inherited constant cost visible; no profile preference read.
      const count = (operation: string, table: string) =>
        queries.filter(
          (sql) =>
            sql.trim().startsWith(operation) &&
            sql.match(/(?:FROM|INTO)\s+"public"\."([a-z_]+)"/)?.[1] === table,
        ).length;
      expect(generationQueryCount).toBe(7);
      expect(count("SELECT", "exercises")).toBe(1);
      expect(count("SELECT", "performed_sets")).toBe(3);
      expect(count("SELECT", "user_rir_calibration")).toBe(2);
      expect(count("INSERT", "programs")).toBe(1);
      expect(count("SELECT", "users")).toBe(0);
      expect(result.sessions.map((slot) => slot.focus)).toEqual(focuses);
      expect(result.sessions.map((slot) => slot.day)).toEqual(
        days === 4 ? ["MON", "TUE", "THU", "FRI"] : ["MON", "TUE", "WED", "FRI", "SAT"],
      );
      const baseline = golden.find((row) => row.id === `${goal}-${days}-60-not_cleared`)!;
      expect(baseline).toBeDefined();
      for (const [index, slot] of result.sessions.entries()) {
        const primary = slot.exercises.find((item) => {
          const exercise = catalog.get(item.exercise_id)!;
          return exercise.modality === "resistance" && exercise.movementPattern !== "core";
        });
        expect(primary).toBeDefined();
        expect(catalog.get(primary!.exercise_id)!.region).toBe(slot.focus);
        expect(primary!.sets).toBeGreaterThanOrEqual(2);
        const snapshot = parseCardioSnapshot(
          slot.exercises.find((item) => item.exercise_id === "e_stationary_bike"),
        );
        const donor = baseline.slots[index]!.descriptor;
        if (donor === null) {
          expect(snapshot).toBeNull();
        } else {
          expect(snapshot).not.toBeNull();
          const {
            prescription_kind: _kind,
            source_day,
            source_ordinal,
            intensity_seconds,
            cardio_fallback: _fallback,
            ...descriptor
          } = snapshot!;
          expect({ kind: descriptor.long_session_flag ? "long" : "steady", ...descriptor }).toEqual(
            donor,
          );
          expect(source_day).toBe(slot.day);
          expect(source_ordinal).toBe(index + 1);
          expect(intensity_seconds).toEqual({ moderate: donor.duration_sec, high: 0, recovery: 0 });
        }
      }
      const before = await prisma.program.findUniqueOrThrow({ where: { id: result.program_id } });
      expect(before.template).toEqual(result.sessions);
      expect((before.generationInput as Record<string, unknown>).split_preference_snapshot).toEqual(
        result.split_preference_snapshot,
      );
      expect(await prisma.workoutSession.count({ where: { programId: result.program_id } })).toBe(
        0,
      );
      await programs.current(devUserId());
      const sessions = await prisma.workoutSession.findMany({
        where: { programId: result.program_id },
        include: { plannedSets: true },
        orderBy: { scheduledDate: "asc" },
      });
      expect(sessions).toHaveLength(days * 2);
      for (const [index, session] of sessions.entries()) {
        const template = result.sessions[index % days]!;
        expect(session.focus).toBe(template.focus);
        for (const exercise of template.exercises) {
          const rows = session.plannedSets.filter((row) => row.exerciseId === exercise.exercise_id);
          if (
            exercise.prescription_kind === "steady_cardio" ||
            exercise.prescription_kind === "interval_cardio"
          ) {
            expect(rows).toHaveLength(1);
            expect(storedCardioSnapshot(rows[0]!)).toEqual(parseCardioSnapshot(exercise));
          } else expect(rows).toHaveLength(exercise.sets!);
        }
      }
      expect(await prisma.program.findUniqueOrThrow({ where: { id: result.program_id } })).toEqual(
        before,
      );
      console.info(
        `S3_MATRIX ${goal} days=${days} preference=${preference} generationQueries=${generationQueryCount} sessions=${sessions.length}`,
      );
    },
  );

  it("profile preference adds one owner-scoped update without per-field reads", async () => {
    const users = app.get(UsersService);
    queries.length = 0;
    await users.getProfile(devUserId());
    const getCount = queries.length;
    expect(getCount).toBeLessThanOrEqual(2);
    queries.length = 0;
    await users.updateProfile(devUserId(), { split_preference: "lower_priority" });
    const patchCount = queries.length;
    expect(patchCount).toBeLessThanOrEqual(3);
    expect(queries.filter((sql) => /^UPDATE /.test(sql))).toHaveLength(1);
    queries.length = 0;
    await expect(
      users.updateProfile(devUserId(), { split_preference: "balanced", weight_kg: 75 }),
    ).rejects.toMatchObject({ status: 501 });
    expect(queries).toHaveLength(0);
    await users.updateProfile(devUserId(), { split_preference: null });
    console.info(`S3_PROFILE getQueries=${getCount} patchQueries=${patchCount} rejectedQueries=0`);
  });
});
