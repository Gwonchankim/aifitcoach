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
  expect(columns).toEqual([{ column_default: null, is_nullable: "NO" }]);
});

it("forward correction preserves every catalog field and rejects an omitted semantics value", async () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      "../prisma/migrations/20260912000000_require_explicit_exercise_semantics/migration.sql",
    ),
    "utf8",
  );
  await prisma.$transaction(async (tx) => {
    const before = await tx.exercise.findMany({ orderBy: { id: "asc" } });
    expect(before.some((row) => row.loadSemantics === "assistance")).toBe(true);
    expect(before.some((row) => row.loadSemantics === "external_load")).toBe(true);
    // Reconstruct the old default, then execute the actual forward migration, not a test copy.
    await tx.$executeRawUnsafe(
      "ALTER TABLE exercises ALTER COLUMN load_semantics SET DEFAULT 'external_load'",
    );
    await tx.$executeRawUnsafe(sql);
    expect(await tx.exercise.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
  await expect(
    prisma.$executeRaw`UPDATE exercises SET load_semantics = DEFAULT WHERE id = 'e_assisted_pullup'`,
  ).rejects.toMatchObject({ code: "P2010", meta: { code: "23502" } });
  expect(
    (await prisma.exercise.findUniqueOrThrow({ where: { id: "e_assisted_pullup" } })).loadSemantics,
  ).toBe("assistance");
});
