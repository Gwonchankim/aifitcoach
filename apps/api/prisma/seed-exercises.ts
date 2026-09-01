/**
 * docs/specs/exercises_seed.json 을 exercises 테이블에 id 기준으로 upsert 한다.
 * 시드 JSON은 진실의 원천이므로 수정하지 않고, 불일치가 있으면 이 스크립트가 실패한다.
 *
 * 실행: pnpm --filter api db:seed   (진입점은 scripts/seed-exercises.ts)
 * DATABASE_URL 은 레포 루트 .env 또는 환경변수에서 읽는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { $Enums, Prisma, PrismaClient } from "@prisma/client";
import { loadSemanticsFor } from "../src/programs/assistance-migration";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SEED_FILE = path.join(REPO_ROOT, "docs", "specs", "exercises_seed.json");

const ALLOWED_KEYS = new Set([
  "id",
  "name_ko",
  "name_en",
  "movement_pattern",
  "mechanic",
  "region",
  "primary_muscles",
  "secondary_muscles",
  "equipment",
  "difficulty",
  "metric",
  "default_reps_low",
  "default_reps_high",
  "default_time_low_sec",
  "default_time_high_sec",
  "default_step_kg",
  "unilateral",
  "substitutions",
  "cues",
  "media",
]);

class SeedError extends Error {}

function fail(where: string, message: string): never {
  throw new SeedError(`${where}: ${message}`);
}

function str(row: Record<string, unknown>, key: string, where: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(where, `${key} 는 비어있지 않은 문자열이어야 한다 (got ${JSON.stringify(value)})`);
  }
  return value;
}

function strArray(row: Record<string, unknown>, key: string, where: string): string[] {
  const value = row[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(where, `${key} 는 문자열 배열이어야 한다 (got ${JSON.stringify(value)})`);
  }
  return value as string[];
}

function bool(row: Record<string, unknown>, key: string, where: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    fail(where, `${key} 는 boolean 이어야 한다 (got ${JSON.stringify(value)})`);
  }
  return value;
}

function intOrNull(row: Record<string, unknown>, key: string, where: string): number | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(where, `${key} 는 정수여야 한다 (got ${JSON.stringify(value)})`);
  }
  return value;
}

function numOrNull(row: Record<string, unknown>, key: string, where: string): number | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(where, `${key} 는 숫자여야 한다 (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Prisma 가 생성한 enum 객체로 검증한다 → 스키마 enum 과 값이 정확히 일치해야 통과. */
function enumValue<T extends Record<string, string>>(
  row: Record<string, unknown>,
  key: string,
  enumObject: T,
  where: string,
): T[keyof T] {
  const value = row[key];
  if (typeof value !== "string" || !Object.hasOwn(enumObject, value)) {
    fail(
      where,
      `${key}=${JSON.stringify(value)} 는 스키마 enum 에 없다 (allowed: ${Object.keys(enumObject).join(", ")})`,
    );
  }
  return value as T[keyof T];
}

/** 시드 1행 → exercises 행. 필드명은 Prisma 모델과 1:1. */
type ExerciseSeed = {
  id: string;
  nameKo: string;
  nameEn: string;
  movementPattern: $Enums.MovementPattern;
  mechanic: $Enums.Mechanic;
  region: $Enums.Region;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: $Enums.Equipment;
  difficulty: $Enums.Difficulty;
  metric: $Enums.Metric;
  defaultRepsLow: number | null;
  defaultRepsHigh: number | null;
  defaultTimeLowSec: number | null;
  defaultTimeHighSec: number | null;
  defaultStepKg: number | null;
  unilateral: boolean;
  loadSemantics: "assistance" | "external_load";
  substitutions: string[];
  cues: string[];
  media: Prisma.InputJsonValue;
};

function toExerciseInput(raw: unknown, index: number): ExerciseSeed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`exercises[${index}]`, "객체여야 한다");
  }
  const row = raw as Record<string, unknown>;
  const where = `exercises[${index}] (${String(row.id)})`;

  const unknownKeys = Object.keys(row).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    fail(where, `스키마에 없는 필드: ${unknownKeys.join(", ")}`);
  }

  const metric = enumValue(row, "metric", $Enums.Metric, where);
  const defaultRepsLow = intOrNull(row, "default_reps_low", where);
  const defaultRepsHigh = intOrNull(row, "default_reps_high", where);
  const defaultTimeLowSec = intOrNull(row, "default_time_low_sec", where);
  const defaultTimeHighSec = intOrNull(row, "default_time_high_sec", where);

  if (metric === $Enums.Metric.reps && (defaultRepsLow === null || defaultRepsHigh === null)) {
    fail(where, "metric=reps 는 default_reps_low/high 가 필요하다");
  }
  if (
    metric === $Enums.Metric.time &&
    (defaultTimeLowSec === null || defaultTimeHighSec === null)
  ) {
    fail(where, "metric=time 은 default_time_low_sec/high 가 필요하다");
  }

  const media = row.media;
  if (typeof media !== "object" || media === null || Array.isArray(media)) {
    fail(where, `media 는 객체여야 한다 (got ${JSON.stringify(media)})`);
  }

  return {
    id: str(row, "id", where),
    nameKo: str(row, "name_ko", where),
    nameEn: str(row, "name_en", where),
    movementPattern: enumValue(row, "movement_pattern", $Enums.MovementPattern, where),
    mechanic: enumValue(row, "mechanic", $Enums.Mechanic, where),
    region: enumValue(row, "region", $Enums.Region, where),
    primaryMuscles: strArray(row, "primary_muscles", where),
    secondaryMuscles: strArray(row, "secondary_muscles", where),
    equipment: enumValue(row, "equipment", $Enums.Equipment, where),
    difficulty: enumValue(row, "difficulty", $Enums.Difficulty, where),
    metric,
    defaultRepsLow,
    defaultRepsHigh,
    defaultTimeLowSec,
    defaultTimeHighSec,
    defaultStepKg: numOrNull(row, "default_step_kg", where),
    unilateral: bool(row, "unilateral", where),
    // canonical — 시드 파일이 값을 갖지 않아도 목록이 결정한다(F-3 guard).
    loadSemantics: loadSemanticsFor(String(row.id)),
    substitutions: strArray(row, "substitutions", where),
    cues: strArray(row, "cues", where),
    media: media as Prisma.InputJsonValue,
  };
}

function parseSeedFile(filePath: string = SEED_FILE): ExerciseSeed[] {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const exercises = (parsed as { exercises?: unknown }).exercises;
  if (!Array.isArray(exercises)) {
    fail(filePath, "최상위 exercises 배열이 없다");
  }

  const inputs = exercises.map(toExerciseInput);

  const ids = new Set(inputs.map((e) => e.id));
  if (ids.size !== inputs.length) {
    fail(filePath, "중복된 exercise id 가 있다");
  }
  for (const exercise of inputs) {
    const missing = exercise.substitutions.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      fail(`exercises(${exercise.id})`, `존재하지 않는 substitutions 참조: ${missing.join(", ")}`);
    }
  }
  return inputs;
}

/** 시드를 적재하고 적재된 행 수를 돌려준다. DB 상태로 substitutions 참조 무결성까지 확인한다. */
async function seedExercises(prisma: PrismaClient): Promise<number> {
  const inputs = parseSeedFile();
  for (const input of inputs) {
    await prisma.exercise.upsert({ where: { id: input.id }, create: input, update: input });
  }

  const stored = await prisma.exercise.findMany({ select: { id: true, substitutions: true } });
  const storedIds = new Set(stored.map((e) => e.id));
  for (const exercise of stored) {
    const missing = exercise.substitutions.filter((id) => !storedIds.has(id));
    if (missing.length > 0) {
      fail(`db exercises(${exercise.id})`, `substitutions 참조 누락: ${missing.join(", ")}`);
    }
  }
  return inputs.length;
}

export async function main(): Promise<void> {
  loadDotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
  if (!process.env.DATABASE_URL) {
    throw new SeedError("DATABASE_URL 이 없다 (.env 또는 환경변수 필요)");
  }

  const prisma = new PrismaClient();
  try {
    const count = await seedExercises(prisma);
    const total = await prisma.exercise.count();
    if (total !== count) {
      fail("db exercises", `시드에 없는 잔여 행이 있다 (시드 ${count} / 테이블 ${total})`);
    }
    console.log(`seeded ${count} exercises (table count = ${total})`);
  } finally {
    await prisma.$disconnect();
  }
}
