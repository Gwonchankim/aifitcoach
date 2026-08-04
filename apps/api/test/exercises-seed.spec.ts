/**
 * 통합 테스트(실제 postgres 필요): 마이그레이션 + 시드 적재 후 exercises 조회를 검증한다.
 *
 * 격리: 개발용 DB(DATABASE_URL)를 그대로 쓰지 않고 이름 뒤에 `_test` 를 붙인 별도 DB를 쓴다.
 *   - 시드는 참조 데이터 upsert 라 트랜잭션 롤백으로는 "적재된 결과"를 검증할 수 없다(커밋된 상태를 봐야 한다).
 *   - 별도 DB면 개발 데이터가 오염되지 않고, `prisma migrate deploy` 가 DB를 자동 생성한다.
 * DATABASE_URL 이 없으면 명확한 메시지로 실패한다(스킵하지 않는다).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { PrismaClient } from "@prisma/client";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function testDatabaseUrl(): string {
  loadDotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL 이 필요하다. `pnpm db:up` 후 루트 .env(.env.example 복사)를 만들거나 환경변수로 넘겨라.",
    );
  }
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, "");
  if (!dbName) throw new Error(`DATABASE_URL 에 데이터베이스 이름이 없다: ${raw}`);
  url.pathname = `/${dbName.endsWith("_test") ? dbName : `${dbName}_test`}`;
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

function run(script: string): void {
  try {
    execSync(`pnpm --filter api ${script}`, {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL },
      stdio: "pipe",
    });
  } catch (error) {
    // stdio:"pipe" 라 기본 메시지에 원인이 안 실린다 → CI 에서 추적 가능하도록 출력을 붙인다.
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `${script} 실패\n--- stdout ---\n${stdout?.toString() ?? ""}\n--- stderr ---\n${stderr?.toString() ?? ""}`,
    );
  }
}

describe("exercises 시드", () => {
  beforeAll(async () => {
    run("db:migrate");
    run("db:seed");
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("시드 30종이 적재된다", async () => {
    await expect(prisma.exercise.count()).resolves.toBe(30);
  });

  it("substitutions 참조가 모두 존재한다", async () => {
    const exercises = await prisma.exercise.findMany({
      select: { id: true, substitutions: true },
    });
    const ids = new Set(exercises.map((e) => e.id));
    const dangling = exercises.flatMap((e) => e.substitutions.filter((sub) => !ids.has(sub)));
    expect(dangling).toEqual([]);
  });

  it("e_bench_press 를 스키마대로 반환한다", async () => {
    const exercise = await prisma.exercise.findUniqueOrThrow({ where: { id: "e_bench_press" } });

    expect({ ...exercise, defaultStepKg: exercise.defaultStepKg?.toNumber() }).toEqual({
      id: "e_bench_press",
      nameKo: "바벨 벤치프레스",
      nameEn: "Barbell Bench Press",
      movementPattern: "horizontal_push",
      mechanic: "compound",
      region: "upper",
      primaryMuscles: ["chest"],
      secondaryMuscles: ["front_delts", "triceps"],
      equipment: "barbell",
      difficulty: "intermediate",
      metric: "reps",
      defaultRepsLow: 5,
      defaultRepsHigh: 12,
      defaultTimeLowSec: null,
      defaultTimeHighSec: null,
      defaultStepKg: 2.5,
      unilateral: false,
      substitutions: ["e_incline_db_press", "e_chest_press_machine", "e_dips"],
      cues: ["견갑을 모으고 고정", "바를 가슴 중앙으로", "발로 바닥을 민다"],
      media: { image_url: null, video_url: null },
    });
  });

  it("metric=time 종목은 time 범위를 갖는다", async () => {
    const plank = await prisma.exercise.findUniqueOrThrow({ where: { id: "e_plank" } });

    expect(plank.metric).toBe("time");
    expect(plank.defaultTimeLowSec).toBe(20);
    expect(plank.defaultTimeHighSec).toBe(60);
    expect(plank.defaultRepsLow).toBeNull();
    expect(plank.defaultStepKg).toBeNull();
  });
});
