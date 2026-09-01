/**
 * F-3 fixup — 어시스트 행에 `2026.08.1` 엔진 출력이 닿는 경로를 전부 막는다(독립 review P1-1).
 *
 * `.08.1` bundle 은 도움 kg 의 의미를 모른다 — `-2.5kg 도움`을 `2.5kg 부하`로 읽는다.
 * 그 출력을 어시스트 행에 저장하면 provenance 가 거짓말이 되고, 뒤따르는 safe predicate·
 * lifetime history·analytics 가 전부 오염된다.
 *
 * 쓰기 경로는 둘이다: **factory**(생성·추가·교체)와 **F6-1 recompute**(세션 종료 후 갱신).
 * 둘 중 하나만 막으면 다른 하나가 되돌려 쓴다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const COMPLETE_PATH = "/sessions/{sessionId}/complete";
const USER_ID = devUserId();

type NextRecommendation = {
  exercise_id: string;
  gate_state: "no_history" | "early" | "ready";
  recommendation: Record<string, unknown> | null;
};
const ASSISTED = "e_assisted_pullup";
const EXTERNAL = "e_face_pull";
const PROGRAM = {
  goal: "hypertrophy",
  days_per_week: 4,
  minutes_per_day: 60,
  experience_level: "intermediate",
} as const;

describe("어시스트 쓰기 경로 fail-safe", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
    await request(app.getHttpServer()).post("/v1/programs/generate").send(PROGRAM).expect(201);
    // 세션은 현재 창을 조회할 때 만들어진다(ensureCurrentWindow).
    await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
  });

  async function sessions() {
    return prisma.workoutSession.findMany({
      where: { program: { userId: USER_ID } },
      orderBy: { scheduledDate: "asc" },
    });
  }

  /** 세션에 없으면 추가한다. 이미 있으면 그대로 둔다. */
  async function ensureExercise(sessionId: string, exerciseId: string): Promise<void> {
    const existing = await prisma.plannedSet.count({ where: { sessionId, exerciseId } });
    if (existing > 0) return;
    await request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/exercises`)
      .send({ exercise_id: exerciseId })
      .expect(200);
  }

  async function recordSets(sessionId: string, exerciseId: string): Promise<void> {
    const planned = await prisma.plannedSet.findMany({
      where: { sessionId, exerciseId },
      orderBy: { setNo: "asc" },
    });
    for (const set of planned) {
      await prisma.performedSet.create({
        data: {
          plannedSetId: set.id,
          actualWeight: "20",
          actualReps: set.targetRepsHigh ?? 10,
          actualRir: 2,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date("2026-08-14T10:00:00.000Z"),
        },
      });
    }
  }

  describe("factory (생성 · 추가 · 교체)", () => {
    it("어시스트 행은 .08.2/native + 무게 미정 + calibration 으로 저장된다", async () => {
      const [first] = await sessions();
      await ensureExercise(first.id, ASSISTED);

      const rows = await prisma.plannedSet.findMany({
        where: { sessionId: first.id, exerciseId: ASSISTED },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.rulesVersion).toBe("2026.08.2");
        expect(row.assistanceProvenance).toBe("native");
        expect(row.loadSemantics).toBe("assistance");
        expect(row.assistanceStepKg).not.toBeNull();
        // 이력이 없으면 캘리브레이션이다 — 기계별 시작 도움 kg 을 발명하지 않는다(GC-43).
        // **0kg sentinel 이 아니라 null** 이다: 어시스트에서 0 은 "도움 0(맨몸)"이라 위험한 값이다.
        expect(row.recommendedWeight).toBeNull();
        expect(row.reasonCode).toBe("ASSISTANCE_CALIBRATION_NEEDED");
        expect(Number(row.confidence)).toBe(0);
      }
    });

    it("유효한 양수 도움 이력이 있으면 실제 어시스트 처방이 저장된다", async () => {
      const [first, second] = await sessions();
      await ensureExercise(first.id, ASSISTED);
      await ensureExercise(second.id, ASSISTED);
      // 목표 반복 상단을 채운 유효 관측 → graduation. 다음 처방은 **도움을 줄인다**.
      await recordSets(first.id, ASSISTED);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${first.id}/complete`)
        .send({})
        .expect(200);

      const rows = await prisma.plannedSet.findMany({
        where: { sessionId: second.id, exerciseId: ASSISTED },
        orderBy: { setNo: "asc" },
      });
      for (const row of rows) {
        expect(row.reasonCode).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
        // 도움은 양수로만 저장한다. 0·음수는 만들지 않는다.
        expect(Number(row.recommendedWeight)).toBeGreaterThan(0);
        // generic 가중 진행 문구가 어시스트 행에 실리면 방향이 정반대가 된다.
        expect(row.reasonCode.startsWith("ASSISTANCE_")).toBe(true);
        expect(row.rulesVersion).toBe("2026.08.2");
      }
      // 20kg 도움에서 한 스텝(2.5) 줄었다 — 목표를 채웠으므로 더 어려워진다.
      expect(Number(rows[0].recommendedWeight)).toBeLessThan(20);
    });

    it("어떤 경로로도 .08.1/native 어시스트 행이 생기지 않는다", async () => {
      const [first, second] = await sessions();
      await ensureExercise(first.id, ASSISTED);
      await ensureExercise(second.id, ASSISTED);
      await request(app.getHttpServer())
        .post(`/v1/sessions/${second.id}/exercises/${ASSISTED}/swap`)
        .send({ to_exercise_id: ASSISTED })
        .expect(200);

      const offending = await prisma.plannedSet.count({
        where: {
          session: { program: { userId: USER_ID } },
          loadSemantics: "assistance",
          rulesVersion: "2026.08.1",
        },
      });
      expect(offending).toBe(0);
    });

    it("non-assisted 행은 활성 bundle(.08.1)과 엔진 출력을 그대로 쓴다", async () => {
      const [first] = await sessions();
      await ensureExercise(first.id, EXTERNAL);

      const row = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: first.id, exerciseId: EXTERNAL },
      });
      expect(row.rulesVersion).toBe("2026.08.1");
      expect(row.loadSemantics).toBe("external_load");
      expect(row.assistanceProvenance).toBeNull();
      expect(row.reasonCode).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
    });
  });

  describe("P1 — 엔진 입력은 target snapshot 이 원천이다", () => {
    /** 완료 세션 + 다음 세션을 직접 심는다. 다음 세션 행의 snapshot 을 마음대로 정하기 위해서다. */
    async function seedPair(next: {
      stepKg: string | null;
      rulesVersion: string;
      /** 계획 행에 굳는 값. 카탈로그와 **일부러 다르게** 둘 수 있다. */
      exerciseId?: string;
      loadSemantics?: "assistance" | "external_load";
    }): Promise<{ doneId: string; upcomingId: string }> {
      const program = await prisma.program.create({
        data: {
          userId: USER_ID,
          goal: "hypertrophy",
          daysPerWeek: 3,
          minutesPerDay: 60,
          splitType: "full_body",
          rulesVersion: "2026.08.1",
          startedAt: new Date("2026-08-03T00:00:00Z"),
          totalWeeks: 12,
          status: "active",
          generationInput: {},
          template: [],
          excludedExercises: [],
        },
      });
      const semantics = next.loadSemantics ?? "assistance";
      const assisted = semantics === "assistance";
      const common = {
        exerciseId: next.exerciseId ?? ASSISTED,
        orderIndex: 0,
        setNo: 1,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRir: 2,
        restSec: 90,
        recommendedReps: 8,
        reasonCode: assisted ? "ASSISTANCE_DOWN_REP_TARGET_MET" : "WEIGHT_UP_REP_TARGET_MET",
        confidence: "0.85",
        loadSemantics: semantics,
        // 어시스트가 아닌 행은 provenance·step 이 null 이어야 한다(version matrix 제약).
        assistanceProvenance: assisted ? ("native" as const) : null,
      };
      const done = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date(Date.UTC(2026, 7, 3)),
          focus: "full_body",
          status: "scheduled",
        },
      });
      const donePlanned = await prisma.plannedSet.create({
        data: {
          ...common,
          sessionId: done.id,
          recommendedWeight: "20",
          rulesVersion: next.rulesVersion,
          assistanceStepKg: next.stepKg,
        },
      });
      await prisma.performedSet.create({
        data: {
          plannedSetId: donePlanned.id,
          actualWeight: "20",
          actualReps: 12,
          actualRir: 2,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(Date.UTC(2026, 7, 3, 10)),
        },
      });
      const upcoming = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date(Date.UTC(2026, 7, 5)),
          focus: "full_body",
          status: "scheduled",
        },
      });
      await prisma.plannedSet.create({
        data: {
          ...common,
          sessionId: upcoming.id,
          recommendedWeight: "20",
          rulesVersion: next.rulesVersion,
          assistanceStepKg: next.stepKg,
        },
      });
      return { doneId: done.id, upcomingId: upcoming.id };
    }

    it("snapshot step 5.0 을 쓴다 — 카탈로그 2.5 로 재구성하지 않는다", async () => {
      // **공유 카탈로그를 건드리지 않는다.** 바꾸면 병렬로 도는 다른 스위트가 깨진다(실측).
      // snapshot 만 카탈로그와 다르게 두면 어느 쪽을 썼는지 결과로 갈린다.
      const { doneId, upcomingId } = await seedPair({ stepKg: "5.00", rulesVersion: "2026.08.2" });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${doneId}/complete`)
        .send({})
        .expect(200);

      const row = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: upcomingId },
      });
      // 20 에서 한 스텝 줄이면 snapshot(5.0) 기준 **15**, 카탈로그(2.5) 기준이면 17.5 다.
      expect(Number(row.recommendedWeight)).toBe(15);
    });

    /**
     * **카탈로그 semantics 는 저장 뒤에 바뀔 수 있다.** 그래서 recompute 는 카탈로그가 아니라
     * 대상 행의 snapshot semantics 를 엔진에 넘긴다. 두 방향 모두 밟지 않으면
     * "우연히 카탈로그와 같아서" 통과하는 fixture 가 된다.
     *
     * 공유 카탈로그는 건드리지 않는다(병렬 스위트가 깨진다) — **계획 행 쪽을** 카탈로그와 다르게 둔다.
     */
    it("카탈로그가 external 이어도 snapshot 이 assistance 면 어시스트로 계산한다", async () => {
      const { doneId, upcomingId } = await seedPair({
        stepKg: "2.50",
        rulesVersion: "2026.08.2",
        exerciseId: EXTERNAL, // 카탈로그는 external_load 다
        loadSemantics: "assistance", // 굳은 행은 assistance 다
      });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${doneId}/complete`)
        .send({})
        .expect(200);

      const row = await prisma.plannedSet.findFirstOrThrow({ where: { sessionId: upcomingId } });
      // 카탈로그를 따랐다면 `.08.1` 과 generic 가중 처방이 된다 — 도움 kg 을 부하로 읽는 그 사고다.
      expect(row.rulesVersion).toBe("2026.08.2");
      expect(row.reasonCode.startsWith("ASSISTANCE_")).toBe(true);
      expect(Number(row.recommendedWeight)).toBe(17.5);
    });

    it("카탈로그가 assistance 여도 snapshot 이 external 이면 일반 부하로 계산한다", async () => {
      const { doneId, upcomingId } = await seedPair({
        stepKg: null,
        rulesVersion: "2026.08.1",
        exerciseId: ASSISTED, // 카탈로그는 assistance 다
        loadSemantics: "external_load", // 굳은 행은 external_load 다
      });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${doneId}/complete`)
        .send({})
        .expect(200);

      const row = await prisma.plannedSet.findFirstOrThrow({ where: { sessionId: upcomingId } });
      // 카탈로그를 따랐다면 `.08.2` 로 올라가고 어시스트 처방이 실린다.
      expect(row.rulesVersion).toBe("2026.08.1");
      expect(row.reasonCode.startsWith("ASSISTANCE_")).toBe(false);
      expect(row.assistanceProvenance).toBeNull();
    });

    it.each([["2026.09.0"], ["2026.09.1"]])("target %s bundle 을 보존한다", async (version) => {
      const { doneId, upcomingId } = await seedPair({ stepKg: "2.50", rulesVersion: version });
      await request(app.getHttpServer())
        .post(`/v1/sessions/${doneId}/complete`)
        .send({})
        .expect(200);

      const row = await prisma.plannedSet.findFirstOrThrow({
        where: { sessionId: upcomingId },
      });
      // 전역 포인터(.08.1)로 재구성하면 .08.2 로 강등된다.
      expect(row.rulesVersion).toBe(version);
    });
  });

  describe("F6-1 recompute", () => {
    /**
     * F-3 의 임시 제외를 F-4a 가 되돌려 받았다. 이제 어시스트 행도 **실제 mapper 결과**로 갱신된다.
     * 이 단언이 "변하지 않는다"였던 것이 F-3 의 임시 경계였다.
     */
    it("어시스트 행이 실제 mapper 결과로 갱신된다", async () => {
      const [first, second] = await sessions();
      await ensureExercise(first.id, ASSISTED);
      await ensureExercise(second.id, ASSISTED);
      await recordSets(first.id, ASSISTED);

      const before = await prisma.plannedSet.findMany({
        where: { sessionId: second.id, exerciseId: ASSISTED },
        orderBy: { setNo: "asc" },
      });
      expect(before.length).toBeGreaterThan(0);
      expect(before[0].reasonCode).toBe("ASSISTANCE_CALIBRATION_NEEDED");

      await request(app.getHttpServer())
        .post(`/v1/sessions/${first.id}/complete`)
        .send({})
        .expect(200);

      const after = await prisma.plannedSet.findMany({
        where: { sessionId: second.id, exerciseId: ASSISTED },
        orderBy: { setNo: "asc" },
      });
      expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
      expect(after[0].reasonCode.startsWith("ASSISTANCE_")).toBe(true);
      expect(after[0].reasonCode).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
      expect(Number(after[0].recommendedWeight)).toBeGreaterThan(0);
      // 어시스트 행은 assistance-capable bundle 을 유지한다 — `.08.1` 로 되돌아가지 않는다.
      expect(after[0].rulesVersion).toBe("2026.08.2");
    });

    /**
     * 표시 게이트(D-39)가 세 번의 완료 세션을 요구한다 — 그전에는 `recommendation` 이 null 이라
     * 응답 drift 자체가 관측되지 않는다. 네 세션에 종목을 심고 셋을 완료해 게이트를 연다.
     */
    async function completeUntilGateOpens(exerciseId: string): Promise<{
      body: { next_recommendations: NextRecommendation[] };
      nextSessionId: string;
    }> {
      const all = await sessions();
      const scoped = all.slice(0, 4);
      for (const session of scoped) await ensureExercise(session.id, exerciseId);

      let body: { next_recommendations: NextRecommendation[] } | undefined;
      for (const session of scoped.slice(0, 3)) {
        await recordSets(session.id, exerciseId);
        const response = await request(app.getHttpServer())
          .post(`/v1/sessions/${session.id}/complete`)
          .send({})
          .expect(200);
        expectMatchesContract("post", COMPLETE_PATH, 200, response.body);
        body = response.body;
      }
      return { body: body!, nextSessionId: scoped[3].id };
    }

    it("종료 응답의 어시스트 item 이 저장 row 와 정확히 일치한다", async () => {
      const { body, nextSessionId } = await completeUntilGateOpens(ASSISTED);

      const item = body.next_recommendations.find((entry) => entry.exercise_id === ASSISTED);
      expect(item?.gate_state).toBe("ready");
      expect(item?.recommendation).not.toBeNull();

      const stored = await prisma.plannedSet.findMany({
        where: { sessionId: nextSessionId, exerciseId: ASSISTED },
        orderBy: { setNo: "asc" },
      });
      expect(stored.length).toBeGreaterThan(0);

      // 응답이 저장값과 어긋나면 사용자는 도움 kg 을 부하로 읽는다.
      // 이제 둘 다 **같은 mapper 결과 하나**에서 나온다 — 값 복사가 아니라 동일 출처다.
      expect(item!.recommendation).toMatchObject({
        load_kind: "assistance",
        rules_version: "2026.08.2",
        sets: stored.length,
      });
      expect(item!.recommendation!.rules_version).toBe(stored[0].rulesVersion);
      expect(item!.recommendation!.reason_code).toBe(stored[0].reasonCode);
      expect(item!.recommendation!.weight).toBe(
        stored[0].recommendedWeight === null ? null : Number(stored[0].recommendedWeight),
      );
      expect(item!.recommendation!.confidence).toBe(Number(stored[0].confidence));
      // 어시스트 진행 처방이지 generic 가중 처방이 아니다.
      expect(String(item!.recommendation!.reason_code).startsWith("ASSISTANCE_")).toBe(true);
      expect(Number(item!.recommendation!.weight)).toBeGreaterThan(0);
      // 안전 상태가 아니므로 action 은 최소 경계에서만 나온다 — 여기서는 null 이다.
      expect(item!.recommendation!.recommended_action).toBeNull();
    });

    it("non-assisted item 은 엔진 결과 그대로다 — 어시스트 분기가 새지 않는다", async () => {
      const { body } = await completeUntilGateOpens(EXTERNAL);

      const item = body.next_recommendations.find((entry) => entry.exercise_id === EXTERNAL);
      expect(item?.recommendation).not.toBeNull();
      expect(item!.recommendation).toMatchObject({ rules_version: "2026.08.1" });
      expect(item!.recommendation!.reason_code).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
    });

    it("non-assisted 행은 계속 갱신된다 — 전면 중단이 아니다(activation 경로 유지)", async () => {
      const [first, second] = await sessions();
      await ensureExercise(first.id, EXTERNAL);
      await ensureExercise(second.id, EXTERNAL);
      await recordSets(first.id, EXTERNAL);

      const before = await prisma.plannedSet.findMany({
        where: { sessionId: second.id, exerciseId: EXTERNAL },
        orderBy: { setNo: "asc" },
      });

      await request(app.getHttpServer())
        .post(`/v1/sessions/${first.id}/complete`)
        .send({})
        .expect(200);

      const after = await prisma.plannedSet.findMany({
        where: { sessionId: second.id, exerciseId: EXTERNAL },
        orderBy: { setNo: "asc" },
      });
      // 갱신 자체가 일어났다는 것을 관측한다. 값이 같으면 제외 여부를 구분할 수 없다.
      expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
      expect(after[0].rulesVersion).toBe("2026.08.1");
    });
  });
});
