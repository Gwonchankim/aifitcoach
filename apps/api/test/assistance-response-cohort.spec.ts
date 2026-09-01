/**
 * F-3 final fixup — 종료 응답의 target cohort 판정(최종 독립 재리뷰 P1-1).
 *
 * 응답이 무엇을 내보낼지는 **저장된 target snapshot** 이 정한다. 카탈로그의 현재
 * `loadSemantics` 를 보고 첫 행을 투영하면 두 정상 데이터 상태에서 `.08.1` 일반 가중 처방이
 * 그대로 새어 나간다:
 *   ① 다음 세션이 없어 현재(방금 수행한) legacy 세션으로 fallback 할 때
 *   ② migration 당시 일부만 수행돼 `setNo 1` 이 legacy, 뒤가 remediated 인 mixed 세션
 *
 * 그래서 여기 fixture 는 factory 를 쓰지 않고 **그 상태를 직접 만든다.**
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { classifyTargetCohort } from "../src/programs/assistance-migration";
import { createTestApp, resetUserData } from "./support/app";
import { expectMatchesContract } from "./support/openapi-response";

const USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const EXTERNAL = "e_face_pull";
const OTHER = "e_chest_press_machine";
const COMPLETE_PATH = "/sessions/{sessionId}/complete";
const SETS_PER_SESSION = 2;

type RowSpec = {
  loadSemantics: "assistance" | "external_load";
  assistanceProvenance: "native" | "remediated" | "legacy_performed" | null;
  assistanceStepKg: string | null;
  rulesVersion: string;
  reasonCode: string;
  recommendedWeight: string | null;
  confidence: string;
};

/** 보존 대상 legacy 행 — 일반 가중 처방을 그대로 들고 있다. 절대 노출되면 안 된다. */
const LEGACY: RowSpec = {
  loadSemantics: "assistance",
  assistanceProvenance: "legacy_performed",
  assistanceStepKg: "2.50",
  rulesVersion: "2026.08.1",
  reasonCode: "WEIGHT_UP_REP_TARGET_MET",
  recommendedWeight: "42.50",
  confidence: "0.85",
};
const REMEDIATED: RowSpec = {
  loadSemantics: "assistance",
  assistanceProvenance: "remediated",
  assistanceStepKg: "2.50",
  rulesVersion: "2026.08.2",
  reasonCode: "ASSISTANCE_CALIBRATION_NEEDED",
  recommendedWeight: null,
  confidence: "0",
};
const NATIVE: RowSpec = { ...REMEDIATED, assistanceProvenance: "native" };

/** 실제 mapper 가 내는 진행 처방 — 도움을 한 스텝 줄였다. */
const PROGRESSING: RowSpec = {
  ...NATIVE,
  reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET",
  recommendedWeight: "17.50",
  confidence: "0.85",
};
/** 최소 경계 — 더 줄이면 0 이하라 유지한다. action 이 붙는 유일한 상태다. */
const MINIMUM: RowSpec = {
  ...NATIVE,
  reasonCode: "ASSISTANCE_MINIMUM_REACHED",
  recommendedWeight: "2.50",
  confidence: "0.85",
};
const PAIN: RowSpec = {
  ...NATIVE,
  reasonCode: "SUBSTITUTE_PAIN",
  recommendedWeight: null,
  confidence: "0",
};
const INVALID: RowSpec = { ...PAIN, reasonCode: "INVALID_INPUT" };
const EXTERNAL_ROW: RowSpec = {
  loadSemantics: "external_load",
  assistanceProvenance: null,
  assistanceStepKg: null,
  rulesVersion: "2026.08.1",
  reasonCode: "BASELINE",
  recommendedWeight: "0",
  confidence: "0.60",
};

type NextRecommendation = {
  exercise_id: string;
  gate_state: "no_history" | "early" | "ready";
  recommendation: Record<string, unknown> | null;
};

// ------------------------------------------------------- ① 순수 cohort 판정

describe("① classifyTargetCohort — 저장 snapshot 만 본다", () => {
  // legacy_performed 는 정의상 수행된 행이다 — 판정 입력에도 그 사실을 싣는다(F-4a).
  const rows = (...specs: RowSpec[]) =>
    specs.map((spec) => ({
      ...spec,
      assistanceStepKg: spec.assistanceStepKg,
      hasServerAppliedPerformedFact: spec.assistanceProvenance === "legacy_performed",
    }));

  it("빈 target 은 unsafe — 무엇을 내보낼지 알 수 없다", () => {
    expect(classifyTargetCohort([])).toBe("unsafe");
  });

  it("전부 external_load 면 generic", () => {
    expect(classifyTargetCohort(rows(EXTERNAL_ROW, EXTERNAL_ROW))).toBe("generic");
  });

  it("uniform native · remediated safe cohort 만 assistance_safe", () => {
    expect(classifyTargetCohort(rows(NATIVE, NATIVE))).toBe("assistance_safe");
    expect(classifyTargetCohort(rows(REMEDIATED, REMEDIATED))).toBe("assistance_safe");
    // 실제 mapper 결과(진행 처방)도 safe 여야 한다 — 캘리브레이션 모양만 통과시키면
    // F-4a 가 mapper 를 붙이는 순간 모든 어시스트 추천이 응답에서 사라진다.
    expect(classifyTargetCohort(rows(PROGRESSING, PROGRESSING))).toBe("assistance_safe");
  });

  it("최소 경계 처방도 safe 다 — action 이 붙는 유일한 상태다", () => {
    expect(classifyTargetCohort(rows(MINIMUM, MINIMUM))).toBe("assistance_safe");
  });

  it("안전 상태(통증·입력오류) 처방도 safe 다 — 숨길 값이 없다", () => {
    expect(classifyTargetCohort(rows(PAIN, PAIN))).toBe("assistance_safe");
    expect(classifyTargetCohort(rows(INVALID, INVALID))).toBe("assistance_safe");
  });

  it("legacy 는 uniform 이어도 unsafe — 일반 가중 처방을 들고 있다", () => {
    expect(classifyTargetCohort(rows(LEGACY, LEGACY))).toBe("unsafe");
  });

  it("mixed 는 unsafe — 첫 행만 보면 legacy 가 샌다", () => {
    expect(classifyTargetCohort(rows(LEGACY, REMEDIATED))).toBe("unsafe");
    expect(classifyTargetCohort(rows(REMEDIATED, LEGACY))).toBe("unsafe");
    expect(classifyTargetCohort(rows(NATIVE, REMEDIATED))).toBe("unsafe");
    expect(classifyTargetCohort(rows(NATIVE, EXTERNAL_ROW))).toBe("unsafe");
  });

  it("unknown rules version 은 fail closed", () => {
    expect(classifyTargetCohort(rows({ ...NATIVE, rulesVersion: "9999.99.9" }))).toBe("unsafe");
  });

  it("cohort 축을 하나씩 깨면 전부 unsafe 가 된다", () => {
    const broken: Array<[string, RowSpec]> = [
      ["step 0", { ...NATIVE, assistanceStepKg: "0" }],
      ["step 음수", { ...NATIVE, assistanceStepKg: "-2.50" }],
      ["step 없음", { ...NATIVE, assistanceStepKg: null }],
      ["matrix 위반", { ...NATIVE, rulesVersion: "2026.08.1" }],
      ["generic 증량 reason", { ...PROGRESSING, reasonCode: "WEIGHT_UP_REP_TARGET_MET" }],
      ["generic RIR reason", { ...PROGRESSING, reasonCode: "RIR_TOO_EASY_INCREASE" }],
      ["BASELINE + 0kg", { ...PROGRESSING, reasonCode: "BASELINE", recommendedWeight: "0" }],
      ["진행인데 weight 0", { ...PROGRESSING, recommendedWeight: "0" }],
      ["진행인데 weight 없음", { ...PROGRESSING, recommendedWeight: null }],
      ["캘리브레이션인데 weight 존재", { ...NATIVE, recommendedWeight: "10.00" }],
      ["통증인데 weight 존재", { ...PAIN, recommendedWeight: "10.00" }],
      ["입력오류인데 weight 존재", { ...INVALID, recommendedWeight: "10.00" }],
      ["provenance 없음", { ...NATIVE, assistanceProvenance: null }],
    ];
    for (const [label, spec] of broken) {
      expect(`${label}:${classifyTargetCohort(rows(spec, spec))}`).toBe(`${label}:unsafe`);
    }
  });

  it("external_load 인데 assistance 축이 남아 있으면 unsafe", () => {
    expect(classifyTargetCohort(rows({ ...EXTERNAL_ROW, assistanceProvenance: "native" }))).toBe(
      "unsafe",
    );
    expect(classifyTargetCohort(rows({ ...EXTERNAL_ROW, assistanceStepKg: "2.50" }))).toBe(
      "unsafe",
    );
  });
});

// ------------------------------------------------------ ② API integration

describe("② 종료 응답 — 실제 데이터 상태", () => {
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
  });

  /**
   * 표시 게이트(D-39)가 완료 세션 3개를 요구한다 — 그전에는 `recommendation` 이 null 이라
   * 누출이 관측되지 않는다. 세션 0·1 을 완료 상태로 심고, 세션 2 를 API 로 종료한다.
   * 세션 3(있다면)이 `nextSession` = target 이다.
   */
  async function seedHistory(opts: {
    exerciseId: string;
    history: RowSpec;
    next: RowSpec[] | null;
    alsoExerciseId?: string;
  }): Promise<{ completingSessionId: string; nextSessionId: string | null }> {
    const program = await prisma.program.create({
      data: {
        userId: USER_ID,
        goal: "hypertrophy",
        daysPerWeek: 4,
        minutesPerDay: 60,
        splitType: "upper_lower",
        rulesVersion: "2026.08.1",
        startedAt: new Date("2026-08-03T00:00:00Z"),
        totalWeeks: 12,
        status: "active",
        generationInput: {},
        template: [],
        excludedExercises: [],
      },
    });

    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const performedHistory = index < 3;
      const isNext = index === 3;
      if (isNext && opts.next === null) break;
      const session = await prisma.workoutSession.create({
        data: {
          programId: program.id,
          scheduledDate: new Date(Date.UTC(2026, 7, 3 + index)),
          focus: "upper",
          // 종료할 세션(2)은 API 가 완료 처리한다.
          status: index < 2 ? "completed" : "scheduled",
          ...(index < 2 ? { completedAt: new Date(Date.UTC(2026, 7, 3 + index, 10)) } : {}),
        },
      });
      ids.push(session.id);

      const specs = isNext
        ? opts.next!
        : Array.from({ length: SETS_PER_SESSION }, () => opts.history);
      await seedPlannedRows(session.id, opts.exerciseId, specs, performedHistory);
      if (opts.alsoExerciseId) {
        await seedPlannedRows(
          session.id,
          opts.alsoExerciseId,
          Array.from({ length: SETS_PER_SESSION }, () => EXTERNAL_ROW),
          performedHistory,
        );
      }
    }

    return { completingSessionId: ids[2], nextSessionId: ids[3] ?? null };
  }

  async function seedPlannedRows(
    sessionId: string,
    exerciseId: string,
    specs: RowSpec[],
    performed: boolean,
  ): Promise<void> {
    for (const [index, spec] of specs.entries()) {
      const planned = await prisma.plannedSet.create({
        data: {
          sessionId,
          exerciseId,
          orderIndex: 0,
          setNo: index + 1,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 90,
          recommendedReps: 8,
          loadSemantics: spec.loadSemantics,
          assistanceStepKg: spec.assistanceStepKg,
          assistanceProvenance: spec.assistanceProvenance,
          reasonCode: spec.reasonCode,
          recommendedWeight: spec.recommendedWeight,
          confidence: spec.confidence,
          rulesVersion: spec.rulesVersion,
        },
      });
      // legacy_performed 는 정의상 수행된 행이다 — target 세션에서도 사실을 유지한다.
      if (performed || spec.assistanceProvenance === "legacy_performed") {
        await prisma.performedSet.create({
          data: {
            plannedSetId: planned.id,
            actualWeight: "20",
            actualReps: 12,
            actualRir: 2,
            completed: true,
            clientId: randomUUID(),
            performedAt: new Date("2026-08-05T10:00:00Z"),
          },
        });
      }
    }
  }

  async function complete(sessionId: string): Promise<NextRecommendation[]> {
    const response = await request(app.getHttpServer())
      .post(`/v1/sessions/${sessionId}/complete`)
      .send({})
      .expect(200);
    expectMatchesContract("post", COMPLETE_PATH, 200, response.body);
    return response.body.next_recommendations as NextRecommendation[];
  }

  it("(a) 다음 세션이 없고 현재 target 이 legacy 면 그 운동을 응답에서 뺀다", async () => {
    const { completingSessionId } = await seedHistory({
      exerciseId: ASSISTED,
      history: LEGACY,
      next: null,
    });

    const items = await complete(completingSessionId);

    expect(items.find((item) => item.exercise_id === ASSISTED)).toBeUndefined();
    // 게이트가 열려 있었음을 확인한다 — 아니면 이 fixture 는 아무것도 방어하지 못한다.
    const gate = await prisma.workoutSession.count({
      where: { program: { userId: USER_ID }, status: "completed" },
    });
    expect(gate).toBe(3);
  });

  it("(b) setNo 1 legacy + 뒤 remediated 인 mixed target 을 뺀다", async () => {
    const { completingSessionId } = await seedHistory({
      exerciseId: ASSISTED,
      history: LEGACY,
      next: [LEGACY, REMEDIATED],
    });

    const items = await complete(completingSessionId);

    expect(items.find((item) => item.exercise_id === ASSISTED)).toBeUndefined();
  });

  it("(b2) setNo 1 이 안전해도 뒤가 legacy 면 뺀다 — 첫 행만 보면 안 된다", async () => {
    const { completingSessionId } = await seedHistory({
      exerciseId: ASSISTED,
      history: LEGACY,
      next: [REMEDIATED, LEGACY],
    });

    const items = await complete(completingSessionId);

    expect(items.find((item) => item.exercise_id === ASSISTED)).toBeUndefined();
  });

  it("(c) 카탈로그 의미와 snapshot 이 다르면 snapshot 이 이긴다", async () => {
    // 카탈로그의 e_face_pull 은 external_load 다. 그런데 저장 snapshot 은 assistance legacy 다.
    // 카탈로그로 분기하면 generic 경로로 빠져 `.08.1` 일반 처방이 그대로 나간다.
    const { completingSessionId } = await seedHistory({
      exerciseId: EXTERNAL,
      history: LEGACY,
      next: [LEGACY, LEGACY],
    });

    const items = await complete(completingSessionId);

    expect(items.find((item) => item.exercise_id === EXTERNAL)).toBeUndefined();
  });

  it("(d) uniform native · remediated cohort 만 저장 row 그대로 투영된다", async () => {
    for (const spec of [NATIVE, REMEDIATED]) {
      await resetUserData(prisma, USER_ID);
      const { completingSessionId, nextSessionId } = await seedHistory({
        exerciseId: ASSISTED,
        history: LEGACY,
        next: [spec, spec],
      });

      const items = await complete(completingSessionId);
      const item = items.find((entry) => entry.exercise_id === ASSISTED);
      expect(item?.gate_state).toBe("ready");

      const stored = await prisma.plannedSet.findMany({
        where: { sessionId: nextSessionId!, exerciseId: ASSISTED },
        orderBy: { setNo: "asc" },
      });
      // 저장 행과 응답은 **같은 mapper 결과 하나**에서 나온다 — 값 복사가 아니라 동일 출처다.
      expect(item!.recommendation).toMatchObject({
        load_kind: "assistance",
        rules_version: "2026.08.2",
        sets: stored.length,
      });
      expect(item!.recommendation!.reason_code).toBe(stored[0].reasonCode);
      expect(item!.recommendation!.rules_version).toBe(stored[0].rulesVersion);
      expect(item!.recommendation!.confidence).toBe(Number(stored[0].confidence));
      expect(item!.recommendation!.weight).toBe(
        stored[0].recommendedWeight === null ? null : Number(stored[0].recommendedWeight),
      );
      // 과거 유효 관측이 있으므로 캘리브레이션이 아니라 **어시스트 진행 처방**이다.
      expect(String(item!.recommendation!.reason_code).startsWith("ASSISTANCE_")).toBe(true);
      expect(item!.recommendation!.reason_code).not.toBe("ASSISTANCE_CALIBRATION_NEEDED");
      expect(Number(item!.recommendation!.weight)).toBeGreaterThan(0);
    }
  });

  /**
   * source(방금 수행한) 와 target 의 **저장 semantics 가 다르면** 한 계산에 섞을 수 없다 —
   * 도움 kg 을 부하로, 또는 그 반대로 읽는다. 양방향 모두 write 0 + omit 이고,
   * 세션 종료는 **500 이 아니라 정상 200** 이다(부분 상태를 남기지 않는다).
   */
  it.each([
    ["source assistance → target external", REMEDIATED, EXTERNAL_ROW],
    ["source external → target assistance", EXTERNAL_ROW, REMEDIATED],
  ])("(e) %s 는 갱신도 응답도 하지 않는다", async (_label, historySpec, nextSpec) => {
    const { completingSessionId, nextSessionId } = await seedHistory({
      exerciseId: ASSISTED,
      history: historySpec,
      next: [nextSpec, nextSpec],
    });
    const before = await prisma.plannedSet.findMany({
      where: { sessionId: nextSessionId!, exerciseId: ASSISTED },
      orderBy: { setNo: "asc" },
    });

    const items = await complete(completingSessionId);

    expect(items.find((item) => item.exercise_id === ASSISTED)).toBeUndefined();
    const after = await prisma.plannedSet.findMany({
      where: { sessionId: nextSessionId!, exerciseId: ASSISTED },
      orderBy: { setNo: "asc" },
    });
    // write 0 — 부분 갱신도 없다.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("omit 은 그 운동에만 적용된다 — 다른 non-assisted 추천은 남는다", async () => {
    const { completingSessionId } = await seedHistory({
      exerciseId: ASSISTED,
      history: LEGACY,
      next: null,
      alsoExerciseId: OTHER,
    });

    const items = await complete(completingSessionId);

    expect(items.find((item) => item.exercise_id === ASSISTED)).toBeUndefined();
    const other = items.find((item) => item.exercise_id === OTHER);
    expect(other?.recommendation).not.toBeNull();
    expect(other!.recommendation!.rules_version).toBe("2026.08.1");
  });
});
