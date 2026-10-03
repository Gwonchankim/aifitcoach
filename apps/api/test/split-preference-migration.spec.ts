import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const source = readFileSync(
  resolve(__dirname, "../prisma/migrations/20261003000000_split_preference/migration.sql"),
);
const prisma = new PrismaClient();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("S3 additive nullable preference migration", () => {
  afterAll(async () => prisma.$disconnect());

  it("pins the exact migration SQL used by the isolated legacy-schema exercise", () => {
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "682f0a5f033b43dd9eedca968b5cf8e55ee4a8f15809de9f19fe4ebc4ea7b6ea",
    );
  });

  it("keeps all legacy User fields including updated_at byte-exact; never rewrites public history", async () => {
    const namespace = `t06_s3_${randomUUID().replaceAll("-", "")}`;
    expect(namespace).toMatch(/^t06_s3_[0-9a-f]{32}$/);
    const sentinel = new Error("rollback owned migration fixture");
    const publicHistory = async () => ({
      programs: await prisma.$queryRawUnsafe(
        "SELECT to_jsonb(p) AS row FROM public.programs p ORDER BY id",
      ),
      planned: await prisma.$queryRawUnsafe(
        "SELECT to_jsonb(p) AS row FROM public.planned_sets p ORDER BY id",
      ),
    });
    const beforeHistory = await publicHistory();
    await expect(
      prisma.$transaction(async (tx) => {
        // Owned, transaction-local schema: public User and history are only ever read.
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path = "${namespace}"`);
        await tx.$executeRawUnsafe("CREATE TABLE users AS SELECT * FROM public.users");
        await tx.$executeRawUnsafe("ALTER TABLE users DROP COLUMN split_preference");
        const fixtureId = randomUUID();
        await tx.$executeRawUnsafe(
          "INSERT INTO users (id, sex, birth_year, height_cm, weight_kg, goal, experience_level, constraints, created_at, updated_at) VALUES ($1::uuid, 'male', 1990, 175, 70, 'diet', 'beginner', '{}'::jsonb, '2026-01-01T00:00:00Z', '2026-01-02T03:04:05Z')",
          fixtureId,
        );
        const read = () =>
          tx.$queryRawUnsafe<{ row: Record<string, unknown> }[]>(
            "SELECT to_jsonb(u) AS row FROM users u ORDER BY id",
          );
        const before = await read();
        expect(before.length).toBeGreaterThan(0);
        // Full checked-in SQL, unedited. DO allows multiple DDL statements in one prepared query.
        await tx.$executeRawUnsafe(
          `DO $s3_migration$ BEGIN\n${source.toString("utf8")}\nEND $s3_migration$;`,
        );
        const after = await read();
        for (const { row } of after) {
          expect(Object.hasOwn(row, "split_preference")).toBe(true);
          expect(row.split_preference).toBeNull();
        }
        const oldFields = after.map(({ row }) => {
          const { split_preference: _newField, ...legacy } = row;
          return { row: legacy };
        });
        expect(oldFields).toEqual(before);
        expect(hash(oldFields)).toBe(hash(before));
        const column = await tx.$queryRawUnsafe<{ is_nullable: string; column_default: unknown }[]>(
          "SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='split_preference'",
          namespace,
        );
        expect(column).toEqual([{ is_nullable: "YES", column_default: null }]);
        for (const preference of ["balanced", "upper_priority", "lower_priority", null]) {
          await tx.$executeRawUnsafe(
            "UPDATE users SET split_preference=$1::split_preference WHERE id=$2::uuid",
            preference,
            fixtureId,
          );
          const rows = await read();
          expect(rows.find(({ row }) => row.id === fixtureId)!.row.split_preference).toBe(
            preference,
          );
          expect(rows.find(({ row }) => row.id === fixtureId)!.row.updated_at).toEqual(
            before.find(({ row }) => row.id === fixtureId)!.row.updated_at,
          );
        }
        await tx.$executeRawUnsafe("SAVEPOINT invalid_preference");
        try {
          await expect(
            tx.$executeRawUnsafe("UPDATE users SET split_preference='unknown'::split_preference"),
          ).rejects.toThrow(/invalid input value for enum/);
        } finally {
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_preference");
          await tx.$executeRawUnsafe("RELEASE SAVEPOINT invalid_preference");
        }
        expect(await read()).toEqual(after);
        console.info(
          `S3_USER_MIGRATION legacyRows=${before.length} before=${hash(before)} after=${hash(oldFields)}`,
        );
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(await publicHistory()).toEqual(beforeHistory);
    expect(
      await prisma.$queryRawUnsafe("SELECT nspname FROM pg_namespace WHERE nspname=$1", namespace),
    ).toEqual([]);
  });
});
