/**
 * 통합 테스트(실제 postgres): 맨몸(자체중량)·시간 종목의 폐루프 E2E.
 *
 * 프로그램 생성(맨몸만) → 세트 기록 → 세션 완료 → 다음 세션 계획세트가
 * REPS_UP_BODYWEIGHT / SUBSTITUTE_TOO_HARD_BODYWEIGHT / TIME_* 로 갱신되는지 고정한다.
 * 계산은 전부 packages/shared 의 recommendNextSet 이 한다(api 는 조립·저장만).
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
/** 맨몸·시간 진행축을 격리하기 위해 세 대표 종목만 허용하는 제어 fixture. */
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 3,
  minutes_per_day: 60,
  experience_level: "intermediate",
  equipment: ["bodyweight"],
} as const;

const COMPLETE_PATH = "/sessions/{sessionId}/complete";

interface Performed {
  reps?: number;
  timeSec?: number;
}

describe("맨몸·시간 종목 E2E", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function controlledProgram() {
    const keep = new Set(["e_dips", "e_plank"]);
    const avoid_exercises = (
      await prisma.exercise.findMany({
        where: { equipment: "bodyweight" },
        select: { id: true },
      })
    )
      .map((exercise) => exercise.id)
      .filter((id) => !keep.has(id));
    return { ...PROGRAM, avoid_exercises };
  }

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
    await request(app.getHttpServer())
      .post("/v1/programs/generate")
      .send(await controlledProgram())
      .expect(201);
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  });

  async function sessions() {
    return prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
      include: { plannedSets: { orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }] } },
    });
  }

  /** 맨몸은 무게가 없고(null), 시간 종목은 유지 시간만 기록한다. */
  async function recordSets(
    sessionId: string,
    exerciseId: string,
    performed: Performed[],
  ): Promise<void> {
    const planned = await prisma.plannedSet.findMany({
      where: { sessionId, exerciseId },
      orderBy: { setNo: "asc" },
    });
    for (const [index, set] of performed.entries()) {
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned[index].id,
          actualWeight: null,
          actualReps: set.reps ?? null,
          actualRir: null,
          actualTimeSec: set.timeSec ?? null,
          painScore: null,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(),
        },
      });
    }
  }

  async function complete(sessionId: string) {
    const response = await request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/complete`)
      .send({})
      .expect(200);
    expectMatchesContract("post", COMPLETE_PATH, 200, response.body);
    return response.body as {
      next_recommendations: {
        exercise_id: string;
        sample_session_count: number;
        gate_state: "no_history" | "early" | "ready";
        recommendation: null | {
          weight: number | null;
          reps_low: number | null;
          reps_high: number | null;
          time_low_sec?: number;
          time_high_sec?: number;
          reason_code: string;
          explanation: string;
        };
      }[];
    };
  }

  it("제어 fixture의 e_dips·e_plank가 모두 배정되고 수준 초과 종목은 제외된다", async () => {
    const [first] = await sessions();

    expect(new Set(first.plannedSets.map((set) => set.exerciseId))).toEqual(
      new Set(["e_dips", "e_plank"]),
    );
  });

  it("맨몸: 목표 상단 달성 → REPS_UP_BODYWEIGHT 로 다음 세션 목표 반복 상단이 올라간다", async () => {
    const [first, second] = await sessions();
    // 근비대 복합 목표 6~12 → 세 세트 모두 상단 도달
    await recordSets(first.id, "e_dips", [{ reps: 12 }, { reps: 12 }, { reps: 12 }]);

    const body = await complete(first.id);

    const dips = body.next_recommendations.find((item) => item.exercise_id === "e_dips")!;
    expect(dips).toMatchObject({
      sample_session_count: 1,
      gate_state: "early",
      recommendation: {
        reason_code: "REPS_UP_BODYWEIGHT",
        weight: null,
        recommendation_state: "ready",
        confidence: null,
      },
    });

    const next = await prisma.plannedSet.findMany({
      where: { sessionId: second.id, exerciseId: "e_dips" },
    });
    expect(next).toHaveLength(3);
    for (const set of next) {
      expect(set.reasonCode).toBe("REPS_UP_BODYWEIGHT");
      expect(set.recommendedWeight).toBeNull();
      expect(set.targetRepsHigh).toBe(13);
      expect(set.rulesVersion).toBe("2026.08.1");
    }
  });

  it("맨몸: 하단에 크게 미달 → SUBSTITUTE_TOO_HARD_BODYWEIGHT (무한 하향 대신 대체 제안)", async () => {
    const [first, second] = await sessions();
    await recordSets(first.id, "e_dips", [{ reps: 2 }, { reps: 1 }]);

    const body = await complete(first.id);

    expect(body.next_recommendations.find((item) => item.exercise_id === "e_dips")).toMatchObject({
      gate_state: "early",
      recommendation: {
        reason_code: "SUBSTITUTE_TOO_HARD_BODYWEIGHT",
        weight: null,
        recommendation_state: "ready",
        confidence: null,
      },
    });
    const next = await prisma.plannedSet.findFirstOrThrow({
      where: { sessionId: second.id, exerciseId: "e_dips" },
    });
    expect(next.reasonCode).toBe("SUBSTITUTE_TOO_HARD_BODYWEIGHT");
    expect(next.recommendedWeight).toBeNull();
  });

  it("시간: 모든 세트가 상단 도달 → TIME_UP 으로 목표 유지 시간이 늘어난다", async () => {
    const [first, second] = await sessions();
    // 시드 e_plank 목표 20~60초 → 상단(60) 이상이면 +10초
    await recordSets(first.id, "e_plank", [{ timeSec: 60 }, { timeSec: 65 }, { timeSec: 60 }]);

    const body = await complete(first.id);

    expect(body.next_recommendations.find((item) => item.exercise_id === "e_plank")).toMatchObject({
      gate_state: "early",
      recommendation: {
        reason_code: "TIME_UP",
        weight: null,
        recommendation_state: "ready",
        confidence: null,
      },
    });

    const next = await prisma.plannedSet.findMany({
      where: { sessionId: second.id, exerciseId: "e_plank" },
    });
    for (const set of next) {
      expect(set.reasonCode).toBe("TIME_UP");
      expect(set.targetTimeLowSec).toBe(20);
      expect(set.targetTimeHighSec).toBe(70);
      expect(set.recommendedWeight).toBeNull();
      expect(set.recommendedReps).toBeNull();
    }
  });

  it("시간: 범위 안이면 TIME_HOLD, 하단의 절반에도 못 미치면 TIME_DOWN", async () => {
    const [first, second, third] = await sessions();
    await recordSets(first.id, "e_plank", [{ timeSec: 35 }, { timeSec: 40 }]);

    const hold = await complete(first.id);
    expect(hold.next_recommendations[0]).toMatchObject({
      gate_state: "early",
      recommendation: {
        reason_code: "TIME_HOLD",
        weight: null,
        recommendation_state: "ready",
        confidence: null,
      },
    });
    const held = await prisma.plannedSet.findFirstOrThrow({
      where: { sessionId: second.id, exerciseId: "e_plank" },
    });
    expect(held).toMatchObject({
      reasonCode: "TIME_HOLD",
      targetTimeLowSec: 20,
      targetTimeHighSec: 60,
    });

    // 다음 세션에서 5초(하단 20 의 절반 미만) → 하향
    await recordSets(second.id, "e_plank", [{ timeSec: 5 }]);
    const down = await complete(second.id);
    expect(down.next_recommendations[0]).toMatchObject({
      gate_state: "early",
      recommendation: {
        reason_code: "TIME_DOWN",
        weight: null,
        recommendation_state: "ready",
        confidence: null,
      },
    });
    const lowered = await prisma.plannedSet.findFirstOrThrow({
      where: { sessionId: third.id, exerciseId: "e_plank" },
    });
    expect(lowered).toMatchObject({
      reasonCode: "TIME_DOWN",
      targetTimeLowSec: 10,
      targetTimeHighSec: 50,
    });
  });

  /**
   * 맨몸·시간은 "목표 범위 자체"가 움직인다 → 아웃박스 재전송(재완료)이 두 번 진행하면 안 된다.
   * (엔진 입력 목표를 다음 세션이 아니라 방금 수행한 세션에서 읽는 이유)
   */
  it("재완료해도 목표가 두 번 올라가지 않는다", async () => {
    const [first, second] = await sessions();
    await recordSets(first.id, "e_dips", [{ reps: 12 }, { reps: 12 }, { reps: 12 }]);
    await recordSets(first.id, "e_plank", [{ timeSec: 60 }, { timeSec: 60 }]);

    await complete(first.id);
    await complete(first.id);

    const dips = await prisma.plannedSet.findMany({
      where: { sessionId: second.id, exerciseId: "e_dips" },
    });
    for (const set of dips) expect(set.targetRepsHigh).toBe(13);
    const plank = await prisma.plannedSet.findMany({
      where: { sessionId: second.id, exerciseId: "e_plank" },
    });
    for (const set of plank) expect(set.targetTimeHighSec).toBe(70);
  });

  it("GET /sessions/{id} 응답이 맨몸·시간 종목을 계약대로 표현한다", async () => {
    const [first] = await sessions();

    const response = await request(app.getHttpServer()).get(`/v1/sessions/${first.id}`).expect(200);

    expectMatchesContract("get", "/sessions/{sessionId}", 200, response.body);
    const plank = response.body.planned_sets.find(
      (set: { exercise_id: string }) => set.exercise_id === "e_plank",
    );
    expect(plank).toMatchObject({
      target_reps_low: null,
      target_reps_high: null,
      target_rir: null,
      target_time_low_sec: 20,
      target_time_high_sec: 60,
      recommended_weight: null,
      recommended_reps: null,
    });
    const dips = response.body.planned_sets.find(
      (set: { exercise_id: string }) => set.exercise_id === "e_dips",
    );
    expect(dips).toMatchObject({
      target_reps_low: 6,
      target_reps_high: 12,
      recommended_weight: null,
      recommended_reps: 6,
      recommendation_gate: "no_history",
    });
  });
});
