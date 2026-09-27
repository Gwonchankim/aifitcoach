import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { seedExercises } from "../prisma/seed-exercises";

const migration = resolve(
  __dirname,
  "../prisma/migrations/20260927010000_exercise_domain/migration.sql",
);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("S1 modality migration and conditional DB guard", () => {
  const prisma = new PrismaClient();
  afterAll(async () => prisma.$disconnect());
  // Run the actual migration's single backfill DO block, not a duplicate implementation.
  function backfillSql(): string {
    const sql = readFileSync(migration, "utf8");
    const block = sql.match(/DO \$backfill\$[\s\S]*?\$backfill\$;/)?.[0];
    if (!block) throw new Error("missing canonical backfill block");
    return block;
  }
  it("backfills 110/110 twice and seed is idempotent; old catalog/history bytes do not move", async () => {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        sex: "male",
        birthYear: 1990,
        heightCm: 175,
        weightKg: 70,
        goal: "diet",
        experienceLevel: "beginner",
        constraints: {},
      },
    });
    try {
      const program = await prisma.program.create({
        data: {
          userId: user.id,
          goal: "diet",
          daysPerWeek: 3,
          minutesPerDay: 60,
          splitType: "full_body",
          rulesVersion: "2026.08.1",
          template: [{ day: "MON", focus: "full_body", exercises: [] }],
          generationInput: { goal: "diet" },
        },
      });
      const session = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date("2026-08-03"),
          focus: "full_body",
          status: "completed",
        },
      });
      const plan = await prisma.plannedSet.create({
        data: {
          sessionId: session.id,
          exerciseId: "e_plank",
          orderIndex: 0,
          setNo: 1,
          restSec: 90,
          targetTimeLowSec: 30,
          targetTimeHighSec: 60,
          reasonCode: "BASELINE",
          confidence: 0.5,
          rulesVersion: "2026.08.1",
          loadSemantics: "external_load",
        },
      });
      await prisma.performedSet.create({
        data: {
          plannedSetId: plan.id,
          actualTimeSec: 42,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date("2026-08-03T10:00:00Z"),
        },
      });
      const history = async () => ({
        program: await prisma.program.findUnique({ where: { id: program.id } }),
        session: await prisma.workoutSession.findUnique({ where: { id: session.id } }),
        plan: await prisma.plannedSet.findUnique({ where: { id: plan.id } }),
        performed: await prisma.performedSet.findMany({ where: { plannedSetId: plan.id } }),
      });
      const catalog = () =>
        prisma.$queryRawUnsafe<Array<{ row: unknown }>>(
          "SELECT to_jsonb(e) - 'modality' AS row FROM exercises e ORDER BY id",
        );
      const beforeCatalog = await catalog();
      const beforeHistory = await history();
      await prisma.$executeRawUnsafe("UPDATE exercises SET modality = NULL");
      await prisma.$executeRawUnsafe(backfillSql());
      const once = await prisma.exercise.findMany({ orderBy: { id: "asc" } });
      expect(once).toHaveLength(110);
      expect(once.every((row) => row.modality === "resistance")).toBe(true);
      await prisma.$executeRawUnsafe(backfillSql());
      expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(once);
      expect(await seedExercises(prisma)).toBe(110);
      expect(await seedExercises(prisma)).toBe(110);
      expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(once);
      expect(await catalog()).toEqual(beforeCatalog);
      expect(await history()).toEqual(beforeHistory);
      console.log(
        "S1_DOMAIN_IMMUTABLE",
        JSON.stringify({
          catalog: hash(beforeCatalog),
          history: hash(beforeHistory),
          catalogAfter: hash(await catalog()),
          historyAfter: hash(await history()),
        }),
      );
    } finally {
      await prisma.performedSet.deleteMany({
        where: { plannedSet: { session: { program: { userId: user.id } } } },
      });
      await prisma.plannedSet.deleteMany({ where: { session: { program: { userId: user.id } } } });
      await prisma.workoutSession.deleteMany({ where: { program: { userId: user.id } } });
      await prisma.program.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
  it("unknown DB ID aborts backfill explicitly and changes no known row", async () => {
    const original = await prisma.exercise.findUniqueOrThrow({ where: { id: "e_plank" } });
    await prisma.exercise.create({
      data: {
        ...original,
        media: original.media === null ? Prisma.JsonNull : original.media,
        id: "e_t06_unknown",
        modality: null,
      },
    });
    try {
      await expect(prisma.$executeRawUnsafe(backfillSql())).rejects.toThrow(/unknown exercise ID/);
      expect(await prisma.exercise.findUnique({ where: { id: original.id } })).toEqual(original);
      expect(
        (await prisma.exercise.findUniqueOrThrow({ where: { id: "e_t06_unknown" } })).modality,
      ).toBeNull();
    } finally {
      await prisma.exercise.delete({ where: { id: "e_t06_unknown" } });
    }
  });
  it.each(["movement_pattern", "mechanic", "region", "load_semantics"])(
    "legacy and resistance reject NULL %s",
    async (column) => {
      for (const modality of ["NULL", "'resistance'"]) {
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE exercises SET modality=${modality}, ${column}=NULL WHERE id='e_plank'`,
          ),
        ).rejects.toThrow(/ck_exercise_domain/);
      }
    },
  );
  it.each(["cardio", "mobility", "warmup"])(
    "%s accepts only explicit null resistance metadata",
    async (modality) => {
      const original = await prisma.exercise.findUniqueOrThrow({ where: { id: "e_plank" } });
      const id = `e_t06_${modality}`;
      const data = {
        ...original,
        id,
        modality,
        movementPattern: null,
        mechanic: null,
        region: null,
        loadSemantics: null,
        defaultRepsLow: null,
        defaultRepsHigh: null,
        defaultTimeLowSec: null,
        defaultTimeHighSec: null,
        defaultStepKg: null,
      };
      // SQL uses the real CHECK, including explicit nulls; no non-resistance seed is installed.
      await prisma.$executeRawUnsafe(
        `INSERT INTO exercises SELECT (jsonb_populate_record(NULL::exercises, to_jsonb(e) || $1::jsonb)).* FROM exercises e WHERE id='e_plank'`,
        JSON.stringify({
          id,
          modality,
          movement_pattern: null,
          mechanic: null,
          region: null,
          load_semantics: null,
          default_reps_low: null,
          default_reps_high: null,
          default_time_low_sec: null,
          default_time_high_sec: null,
          default_step_kg: null,
        }),
      );
      try {
        expect(await prisma.exercise.findUnique({ where: { id } })).toEqual(data);
        for (const [column, value] of [
          ["mechanic", "'compound'"],
          ["movement_pattern", "'core'"],
          ["region", "'core'"],
          ["load_semantics", "'external_load'"],
          ["default_reps_low", "1"],
          ["default_reps_high", "2"],
          ["default_time_low_sec", "1"],
          ["default_time_high_sec", "2"],
          ["default_step_kg", "1"],
        ]) {
          await expect(
            prisma.$executeRawUnsafe(`UPDATE exercises SET ${column}=${value} WHERE id=$1`, id),
          ).rejects.toThrow(/ck_exercise_domain/);
        }
        if (modality === "cardio")
          await expect(
            prisma.$executeRawUnsafe("UPDATE exercises SET metric='reps' WHERE id=$1", id),
          ).rejects.toThrow(/ck_exercise_domain/);
        else
          expect(
            await prisma.$executeRawUnsafe("UPDATE exercises SET metric='reps' WHERE id=$1", id),
          ).toBe(1);
      } finally {
        await prisma.exercise.delete({ where: { id } });
      }
    },
  );
});
