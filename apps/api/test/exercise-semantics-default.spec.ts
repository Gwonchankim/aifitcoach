import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { testDatabaseUrl } from "./support/database-url";

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });

afterAll(async () => prisma.$disconnect());

it("requires explicit exercise load semantics instead of silently defaulting", async () => {
  const columns = await prisma.$queryRaw<{ column_default: string | null; is_nullable: string }[]>`
    SELECT column_default, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'exercises' AND column_name = 'load_semantics'
  `;
  // S1 permits NULL only for non-resistance; ck_exercise_domain guards resistance/legacy rows.
  expect(columns).toEqual([{ column_default: null, is_nullable: "YES" }]);
});

it("forward correction preserves every catalog field and rejects an omitted semantics value", async () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      "../prisma/migrations/20260912000000_require_explicit_exercise_semantics/migration.sql",
    ),
    "utf8",
  );
  const before = await prisma.exercise.findMany({ orderBy: { id: "asc" } });
  await prisma.$transaction(async (tx) => {
    expect(before.some((row) => row.loadSemantics === "assistance")).toBe(true);
    expect(before.some((row) => row.loadSemantics === "external_load")).toBe(true);
    expect(before.some((row) => row.modality === "cardio" && row.loadSemantics === null)).toBe(
      true,
    );
    // Reconstruct the old default, then execute the actual forward migration, not a test copy.
    await tx.$executeRawUnsafe(
      "ALTER TABLE exercises ALTER COLUMN load_semantics SET DEFAULT 'external_load'",
    );
    await tx.$executeRawUnsafe(sql);
    expect(await tx.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
  await expect(
    prisma.$executeRaw`UPDATE exercises SET load_semantics = DEFAULT WHERE id = 'e_assisted_pullup'`,
  ).rejects.toMatchObject({
    code: "P2010",
    meta: { code: "23514", message: expect.stringContaining("ck_exercise_domain") },
  });
  await expect(
    prisma.$executeRaw`UPDATE exercises SET modality = NULL, load_semantics = DEFAULT WHERE id = 'e_assisted_pullup'`,
  ).rejects.toMatchObject({
    code: "P2010",
    meta: { code: "23514", message: expect.stringContaining("ck_exercise_domain") },
  });
  // Omit load_semantics from a real INSERT; every other required field comes from a valid row.
  await expect(prisma.$executeRaw`
    INSERT INTO exercises (id, name_ko, name_en, modality, movement_pattern, mechanic, region,
      primary_muscles, secondary_muscles, equipment, difficulty, metric, unilateral,
      substitutions, cues, media)
    SELECT 'e_missing_semantics_test', name_ko, name_en, modality, movement_pattern, mechanic, region,
      primary_muscles, secondary_muscles, equipment, difficulty, metric, unilateral,
      substitutions, cues, media
    FROM exercises WHERE id = 'e_assisted_pullup'
  `).rejects.toMatchObject({
    code: "P2010",
    meta: { code: "23514", message: expect.stringContaining("ck_exercise_domain") },
  });
  expect(
    await prisma.$executeRaw`UPDATE exercises SET load_semantics = NULL WHERE id = 'e_stationary_bike'`,
  ).toBe(1);
  expect(
    (await prisma.exercise.findUniqueOrThrow({ where: { id: "e_assisted_pullup" } })).loadSemantics,
  ).toBe("assistance");
  expect(await prisma.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(before);
});
