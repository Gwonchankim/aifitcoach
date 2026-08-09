/**
 * 통합 테스트(실제 postgres): GET /v1/dashboard (FEATURES_UX F8).
 *
 * 세션은 프로그램 생성 API 대신 직접 심는다 — 요일 배치(MON/TUE/THU/FRI)에 의존하면
 * 테스트가 "오늘이 무슨 요일인가"에 따라 흔들린다. 여기서 고정하는 건 날짜 → 상태 매핑이다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { SessionOrigin, SessionStatus } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { utcToday } from "../src/common/date/utc-day";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
/** dev-user(...0001)·tenancy.spec(...0002) 와 겹치지 않는 고정 UUID. afterAll 에서 지운다. */
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000003";

const DAY_MS = 86_400_000;

/**
 * 서비스와 같은 기준(UTC)의 날짜. offset=0 이 오늘이다.
 * **`new Date()` 를 쓰지 않는다** — 서버는 utcToday()(고정 가능, ADR-50)를 보는데 테스트가 실제 시계를
 * 보면 기대값이 하루씩 어긋난다. 같은 시계를 봐야 요일 고정이 의미를 갖는다.
 */
function utcDay(offset: number): Date {
  return new Date(utcToday().getTime() + offset * DAY_MS);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 이번 주 월요일(UTC) — 주간 완료율의 주 경계와 같은 계산. */
function mondayOfThisWeek(): Date {
  const today = utcDay(0);
  return new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
}

interface SeedSet {
  weight: number | null;
  reps: number | null;
  completed?: boolean;
}

interface SeedExercise {
  exerciseId: string;
  sets: number;
  performed?: SeedSet[];
}

describe("GET /dashboard (F8 대시보드)", () => {
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

  async function createProgram(userId: string): Promise<string> {
    const program = await prisma.program.create({
      data: {
        userId,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
      },
    });
    return program.id;
  }

  /** 세션 + 계획세트(+ 선택적으로 수행기록)를 심는다. performed 는 계획세트 순서대로 붙는다. */
  async function seedSession(
    programId: string,
    date: Date,
    focus: string,
    status: SessionStatus,
    exercises: SeedExercise[] = [],
    origin: SessionOrigin = "planned",
  ): Promise<string> {
    const session = await prisma.workoutSession.create({
      data: {
        programId,
        scheduledDate: date,
        focus,
        status,
        origin,
        ...(status === "completed" ? { completedAt: date } : {}),
      },
    });

    for (const [orderIndex, exercise] of exercises.entries()) {
      await prisma.plannedSet.createMany({
        data: Array.from({ length: exercise.sets }, (_unused, index) => ({
          sessionId: session.id,
          exerciseId: exercise.exerciseId,
          orderIndex,
          setNo: index + 1,
          targetRepsLow: 6,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 120,
          reasonCode: "BASELINE",
          confidence: 0.5,
          rulesVersion: "2026.08.1",
        })),
      });
      const planned = await prisma.plannedSet.findMany({
        where: { sessionId: session.id, exerciseId: exercise.exerciseId },
        orderBy: { setNo: "asc" },
      });
      for (const [index, set] of (exercise.performed ?? []).entries()) {
        await prisma.performedSet.create({
          data: {
            plannedSetId: planned[index].id,
            actualWeight: set.weight,
            actualReps: set.reps,
            completed: set.completed ?? true,
            clientId: randomUUID(),
            performedAt: date,
          },
        });
      }
    }
    return session.id;
  }

  async function seedOtherUser(): Promise<string> {
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
    return createProgram(OTHER_USER_ID);
  }

  /** 대시보드 호출 + 계약(ajv + 키셋) 검증. 모든 2xx 응답이 이 게이트를 통과해야 한다. */
  async function dashboard() {
    const response = await request(app.getHttpServer()).get("/v1/dashboard").expect(200);
    expectMatchesContract("get", "/dashboard", 200, response.body);
    return response.body;
  }

  it("프로그램이 없으면 오늘·내일 모두 휴식이고 지표는 0 이다(빈 상태)", async () => {
    const body = await dashboard();

    expect(body).toEqual({
      date: isoDate(utcDay(0)),
      today: { status: "rest", session_id: null, routine_summary: null, done_summary: null },
      tomorrow: { status: "rest", routine_summary: null },
      streak_days: 0,
      weekly_completion_rate: 0,
    });
  });

  it("오늘 휴식일: status=rest, session_id=null (내일 예정은 그대로 보인다)", async () => {
    const programId = await createProgram(USER_ID);
    await seedSession(programId, utcDay(1), "lower", "scheduled", [
      { exerciseId: "e_back_squat", sets: 3 },
      { exerciseId: "e_leg_curl", sets: 3 },
    ]);

    const body = await dashboard();

    expect(body.today).toEqual({
      status: "rest",
      session_id: null,
      routine_summary: null,
      done_summary: null,
    });
    expect(body.tomorrow).toEqual({
      status: "workout",
      routine_summary: { exercise_count: 2, focus: "lower" },
    });
  });

  it("오늘 미수행: status=workout + routine_summary, done_summary=null, 내일 휴식", async () => {
    const programId = await createProgram(USER_ID);
    const sessionId = await seedSession(programId, utcDay(0), "upper", "scheduled", [
      { exerciseId: "e_bench_press", sets: 3 },
      { exerciseId: "e_barbell_row", sets: 3 },
      { exerciseId: "e_lateral_raise", sets: 3 },
    ]);

    const body = await dashboard();

    expect(body.today).toEqual({
      status: "workout",
      session_id: sessionId,
      routine_summary: { exercise_count: 3, focus: "upper" },
      done_summary: null,
    });
    expect(body.tomorrow).toEqual({ status: "rest", routine_summary: null });
  });

  it("today.session_id 로 GET /sessions/{id} 를 이어서 부를 수 있다(대시보드 → 데일리 루틴 진입 경로)", async () => {
    const programId = await createProgram(USER_ID);
    await seedSession(programId, utcDay(0), "upper", "scheduled", [
      { exerciseId: "e_bench_press", sets: 3 },
    ]);

    const body = await dashboard();

    const session = await request(app.getHttpServer())
      .get(`/v1/sessions/${body.today.session_id}`)
      .expect(200);
    expectMatchesContract("get", "/sessions/{sessionId}", 200, session.body);
    expect(session.body.id).toBe(body.today.session_id);
    expect(session.body.planned_sets).toHaveLength(3);
  });

  describe("오늘 완료(done_summary)", () => {
    it("status=done + 볼륨·완료 세트 수·PR", async () => {
      const programId = await createProgram(USER_ID);
      // 지난주 같은 종목 60kg×10 (e1RM 80) → 오늘 70kg×10 (e1RM 93.3) 은 경신이다.
      await seedSession(programId, utcDay(-7), "upper", "completed", [
        { exerciseId: "e_bench_press", sets: 3, performed: [{ weight: 60, reps: 10 }] },
      ]);
      const sessionId = await seedSession(programId, utcDay(0), "upper", "completed", [
        {
          exerciseId: "e_bench_press",
          sets: 3,
          performed: [
            { weight: 70, reps: 10 },
            { weight: 70, reps: 10 },
            { weight: 70, reps: 10 },
          ],
        },
        // 맨몸 종목: 무게가 null 이라 볼륨에는 안 들어가고 완료 세트 수에는 들어간다.
        {
          exerciseId: "e_dips",
          sets: 3,
          performed: [
            { weight: null, reps: 12 },
            { weight: null, reps: 10 },
            // 완료 체크하지 않은 세트는 어디에도 세지 않는다(F7 부분 수행).
            { weight: null, reps: 8, completed: false },
          ],
        },
      ]);

      const body = await dashboard();

      expect(body.today.status).toBe("done");
      expect(body.today.session_id).toBe(sessionId);
      expect(body.today.routine_summary).toEqual({ exercise_count: 2, focus: "upper" });
      expect(body.today.done_summary).toEqual({
        total_volume: 2100,
        sets_completed: 5,
        pr_count: 1,
      });
    });

    it("이전 기록이 없는 종목은 PR 로 세지 않는다", async () => {
      const programId = await createProgram(USER_ID);
      await seedSession(programId, utcDay(0), "lower", "completed", [
        { exerciseId: "e_back_squat", sets: 2, performed: [{ weight: 100, reps: 5 }] },
      ]);

      const body = await dashboard();

      expect(body.today.done_summary).toEqual({
        total_volume: 500,
        sets_completed: 1,
        pr_count: 0,
      });
    });

    it("같은 종목이라도 이전 최고 e1RM 을 넘지 못하면 PR 이 아니다", async () => {
      const programId = await createProgram(USER_ID);
      // 지난주 60kg×12 (e1RM 84) vs 오늘 70kg×5 (e1RM 81.7) → 경신 아님
      await seedSession(programId, utcDay(-7), "upper", "completed", [
        { exerciseId: "e_bench_press", sets: 1, performed: [{ weight: 60, reps: 12 }] },
      ]);
      await seedSession(programId, utcDay(0), "upper", "completed", [
        { exerciseId: "e_bench_press", sets: 1, performed: [{ weight: 70, reps: 5 }] },
      ]);

      const body = await dashboard();

      expect(body.today.done_summary.pr_count).toBe(0);
    });
  });

  describe("streak_days", () => {
    it("휴식일(계획 없는 날)은 스트릭을 끊지 않는다", async () => {
      const programId = await createProgram(USER_ID);
      await seedSession(programId, utcDay(-3), "upper", "completed");
      // utcDay(-2) 는 계획 자체가 없는 휴식일이다.
      await seedSession(programId, utcDay(-1), "lower", "completed");
      await seedSession(programId, utcDay(0), "upper", "completed");

      expect((await dashboard()).streak_days).toBe(3);
    });

    it("계획된 운동일을 건너뛰면 거기서 끊긴다", async () => {
      const programId = await createProgram(USER_ID);
      await seedSession(programId, utcDay(-2), "upper", "completed");
      await seedSession(programId, utcDay(-1), "lower", "scheduled");
      await seedSession(programId, utcDay(0), "upper", "completed");

      expect((await dashboard()).streak_days).toBe(1);
    });

    it("오늘은 아직 남았으므로 미수행이어도 어제까지의 스트릭을 유지한다", async () => {
      const programId = await createProgram(USER_ID);
      await seedSession(programId, utcDay(-1), "lower", "completed");
      await seedSession(programId, utcDay(0), "upper", "scheduled");

      expect((await dashboard()).streak_days).toBe(1);
    });

    /**
     * 즉석 세션(F8-1)은 **계획이 아니다**. 계획에 없던 운동을 더 하려고 만든 세션이 미완료로 남았다고
     * 스트릭을 끊으면, 앱이 "더 하려는 시도"를 처벌한다(재평가 D-1 재현).
     * 같은 기반(-1·-2 완료, -3 휴식, -4·-5 완료)에 A/B/C 세 시나리오를 고정한다.
     */
    describe("휴식일 즉석 세션 (D-1)", () => {
      async function streakBase(): Promise<string> {
        const programId = await createProgram(USER_ID);
        for (const offset of [-1, -2, -4, -5]) {
          await seedSession(programId, utcDay(offset), "upper", "completed");
        }
        return programId;
      }

      it("A) 휴식일에 아무것도 안 하면 스트릭이 이어진다", async () => {
        await streakBase();

        expect((await dashboard()).streak_days).toBe(4);
      });

      it("B) 휴식일에 즉석 세션을 만들고 완료하지 않아도 스트릭이 줄지 않는다", async () => {
        const programId = await streakBase();
        await seedSession(programId, utcDay(-3), "chest", "scheduled", [], "ad_hoc");

        expect((await dashboard()).streak_days).toBe(4);
      });

      it("C) 휴식일 즉석 세션을 완료하면 스트릭이 하루 늘어난다", async () => {
        const programId = await streakBase();
        await seedSession(programId, utcDay(-3), "chest", "completed", [], "ad_hoc");

        expect((await dashboard()).streak_days).toBe(5);
      });
    });
  });

  it("weekly_completion_rate = 이번 주 완료 세션 / 이번 주 예정 세션", async () => {
    const programId = await createProgram(USER_ID);
    const monday = mondayOfThisWeek();
    for (const [index, status] of (
      ["completed", "completed", "scheduled", "scheduled"] as SessionStatus[]
    ).entries()) {
      await seedSession(programId, new Date(monday.getTime() + index * DAY_MS), "upper", status);
    }
    // 지난주 세션은 이번 주 분모에 들어가지 않는다.
    await seedSession(programId, new Date(monday.getTime() - 3 * DAY_MS), "upper", "scheduled");

    expect((await dashboard()).weekly_completion_rate).toBe(0.5);
  });

  /**
   * weekly_completion_rate = **계획 준수율**이다. 즉석 세션은 계획이 아니므로 분모에도 분자에도
   * 들어가지 않는다 — 분모만 늘면 즉석 세션을 만든 것 자체가 지표를 깎고(이중 처벌, D-1),
   * 분자에 넣으면 계획을 다 지킨 주에 100% 를 넘는다.
   */
  describe("즉석 세션과 weekly_completion_rate (D-1)", () => {
    /** 이번 주 계획: 월·화 완료, 수·목 미완료 = 0.5 */
    async function plannedWeek(): Promise<string> {
      const programId = await createProgram(USER_ID);
      const monday = mondayOfThisWeek();
      for (const [index, status] of (
        ["completed", "completed", "scheduled", "scheduled"] as SessionStatus[]
      ).entries()) {
        await seedSession(programId, new Date(monday.getTime() + index * DAY_MS), "upper", status);
      }
      return programId;
    }

    it("미완료 즉석 세션은 분모를 늘리지 않는다", async () => {
      const programId = await plannedWeek();
      const monday = mondayOfThisWeek();
      await seedSession(
        programId,
        new Date(monday.getTime() + 4 * DAY_MS),
        "chest",
        "scheduled",
        [],
        "ad_hoc",
      );

      expect((await dashboard()).weekly_completion_rate).toBe(0.5);
    });

    it("완료한 즉석 세션도 계획 준수율을 부풀리지 않는다", async () => {
      const programId = await plannedWeek();
      const monday = mondayOfThisWeek();
      await seedSession(
        programId,
        new Date(monday.getTime() + 5 * DAY_MS),
        "core",
        "completed",
        [],
        "ad_hoc",
      );

      expect((await dashboard()).weekly_completion_rate).toBe(0.5);
    });
  });

  /**
   * 테넌시: 남의 프로그램/세션/수행기록이 내 대시보드에 한 톨도 섞이면 안 된다.
   * 남의 프로그램을 **내 것보다 나중에** 만들어, "최신 프로그램" 조회에서 user_id 술어가 빠지면
   * 곧바로 남의 오늘 세션이 잡히게 해 뒀다.
   */
  it("다른 사용자의 프로그램·세션·기록은 집계에 섞이지 않는다", async () => {
    const myProgramId = await createProgram(USER_ID);
    await seedSession(myProgramId, utcDay(-7), "upper", "completed", [
      { exerciseId: "e_bench_press", sets: 1, performed: [{ weight: 60, reps: 10 }] },
    ]);
    const mySessionId = await seedSession(myProgramId, utcDay(0), "upper", "completed", [
      { exerciseId: "e_bench_press", sets: 1, performed: [{ weight: 70, reps: 10 }] },
    ]);

    const otherProgramId = await seedOtherUser();
    // 남의 오늘 세션(미완료·다른 focus·운동 5개) + 남의 이번 주 미완료 세션 + 남의 연속 완료일
    await seedSession(otherProgramId, utcDay(0), "legs", "scheduled", [
      { exerciseId: "e_back_squat", sets: 3 },
      { exerciseId: "e_leg_press", sets: 3 },
      { exerciseId: "e_leg_curl", sets: 3 },
      { exerciseId: "e_leg_extension", sets: 3 },
      { exerciseId: "e_calf_raise", sets: 3 },
    ]);
    await seedSession(otherProgramId, utcDay(1), "push", "scheduled", [
      { exerciseId: "e_bench_press", sets: 3 },
    ]);
    await seedSession(otherProgramId, utcDay(-1), "pull", "completed");
    await seedSession(otherProgramId, utcDay(-2), "push", "completed");
    // 남의 압도적인 벤치 기록(e1RM 266) — 내 PR 판정에 새어 들어오면 pr_count 가 0 이 된다.
    await seedSession(otherProgramId, utcDay(-3), "push", "completed", [
      { exerciseId: "e_bench_press", sets: 1, performed: [{ weight: 200, reps: 10 }] },
    ]);

    const body = await dashboard();

    expect(body.today).toEqual({
      status: "done",
      session_id: mySessionId,
      routine_summary: { exercise_count: 1, focus: "upper" },
      done_summary: { total_volume: 700, sets_completed: 1, pr_count: 1 },
    });
    // 내 프로그램엔 내일 세션이 없다(남의 내일 세션이 보이면 안 된다).
    expect(body.tomorrow).toEqual({ status: "rest", routine_summary: null });
    // 오늘 완료 + 7일 전 완료(사이는 계획 없는 휴식일) = 2. 남의 어제·그제 완료는 포함되지 않는다.
    expect(body.streak_days).toBe(2);
    // 이번 주 내 세션은 오늘 1개(완료) 뿐이다. 남의 이번 주 미완료 세션이 섞이면 1 미만이 된다.
    expect(body.weekly_completion_rate).toBe(1);
  });
});
