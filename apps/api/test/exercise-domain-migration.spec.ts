import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const migration = resolve(
  __dirname,
  "../prisma/migrations/20260927010000_exercise_domain/migration.sql",
);
const source = readFileSync(migration);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prisma = new PrismaClient();
const backfill = source.toString("utf8").match(/DO \$backfill\$[\s\S]*?\$backfill\$;/)?.[0];
if (!backfill) throw new Error("missing canonical backfill block");

/** The historical S1 SQL sees exactly its 110-row schema; public S2's 111 rows remain independent. */
async function withS1Fixture<T>(body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "CREATE TEMP TABLE exercises (LIKE public.exercises INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP",
    );
    // Removing S2-only columns also removes their dependent S2 CHECK; the actual S1 CHECK remains.
    await tx.$executeRawUnsafe(
      "ALTER TABLE pg_temp.exercises DROP COLUMN cardio_movement_regions, DROP COLUMN prescription_kinds_supported, DROP COLUMN blocked_reported_pain_areas",
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO pg_temp.exercises SELECT (jsonb_populate_record(NULL::pg_temp.exercises, to_jsonb(e))).* FROM public.exercises e WHERE modality='resistance'",
    );
    await tx.$executeRawUnsafe("SET LOCAL search_path = pg_temp, public");
    const constraints = await tx.$queryRawUnsafe<{ conname: string }[]>(
      "SELECT conname FROM pg_constraint WHERE conrelid='pg_temp.exercises'::regclass",
    );
    expect(constraints.map((row) => row.conname)).toContain("ck_exercise_domain");
    expect(constraints.map((row) => row.conname)).not.toContain("ck_exercise_cardio_metadata");
    return body(tx);
  });
}
const rows = (tx: Prisma.TransactionClient) =>
  tx.$queryRawUnsafe<{ row: Record<string, unknown> }[]>(
    "SELECT to_jsonb(e) AS row FROM exercises e ORDER BY id",
  );
async function rejected(tx: Prisma.TransactionClient, sql: string, ...values: unknown[]) {
  await tx.$executeRawUnsafe("SAVEPOINT negative_case");
  try {
    await expect(tx.$executeRawUnsafe(sql, ...values)).rejects.toThrow(
      /ck_exercise_domain|unknown exercise ID/,
    );
  } finally {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT negative_case");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT negative_case");
  }
}

describe("S1 migration isolated from additive S2 cardio catalog", () => {
  afterAll(async () => prisma.$disconnect());
  it("pins the unchanged S1 migration source bytes", () => {
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "1dbeb61707a6beb0c2a36ca4fe945fc396b989bc3e3a673e3435b607c3078ac2",
    );
  });
  it("backfills 110/110 twice byte-identically; public catalog and performed history never move", async () => {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
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
          userId: id,
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
      const beforeHistory = await history();
      const publicBefore = await prisma.exercise.findMany({ orderBy: { id: "asc" } });
      expect(publicBefore).toHaveLength(111);
      await withS1Fixture(async (tx) => {
        const before = await rows(tx);
        expect(before).toHaveLength(110);
        await tx.$executeRawUnsafe("UPDATE exercises SET modality=NULL");
        await tx.$executeRawUnsafe(backfill);
        const once = await rows(tx);
        expect(once).toHaveLength(110);
        expect(once.every(({ row }) => row.modality === "resistance")).toBe(true);
        expect(once).toEqual(before);
        await tx.$executeRawUnsafe(backfill);
        expect(await rows(tx)).toEqual(once);
        console.log(
          "S1_DOMAIN_IMMUTABLE",
          JSON.stringify({
            catalog: hash(before),
            catalogAfter: hash(await rows(tx)),
            history: hash(beforeHistory),
          }),
        );
      });
      expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(publicBefore);
      expect(await history()).toEqual(beforeHistory);
    } finally {
      await prisma.performedSet.deleteMany({
        where: { plannedSet: { session: { program: { userId: id } } } },
      });
      await prisma.plannedSet.deleteMany({ where: { session: { program: { userId: id } } } });
      await prisma.workoutSession.deleteMany({ where: { program: { userId: id } } });
      await prisma.program.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } });
    }
  });
  it("unknown historical DB ID aborts actual backfill without changing known rows", async () => {
    await withS1Fixture(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO exercises SELECT (jsonb_populate_record(NULL::exercises, to_jsonb(e) || \'{"id":"e_t06_unknown","modality":null}\'::jsonb)).* FROM exercises e WHERE id=\'e_plank\'',
      );
      const before = await rows(tx);
      await rejected(tx, backfill);
      expect(await rows(tx)).toEqual(before);
      expect(before.find(({ row }) => row.id === "e_t06_unknown")?.row.modality).toBeNull();
    });
  });
  it.each(["movement_pattern", "mechanic", "region", "load_semantics"])(
    "legacy and resistance reject NULL %s",
    async (column) => {
      await withS1Fixture(async (tx) => {
        for (const modality of ["NULL", "'resistance'"])
          await rejected(
            tx,
            `UPDATE exercises SET modality=${modality}, ${column}=NULL WHERE id='e_plank'`,
          );
      });
    },
  );
  it.each(["cardio", "mobility", "warmup"])(
    "historical %s requires explicit NULL resistance metadata",
    async (modality) => {
      await withS1Fixture(async (tx) => {
        const [original] = await tx.$queryRawUnsafe<{ row: Record<string, unknown> }[]>(
          "SELECT to_jsonb(e) AS row FROM exercises e WHERE id='e_plank'",
        );
        const delta = {
          id: `e_t06_${modality}`,
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
        };
        await tx.$executeRawUnsafe(
          "INSERT INTO exercises SELECT (jsonb_populate_record(NULL::exercises, to_jsonb(e) || $1::jsonb)).* FROM exercises e WHERE id='e_plank'",
          JSON.stringify(delta),
        );
        expect((await rows(tx)).find(({ row }) => row.id === delta.id)?.row).toEqual({
          ...original.row,
          ...delta,
        });
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
        ])
          await rejected(tx, `UPDATE exercises SET ${column}=${value} WHERE id=$1`, delta.id);
        if (modality === "cardio")
          await rejected(tx, "UPDATE exercises SET metric='reps' WHERE id=$1", delta.id);
        else
          expect(
            await tx.$executeRawUnsafe("UPDATE exercises SET metric='reps' WHERE id=$1", delta.id),
          ).toBe(1);
      });
    },
  );
});
