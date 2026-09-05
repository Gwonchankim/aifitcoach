/**
 * 통합 테스트(실제 postgres 필요): 마이그레이션 + 시드 적재 후 exercises 조회를 검증한다.
 *
 * 격리: 개발용 DB(DATABASE_URL)를 그대로 쓰지 않고 이름 뒤에 `_test` 를 붙인 별도 DB를 쓴다.
 *   - 시드는 참조 데이터 upsert 라 트랜잭션 롤백으로는 "적재된 결과"를 검증할 수 없다(커밋된 상태를 봐야 한다).
 *   - 별도 DB면 개발 데이터가 오염되지 않고, `prisma migrate deploy` 가 DB를 자동 생성한다.
 * migrate/seed 는 jest globalSetup(test/global-setup.ts)이 1회 실행한다.
 */
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { REPO_ROOT, testDatabaseUrl } from "./support/database-url";
import { applyTestDatabaseEnv } from "./global-setup";
import { CURRENT_CATALOG, BASELINE_CATALOG, CATALOG_COUNT } from "./support/catalog-extension";

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });

describe("exercises 시드", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("시드 110종이 적재된다", async () => {
    await expect(prisma.exercise.count()).resolves.toBe(CATALOG_COUNT);
  });

  it("all DB fields match the seed, including the immutable baseline106", async () => {
    const rows = await prisma.exercise.findMany();
    const normalize = (row: (typeof rows)[number]) => ({
      ...row,
      defaultStepKg: row.defaultStepKg === null ? null : Number(row.defaultStepKg),
    });
    const byId = new Map(rows.map((row) => [row.id, normalize(row)]));
    for (const expected of CURRENT_CATALOG)
      expect(byId.get(expected.id)).toEqual(normalize(expected));
    for (const expected of BASELINE_CATALOG)
      expect(byId.get(expected.id)).toEqual(normalize(expected));
    expect(
      rows
        .filter((row) => row.loadSemantics === "assistance")
        .map((row) => row.id)
        .sort(),
    ).toEqual(["e_assisted_dips", "e_assisted_pullup"]);
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
      loadSemantics: "external_load",
      unilateral: false,
      substitutions: ["e_incline_db_press", "e_chest_press_machine", "e_dips"],
      cues: ["견갑을 모으고 고정", "바를 가슴 중앙으로", "발로 바닥을 민다"],
      media: { image_url: null, video_url: null },
    });
  });

  it("e_smith_incline_bench_press 를 스키마대로 반환한다", async () => {
    const exercise = await prisma.exercise.findUniqueOrThrow({
      where: { id: "e_smith_incline_bench_press" },
    });

    expect({ ...exercise, defaultStepKg: exercise.defaultStepKg?.toNumber() }).toEqual({
      id: "e_smith_incline_bench_press",
      nameKo: "스미스머신 인클라인 벤치프레스",
      nameEn: "Smith Machine Incline Bench Press",
      movementPattern: "horizontal_push",
      mechanic: "compound",
      region: "upper",
      primaryMuscles: ["chest", "front_delts"],
      secondaryMuscles: ["triceps"],
      equipment: "machine",
      // machine 장비는 시드 전체에서 예외 없이 beginner 다 — 궤도가 고정돼 안정적이기 때문이다.
      difficulty: "beginner",
      metric: "reps",
      defaultRepsLow: 8,
      defaultRepsHigh: 12,
      defaultTimeLowSec: null,
      defaultTimeHighSec: null,
      defaultStepKg: 2.5,
      // 보호 helper `loadSemanticsFor` 가 어시스트 목록 밖 종목에 주는 기본값. 이 티켓은 helper 를 건드리지 않는다.
      loadSemantics: "external_load",
      unilateral: false,
      substitutions: ["e_incline_bench_press", "e_incline_db_press"],
      cues: ["벤치 30도", "궤도가 고정돼 안정적"],
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

/**
 * **멱등성 — 실제 시드 스크립트를 한 번 더 돌려서 본다.**
 *
 * "upsert 니까 멱등하다"는 코드를 읽은 감상이지 증거가 아니다. 배포 때 기존 환경에 시드를 다시
 * 돌리는 것이 이 티켓의 실제 운영 절차이므로, 그 절차를 그대로 실행해 **행이 늘지 않고 기존 종목이
 * 한 글자도 바뀌지 않는지** 확인한다. globalSetup 이 이미 한 번 돌렸으므로 여기가 2회차다.
 */
describe("시드 재실행", () => {
  const prisma2 = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });

  afterAll(async () => {
    await prisma2.$disconnect();
  });

  it("두 번째 실행이 행을 늘리지도 기존 종목을 바꾸지도 않는다", async () => {
    const snapshot = async () =>
      prisma2.exercise.findMany({ orderBy: { id: "asc" } }).then((rows) =>
        rows.map((row) => ({
          ...row,
          defaultStepKg: row.defaultStepKg?.toNumber() ?? null,
        })),
      );

    const before = await snapshot();
    expect(before).toHaveLength(CATALOG_COUNT);

    // globalSetup 과 같은 방식으로 **test DB 를 강제**한다. 개발 DB 는 건드리지 않는다.
    execSync("pnpm --filter api db:seed", {
      cwd: REPO_ROOT,
      env: applyTestDatabaseEnv({ ...process.env }, testDatabaseUrl()),
      stdio: "pipe",
    });

    const after = await snapshot();

    // 중복 0 · 신규 0 · 기존 불변을 한 번에 본다.
    expect(after).toEqual(before);
    expect(new Set(after.map((row) => row.id)).size).toBe(after.length);
  }, 120_000);
});
