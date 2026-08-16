/**
 * 통합 테스트(실제 postgres): POST /v1/sessions/ad-hoc — 휴식일 즉석 세션(FEATURES_UX F8-1).
 *
 * 고정 테스트 날짜(2026-08-14, 금요일)가 휴식일인 주 2일 프로그램으로 검증한다.
 * lazy materialization 이후 생성된 세션을 임의 삭제하면 다음 조회가 다시 생성하므로 삭제로 만들지 않는다.
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { testUserId } from "./support/users";
import { expectErrorMatchesContract, expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
/** dev-user(...0001)·tenancy(...0002)·dashboard(...0003) 와 겹치지 않는 고정 UUID. */
const OTHER_USER_ID = testUserId("adhoc");

const PATH = "/sessions/ad-hoc";
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

describe("즉석 세션 (F8-1)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await resetUserData(prisma, USER_ID, OTHER_USER_ID);
      await prisma.user.deleteMany({ where: { id: OTHER_USER_ID } });
    }
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID, OTHER_USER_ID);
  });

  /** 주 2일 프로그램 생성 + 현재 주 lazy materialization(금요일은 휴식일). */
  async function restDayProgram(pain?: string[]): Promise<void> {
    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send({ ...PROGRAM, days_per_week: 2, ...(pain ? { pain_areas: pain } : {}) })
      .expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  }

  async function createAdHoc(bodyPart: string) {
    return request(app.getHttpServer()).post("/v1/sessions/ad-hoc").send({ body_part: bodyPart });
  }

  /** 응답 planned_sets 를 운동 단위(등장 순서)로 접는다. */
  function exercisesOf(body: { planned_sets: { exercise_id: string }[] }): string[] {
    return [...new Set(body.planned_sets.map((set) => set.exercise_id))];
  }

  it("201 + openapi Session 스키마, 오늘 날짜로 현재 프로그램에 붙는다", async () => {
    await restDayProgram();

    const response = await createAdHoc("chest");

    expect(response.status).toBe(201);
    expectMatchesContract("post", PATH, 201, response.body);
    expect(response.body.scheduled_date).toBe(utcToday().toISOString().slice(0, 10));
    expect(response.body.status).toBe("scheduled");
    const program = await prisma.program.findFirstOrThrow({ where: { userId: USER_ID } });
    expect(response.body.program_id).toBe(program.id);
  });

  it("고른 부위(가슴)의 운동만 배정되고 GET /sessions/{id} 로 다시 읽힌다", async () => {
    await restDayProgram();

    const created = await createAdHoc("chest");
    const detail = await request(app.getHttpServer())
      .get(`/v1/sessions/${created.body.id}`)
      .expect(200);

    expectMatchesContract("get", "/sessions/{sessionId}", 200, detail.body);
    const exerciseIds = exercisesOf(detail.body);
    expect(exerciseIds.length).toBeGreaterThan(0);
    const catalog = await prisma.exercise.findMany({ where: { id: { in: exerciseIds } } });
    // 가슴 = horizontal_push (program-rules 의 부위 매핑). 다른 부위 종목이 섞이면 여기서 깨진다.
    for (const exercise of catalog) {
      expect(exercise.movementPattern).toBe("horizontal_push");
    }
    expect(exerciseIds).toContain("e_bench_press");
  });

  it("목표·세트 수는 프로그램 생성 규칙 그대로다(근비대 복합 6~12, 3세트, 휴식 120초)", async () => {
    await restDayProgram();

    const response = await createAdHoc("chest");

    const benchSets = response.body.planned_sets.filter(
      (set: { exercise_id: string }) => set.exercise_id === "e_bench_press",
    );
    expect(benchSets).toHaveLength(3);
    expect(benchSets[0]).toMatchObject({
      target_reps_low: 6,
      target_reps_high: 12,
      target_rir: 2,
      rest_sec: 120,
      reason_code: null,
      recommendation_gate: "no_history",
      rules_version: "2026.08.1",
    });
  });

  it("각 부위가 그 부위의 동작 패턴만 고른다", async () => {
    const expected: Record<string, string[]> = {
      back: ["vertical_pull", "horizontal_pull"],
      shoulders: ["vertical_push", "shoulder_isolation"],
      arms: ["elbow_flexion", "elbow_extension"],
      legs: ["squat", "hinge", "lunge", "knee_extension", "knee_flexion", "calf"],
      core: ["core"],
    };

    for (const [bodyPart, patterns] of Object.entries(expected)) {
      await resetUserData(prisma, USER_ID);
      await restDayProgram();

      const response = await createAdHoc(bodyPart);

      expect(response.status).toBe(201);
      const catalog = await prisma.exercise.findMany({
        where: { id: { in: exercisesOf(response.body) } },
      });
      expect(catalog.length).toBeGreaterThan(0);
      for (const exercise of catalog) {
        expect(patterns).toContain(exercise.movementPattern);
      }
    }
  });

  /** 안전: 통증 부위 제외(SAFETY_PAIN_MAPPING.md)는 즉석 세션에도 그대로 걸린다. */
  it("통증 부위(무릎) 제외가 즉석 세션에도 적용된다", async () => {
    await restDayProgram(["knee"]);

    const response = await createAdHoc("legs");

    expect(response.status).toBe(201);
    const catalog = await prisma.exercise.findMany({
      where: { id: { in: exercisesOf(response.body) } },
    });
    expect(catalog.length).toBeGreaterThan(0);
    for (const exercise of catalog) {
      // knee → squat/lunge/knee_extension 제외
      expect(["squat", "lunge", "knee_extension"]).not.toContain(exercise.movementPattern);
    }
  });

  /**
   * 안전(재평가 D-2): `wrist` 는 제외 패턴이 0건이라 excluded_exercises 가 비고, 그러면 즉석 세션이
   * 통증 부위를 하나도 되읽지 못해 머신/케이블 우선 배려(SAFETY_PAIN_MAPPING.md 규칙 4)가 사라졌다.
   * 가슴 후보 4종 중 머신은 e_chest_press_machine 하나뿐이고, 배려가 살아 있으면 그게 첫 자리에 온다
   * (배려가 없으면 난이도·id 순으로 e_bench_press 가 먼저 온다).
   */
  it("손목 통증만 보고한 프로그램의 즉석 세션도 머신/케이블을 먼저 고른다", async () => {
    await restDayProgram(["wrist"]);

    const response = await createAdHoc("chest");

    expect(response.status).toBe(201);
    expect(exercisesOf(response.body)[0]).toBe("e_chest_press_machine");
  });

  /** 즉석 세션은 계획 세션과 구분해 저장한다 — 대시보드 스트릭·주간 완료율이 이 값을 본다(D-1). */
  it("즉석 세션은 origin=ad_hoc, 프로그램이 펼친 세션은 origin=planned 다", async () => {
    await restDayProgram();

    const created = await createAdHoc("chest");

    expect(created.status).toBe(201);
    const sessions = await prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
    });
    const adHoc = sessions.filter((session) => session.origin === "ad_hoc");
    expect(adHoc.map((session) => session.id)).toEqual([created.body.id]);
    expect(sessions.length).toBeGreaterThan(1);
  });

  it("오늘 이미 세션이 있으면 409 이고 세션이 늘지 않는다", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const program = await prisma.program.findFirstOrThrow({ where: { userId: USER_ID } });
    await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: utcToday(),
        focus: "upper",
        status: "scheduled",
      },
    });
    const before = await prisma.workoutSession.count({ where: { programId: program.id } });

    const response = await createAdHoc("chest");

    expectErrorMatchesContract("post", PATH, 409, response);
    expect(response.body.error.code).toBe("CONFLICT");
    await expect(prisma.workoutSession.count({ where: { programId: program.id } })).resolves.toBe(
      before,
    );
  });

  it("종료된 오늘 세션이 있어도 409 다(하루에 두 개를 만들지 않는다)", async () => {
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
    const program = await prisma.program.findFirstOrThrow({ where: { userId: USER_ID } });
    await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: utcToday(),
        focus: "upper",
        status: "completed",
      },
    });

    expectErrorMatchesContract("post", PATH, 409, await createAdHoc("chest"));
  });

  /** 더블 탭(동시 요청)이 둘 다 통과하면 오늘 세션이 두 개가 되고 대시보드의 "오늘"이 갈라진다. */
  it("동시에 두 번 눌러도 오늘 세션은 하나만 생긴다", async () => {
    await restDayProgram();

    const responses = await Promise.all([createAdHoc("chest"), createAdHoc("back")]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    await expect(
      prisma.workoutSession.count({
        where: { program: { userId: USER_ID }, scheduledDate: utcToday() },
      }),
    ).resolves.toBe(1);
  });

  it("프로그램이 없으면 404", async () => {
    expectErrorMatchesContract("post", PATH, 404, await createAdHoc("chest"));
  });

  it.each([{}, { body_part: "가슴" }, { body_part: "upper" }, { body_part: null }])(
    "잘못된 body_part(%p)는 400 이고 세션을 만들지 않는다",
    async (body) => {
      await restDayProgram();

      const response = await request(app.getHttpServer()).post("/v1/sessions/ad-hoc").send(body);

      expectErrorMatchesContract("post", PATH, 400, response);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      await expect(
        prisma.workoutSession.count({
          where: { program: { userId: USER_ID }, scheduledDate: utcToday() },
        }),
      ).resolves.toBe(0);
    },
  );

  /** 테넌시: 즉석 세션도 내 프로그램·내 user_id 에만 매달린다. */
  it("남의 프로그램에 만들지 않고, 남은 내 즉석 세션을 읽을 수 없다", async () => {
    await prisma.user.upsert({
      where: { id: OTHER_USER_ID },
      update: {},
      create: {
        id: OTHER_USER_ID,
        sex: "other",
        birthYear: 1990,
        heightCm: 180,
        weightKg: 80,
        goal: "strength",
        experienceLevel: "advanced",
        constraints: {},
      },
    });
    const otherProgram = await prisma.program.create({
      data: {
        userId: OTHER_USER_ID,
        goal: "strength",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
      },
    });
    await restDayProgram();

    const created = await createAdHoc("chest");

    expect(created.status).toBe(201);
    const session = await prisma.workoutSession.findUniqueOrThrow({
      where: { id: created.body.id },
      include: { program: true },
    });
    expect(session.program.userId).toBe(USER_ID);
    await expect(
      prisma.workoutSession.count({ where: { programId: otherProgram.id } }),
    ).resolves.toBe(0);

    // 남의 세션(다른 user_id)은 존재를 알리지 않고 404 다.
    const otherSession = await prisma.workoutSession.create({
      data: {
        programId: otherProgram.id,
        scheduledDate: utcToday(),
        focus: "chest",
        status: "scheduled",
      },
    });
    const forbidden = await request(app.getHttpServer()).get(`/v1/sessions/${otherSession.id}`);
    expectErrorMatchesContract("get", "/sessions/{sessionId}", 404, forbidden);
  });
});
