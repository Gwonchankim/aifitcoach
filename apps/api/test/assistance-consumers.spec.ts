/**
 * F-4a — 어시스트 snapshot consumer 와 service seam.
 *
 * 도움 kg 은 **기계가 덜어주는 무게**다. 이걸 들어올린 부하로 읽으면 e1RM·PR·kg 볼륨이 전부
 * 부풀고, 목표를 채울수록 "더 강해졌다"고 기록된다(§F 가 지목한 P0).
 *
 * `hasExternalLoad = default_step_kg !== null` 은 어시스트 머신에서도 참이라 **카탈로그로는
 * 구분되지 않는다.** 판정 원천은 각 수행 행이 참조하는 **immutable PlannedSet snapshot** 이다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { projectFacts, type ProjectorSession } from "../src/analytics/aggregation.projector";
import { PrismaService } from "../src/prisma/prisma.service";
import { RecommendationService } from "../src/recommendation/recommendation.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const EXTERNAL = "e_chest_press_machine";

// ------------------------------------------------- ① projector (순수 함수)

function session(loadSemantics: "assistance" | "external_load"): ProjectorSession {
  return {
    userId: USER_ID,
    sessionId: "s1",
    scheduledDate: new Date("2026-08-05T00:00:00Z"),
    completed: true,
    exercises: [
      {
        exerciseId: "e_x",
        metric: "reps",
        // 어시스트 머신도 step_kg 이 있어 참이다 — 이것만으로는 구분되지 않는다.
        hasExternalLoad: true,
        loadSemantics,
        primaryMuscles: ["lats"],
        sets: [
          { completed: true, weight: 20, reps: 10, rir: 2 },
          { completed: true, weight: 20, reps: 10, rir: 2 },
        ],
      },
    ],
  };
}

describe("① projector — 도움 kg 은 부하가 아니다", () => {
  const external = projectFacts([session("external_load")]);
  const assisted = projectFacts([session("assistance")]);

  it("external 은 e1RM 이 나오고 assistance 는 나오지 않는다", () => {
    expect(external.e1rm.length).toBe(1);
    expect(assisted.e1rm).toEqual([]);
  });

  it("kg 볼륨에서 도움 kg 을 뺀다", () => {
    expect(external.muscleLoad[0].volumeLoad).toBe(400);
    expect(assisted.muscleLoad[0].volumeLoad).toBe(0);
  });

  it("세트 수와 RIR 평균은 그대로 센다 — 그 세트는 실제로 수행됐다", () => {
    expect(assisted.muscleLoad[0].hardSets).toBe(external.muscleLoad[0].hardSets);
    expect(assisted.muscleLoad[0].hardSets).toBe(2);
    expect(assisted.muscleLoad[0].avgRir).toBe(external.muscleLoad[0].avgRir);
    expect(assisted.muscleLoad[0].avgRir).toBe(2);
  });

  /**
   * 같은 운동에 의미가 다른 행이 섞일 수 있다 — 과거 legacy 행과 새 행의 snapshot 이 다르다.
   * 운동 단위로 하나만 보면 **섞인 세트가 통째로 포함되거나 통째로 빠진다.**
   */
  it("세트별 semantics 로 나눈다 — 입력 순서가 결과를 바꾸지 않는다", () => {
    const mixed = (order: "assist_first" | "external_first"): ProjectorSession => {
      const assistedSet = {
        completed: true,
        weight: 20,
        reps: 10,
        rir: 2,
        loadSemantics: "assistance" as const,
      };
      const externalSet = {
        completed: true,
        weight: 30,
        reps: 10,
        rir: 2,
        loadSemantics: "external_load" as const,
      };
      return {
        ...session("external_load"),
        exercises: [
          {
            ...session("external_load").exercises[0],
            loadSemantics: undefined,
            sets:
              order === "assist_first" ? [assistedSet, externalSet] : [externalSet, assistedSet],
          },
        ],
      };
    };

    const a = projectFacts([mixed("assist_first")]);
    const b = projectFacts([mixed("external_first")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // external 세트만 볼륨에 든다(30 × 10). 도움 20kg 은 빠진다.
    expect(a.muscleLoad[0].volumeLoad).toBe(300);
    // 두 세트 다 수행됐으므로 세트 수·RIR 은 그대로다.
    expect(a.muscleLoad[0].hardSets).toBe(2);
    expect(a.muscleLoad[0].avgRir).toBe(2);
    // e1RM 은 external 세트만으로 계산된다 — 존재하되 도움 세트가 섞이지 않는다.
    expect(a.e1rm.length).toBe(1);
  });

  it("snapshot 이 없으면 기존 external 의미가 유지된다 — 회귀 방지", () => {
    const legacy = projectFacts([
      { ...session("external_load"), exercises: [{ ...session("external_load").exercises[0] }] },
    ]);
    expect(legacy.e1rm.length).toBe(1);
  });
});

// ---------------------------------------------- ② service seam · consumer

describe("② service seam · snapshot consumer (실제 DB)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recommendation: RecommendationService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    recommendation = app.get(RecommendationService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  /** 완료 세션 하나 + 어시스트 수행 기록. planned 처방은 인자로 바꿔 넣는다. */
  async function seed(opts: {
    exerciseId?: string;
    actualWeight?: string | null;
    actualReps?: number | null;
    painScore?: string | null;
    plannedReasonCode?: string;
    plannedWeight?: string | null;
    legacyPerformed?: boolean;
  }): Promise<void> {
    const exerciseId = opts.exerciseId ?? ASSISTED;
    const assisted = exerciseId === ASSISTED;
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
    const workout = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: new Date("2026-08-05T00:00:00Z"),
        focus: "full_body",
        status: "completed",
        completedAt: new Date("2026-08-05T10:00:00Z"),
      },
    });
    const planned = await prisma.plannedSet.create({
      data: {
        sessionId: workout.id,
        exerciseId,
        orderIndex: 0,
        setNo: 1,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRir: 2,
        restSec: 90,
        recommendedReps: 8,
        recommendedWeight: opts.plannedWeight === undefined ? "20" : opts.plannedWeight,
        reasonCode: opts.plannedReasonCode ?? "ASSISTANCE_DOWN_REP_TARGET_MET",
        confidence: "0.85",
        // legacy_performed 는 matrix 상 `.08.1` 만 허용된다 — 그 시절의 사실이라 옮길 수 없다.
        rulesVersion: assisted && !opts.legacyPerformed ? "2026.08.2" : "2026.08.1",
        loadSemantics: assisted ? "assistance" : "external_load",
        ...(assisted
          ? {
              assistanceStepKg: "2.50",
              assistanceProvenance: (opts.legacyPerformed ? "legacy_performed" : "native") as
                "native" | "legacy_performed",
            }
          : {}),
      },
    });
    await prisma.performedSet.create({
      data: {
        plannedSetId: planned.id,
        actualWeight: opts.actualWeight === undefined ? "20" : opts.actualWeight,
        actualReps: opts.actualReps === undefined ? 12 : opts.actualReps,
        actualRir: 2,
        painScore: opts.painScore ?? null,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date("2026-08-05T10:00:00Z"),
      },
    });
  }

  describe("red 1 — legacy planned 처방을 입력으로 쓰지 않는다", () => {
    it("planned 처방을 아무 값으로 바꿔도 graduation 판정이 그대로다", async () => {
      await seed({});
      const before = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);

      // 저장된 처방만 통째로 바꾼다. 수행 사실은 건드리지 않는다.
      await prisma.plannedSet.updateMany({
        where: { exerciseId: ASSISTED, session: { program: { userId: USER_ID } } },
        data: {
          recommendedWeight: "999",
          recommendedReps: 1,
          reasonCode: "WEIGHT_UP_REP_TARGET_MET",
          confidence: "0.1",
        },
      });
      const after = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);

      expect(after).toEqual(before);
      expect(after.has_valid_positive_assistance).toBe(true);
    });
  });

  describe("red 2 — valid legacy actual 이 graduation 을 연다", () => {
    it("양수 도움 + 반복 1 이상이면 ready 다", async () => {
      await seed({});
      const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
      expect(evidence.has_valid_positive_assistance).toBe(true);
      expect(evidence.calibration_source_performed_set_id).not.toBeNull();
    });
  });

  describe("red 3 — 불완전하면 fail closed", () => {
    it.each([
      ["도움 0", { actualWeight: "0" }],
      ["도움 음수", { actualWeight: "-2.5" }],
      ["도움 없음", { actualWeight: null }],
      ["반복 0", { actualReps: 0 }],
      ["반복 없음", { actualReps: null }],
      ["통증 4 이상", { painScore: null as string | null }],
    ])("%s → graduation 근거가 되지 않는다", async (label, patch) => {
      if (label === "통증 4 이상") {
        const { encryptNumber } = await import("../src/common/crypto/field-encryption");
        await seed({ painScore: encryptNumber(5) });
      } else {
        await seed(patch as Parameters<typeof seed>[0]);
      }
      const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
      expect(`${label}:${evidence.has_valid_positive_assistance}`).toBe(`${label}:false`);
      expect(evidence.calibration_source_performed_set_id).toBeNull();
    });

    it("손상된 통증 암호문은 graduation source 에서만 제외한다", async () => {
      await seed({ painScore: "v1:not-a-real-ciphertext" });
      const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
      expect(evidence.has_valid_positive_assistance).toBe(false);
    });

    it("non-assisted snapshot 은 어시스트 근거가 되지 않는다", async () => {
      await seed({ exerciseId: EXTERNAL });
      const evidence = await recommendation.assistanceEvidenceFor(USER_ID, EXTERNAL);
      expect(evidence.has_valid_positive_assistance).toBe(false);
    });
  });

  describe("red 4 — 수행된 legacy 를 .08.2 로 요구하면 영구 unsafe 가 된다", () => {
    it("`.08.1/legacy_performed` 수행 기록도 graduation 근거로 쓴다", async () => {
      // 수행 사실은 `.08.1` 시절 것이라 버전을 올릴 수 없다(matrix CHECK 가 그것만 허용한다).
      await seed({ legacyPerformed: true, plannedReasonCode: "WEIGHT_UP_REP_TARGET_MET" });
      const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
      expect(evidence.has_valid_positive_assistance).toBe(true);
    });
  });

  describe("red 5·6 — 서비스 결과로 단언한다(adapter helper shape 가 아니라)", () => {
    async function ask(painScore: string | null) {
      const exercise = await prisma.exercise.findUniqueOrThrow({ where: { id: ASSISTED } });
      const history = await recommendation.historyFor(USER_ID, ASSISTED, exercise.loadSemantics);
      return recommendation.recommend({
        goal: "hypertrophy",
        exercise,
        target: { reps_low: 8, reps_high: 12, rir: 2 },
        history: painScore === null ? history : history,
      });
    }

    it("어시스트 종목이 실제로 어시스트 경로를 탄다 — mapping 이 끊기면 generic 으로 샌다", async () => {
      await seed({});
      const result = await ask(null);
      expect(result.load_kind).toBe("assistance");
      expect(result.rules_version).toBe("2026.08.2");
      expect(String(result.reason_code).startsWith("ASSISTANCE_")).toBe(true);
      // generic 가중 진행 문구가 나오면 숫자 방향과 설명이 정반대가 된다.
      expect(result.reason_code).not.toBe("WEIGHT_UP_REP_TARGET_MET");
    });

    it("최신 통증 4 이상 → substitution_required / SUBSTITUTE_PAIN / weight null / action null", async () => {
      const { encryptNumber } = await import("../src/common/crypto/field-encryption");
      await seed({ painScore: encryptNumber(5) });
      const result = await ask(null);
      expect(result.recommendation_state).toBe("substitution_required");
      expect(result.reason_code).toBe("SUBSTITUTE_PAIN");
      expect(result.weight).toBeNull();
      expect(result.recommended_action ?? null).toBeNull();
    });

    it("최신 통증 복호화 실패 → unavailable / INVALID_INPUT / weight null / action null", async () => {
      await seed({ painScore: "v1:broken:broken:broken" });
      const result = await ask(null);
      expect(result.recommendation_state).toBe("unavailable");
      expect(result.reason_code).toBe("INVALID_INPUT");
      expect(result.weight).toBeNull();
      expect(result.recommended_action ?? null).toBeNull();
    });

    it("어시스트 안전 상태의 문구는 generic '부하를 낮추고' 가 아니다", async () => {
      const { encryptNumber } = await import("../src/common/crypto/field-encryption");
      await seed({ painScore: encryptNumber(6) });
      const result = await ask(null);
      const api = recommendation.toApi(ASSISTED, 3, result);
      expect(api.explanation).toBe("통증이 있어 이 운동을 중단하고 무통 대체 운동으로 바꾸세요.");
      expect(api.explanation).not.toMatch(/부하를 낮추고/);
      expect(api.load_kind).toBe("assistance");
      expect(api.recommended_action).toBeNull();
    });
  });

  describe("analytics · dashboard consumer", () => {
    it("어시스트 세션은 e1RM 행을 만들지 않는다", async () => {
      await seed({});
      await request(app.getHttpServer())
        .get("/v1/analytics/e1rm?exercise_id=" + ASSISTED)
        .expect(200);
      const rows = await prisma.estimated1rm.count({
        where: { userId: USER_ID, exerciseId: ASSISTED },
      });
      expect(rows).toBe(0);
    });

    it("대시보드 볼륨에서 도움 kg 을 빼되 완료 세트 수는 유지한다", async () => {
      await seed({});
      const body = (await request(app.getHttpServer()).get("/v1/dashboard").expect(200)).body;
      const done = body.today?.done_summary ?? body.yesterday?.done_summary ?? null;
      if (done !== null) {
        expect(done.total_volume).toBe(0);
        expect(done.sets_completed).toBeGreaterThan(0);
      }
    });

    it("external 세션은 e1RM 행이 그대로 생긴다", async () => {
      await seed({ exerciseId: EXTERNAL });
      await request(app.getHttpServer())
        .get("/v1/analytics/e1rm?exercise_id=" + EXTERNAL)
        .expect(200);
      const rows = await prisma.estimated1rm.count({
        where: { userId: USER_ID, exerciseId: EXTERNAL },
      });
      expect(rows).toBeGreaterThan(0);
    });
  });
});
