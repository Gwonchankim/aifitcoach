import { Injectable } from "@nestjs/common";
import type { Exercise } from "@prisma/client";
import { recommendNextSet } from "shared";
import type { Goal, PerformedSet, ReasonCode, Recommendation, RecommendationInput } from "shared";
import { decryptNumber } from "../common/crypto/field-encryption";
import { PrismaService } from "../prisma/prisma.service";
import { RULES_VERSION } from "../programs/program-rules";

/** openapi: components.schemas.Recommendation */
export interface ApiRecommendation {
  exercise_id: string;
  /** null = 자체중량(맨몸·시간 종목) — 추가 부하를 처방하지 않는다. */
  weight: number | null;
  /** metric=time 종목은 반복 축이 없다 → null. */
  reps_low: number | null;
  reps_high: number | null;
  sets: number;
  /** metric=time 종목에서만 나온다. */
  time_low_sec?: number;
  time_high_sec?: number;
  reason_code: string;
  confidence: number;
  explanation: string;
  rules_version: string;
}

/** 엔진 입력의 target. metric=reps 는 reps_low/reps_high/rir, metric=time 은 time_*_sec 를 채운다. */
export type EngineTarget = RecommendationInput["target"];

export interface ExerciseHistory {
  lastSets: PerformedSet[];
  /** 해당 운동의 직전 세션에서 보고된 최대 통증(복호화값). 없으면 undefined. */
  painScore?: number;
}

export const NO_HISTORY: ExerciseHistory = { lastSets: [] };

/** reason_code → 사용자에게 보여줄 근거 문장(openapi Recommendation.explanation). 표시 문구일 뿐 규칙이 아니다. */
const EXPLANATION: Record<ReasonCode, string> = {
  WEIGHT_UP_REP_TARGET_MET: "모든 세트가 목표 반복 상단에 도달해 한 스텝 증량한다.",
  ADD_ONE_REP: "무게는 유지하고 목표 반복을 1회 늘린다.",
  HOLD_RIR_LOW: "반복은 지켰지만 RIR 이 낮아 무게를 유지한다.",
  TOO_HARD: "목표 반복에 미달해 부하를 낮춘다.",
  SIMILAR_INIT: "유사 운동 기록으로 보수적인 시작 무게를 잡는다.",
  BASELINE: "기록이 없어 워밍업으로 시작 무게를 정한다.",
  INVALID_INPUT: "진행 규칙을 적용할 입력(증량 단위·목표 반복)이 부족하다.",
  SUBSTITUTE_PAIN: "통증이 보고되어 부하를 낮추고 대체 운동을 제안한다.",
  VOLUME_SPIKE_CAP: "주간 볼륨 급증을 막기 위해 증량을 제한한다.",
  DELOAD_SUGGESTED: "피로 신호가 누적되어 볼륨을 줄인 디로드를 제안한다.",
  RIR_TOO_EASY_INCREASE: "RIR 이 목표보다 높아(여유가 많아) 증량한다.",
  RIR_ON_TARGET_HOLD: "RIR 이 목표 범위라 현재 부하를 유지한다.",
  RIR_TOO_HARD_REDUCE: "RIR 이 목표보다 낮아(과부하) 무게를 낮춘다.",
  CALIBRATION_NEEDED: "RIR 캘리브레이션이 필요하다.",
  CALIBRATION_GRADUATED: "RIR 캘리브레이션이 완료되어 보정값을 적용한다.",
  CALIBRATION_STALE: "RIR 캘리브레이션이 오래되어 재측정이 필요하다.",
  REPS_UP_BODYWEIGHT: "자체중량 종목이라 무게 대신 목표 반복 상단을 1회 올린다.",
  PROGRESSION_CAP_BODYWEIGHT: "반복 상한에 도달해 가중(웨이트 벨트)이나 더 어려운 변형을 제안한다.",
  SUBSTITUTE_TOO_HARD_BODYWEIGHT:
    "자체중량이 아직 무거워 보조 종목(머신·케이블)으로 대체를 제안한다.",
  TIME_UP: "모든 세트가 목표 유지 시간 상단에 도달해 목표 시간을 늘린다.",
  TIME_HOLD: "목표 유지 시간 범위 안이라 현재 목표를 유지한다.",
  TIME_DOWN: "목표 유지 시간 하단에 크게 미달해 목표 시간을 낮춘다.",
};

/**
 * 추천 엔진(packages/shared) 호출을 위한 입력 조립 + 응답 매핑.
 * 규칙(무게·반복·reason_code)은 전부 recommendNextSet 안에 있고 여기서 재구현하지 않는다.
 */
@Injectable()
export class RecommendationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * calibration 객체의 **존재 자체가 RIR 축 활성 스위치**다(PROGRESS.md STEP 3).
   * 튜토리얼을 마치지 않은 사용자에게 rir_bias: 0 을 채워 넣으면 안 되고 undefined 를 돌려준다.
   */
  async calibrationFor(userId: string): Promise<{ rir_bias: number } | undefined> {
    const row = await this.prisma.userRirCalibration.findUnique({ where: { userId } });
    if (!row || row.status !== "graduated") {
      return undefined;
    }
    return { rir_bias: Number(row.biasOverall) };
  }

  /** 해당 운동을 마지막으로 수행한 완료 세션의 세트들(없으면 빈 배열). */
  async historyFor(userId: string, exerciseId: string): Promise<ExerciseHistory> {
    const rows = await this.prisma.performedSet.findMany({
      where: {
        completed: true,
        plannedSet: { exerciseId, session: { status: "completed", program: { userId } } },
      },
      select: {
        actualWeight: true,
        actualReps: true,
        actualRir: true,
        actualTimeSec: true,
        painScore: true,
        plannedSet: {
          select: { setNo: true, sessionId: true, session: { select: { scheduledDate: true } } },
        },
      },
    });
    if (rows.length === 0) {
      return NO_HISTORY;
    }

    const latest = rows.reduce((a, b) =>
      b.plannedSet.session.scheduledDate > a.plannedSet.session.scheduledDate ? b : a,
    );
    const latestRows = rows
      .filter((row) => row.plannedSet.sessionId === latest.plannedSet.sessionId)
      .sort((a, b) => a.plannedSet.setNo - b.plannedSet.setNo);

    return toHistory(latestRows);
  }

  /** 엔진 호출. exercise 는 시드 카탈로그 행, target 은 planned_set 의 목표값. */
  recommend(params: {
    goal: Goal;
    exercise: Pick<Exercise, "mechanic" | "region" | "defaultStepKg" | "metric">;
    target: EngineTarget;
    history: ExerciseHistory;
    calibration?: { rir_bias: number };
  }): Recommendation {
    const { goal, exercise, target, history, calibration } = params;
    return recommendNextSet({
      goal,
      exercise: {
        type: exercise.mechanic,
        region: exercise.region,
        // null = 맨몸(자체중량). 0 을 넣으면 엔진이 "잘못된 증량 단위"로 보고 INVALID_INPUT 을 낸다.
        step_kg: exercise.defaultStepKg === null ? null : Number(exercise.defaultStepKg),
        metric: exercise.metric,
      },
      target,
      last_sets: history.lastSets,
      ...(calibration ? { calibration } : {}),
      ...(history.painScore === undefined ? {} : { safety: { pain_score: history.painScore } }),
      rules_version: RULES_VERSION,
    });
  }

  toApi(exerciseId: string, sets: number, recommendation: Recommendation): ApiRecommendation {
    return {
      exercise_id: exerciseId,
      // 맨몸·시간 종목은 weight=null, 시간 종목은 반복 축이 없어 reps_*=null 이다(openapi nullable).
      weight: recommendation.weight,
      reps_low: recommendation.reps_low ?? null,
      reps_high: recommendation.reps_high ?? null,
      sets,
      ...(recommendation.time_low_sec === undefined
        ? {}
        : { time_low_sec: recommendation.time_low_sec }),
      ...(recommendation.time_high_sec === undefined
        ? {}
        : { time_high_sec: recommendation.time_high_sec }),
      reason_code: recommendation.reason_code,
      confidence: recommendation.confidence,
      explanation: EXPLANATION[recommendation.reason_code],
      rules_version: recommendation.rules_version,
    };
  }
}

/** 암호문 → 숫자 복호화는 서비스 레이어(여기)에서만 한다. repository/prisma 는 string|null 만 다룬다. */
export function toHistory(
  rows: {
    actualWeight: { toString(): string } | null;
    actualReps: number | null;
    actualRir: number | null;
    actualTimeSec: number | null;
    painScore: string | null;
  }[],
): ExerciseHistory {
  // metric=reps 는 w/reps(+rir), metric=time 은 time_sec 만 채운다(엔진 PerformedSet).
  const lastSets = rows.map((row) => ({
    ...(row.actualWeight === null ? {} : { w: Number(row.actualWeight) }),
    ...(row.actualReps === null ? {} : { reps: row.actualReps }),
    ...(row.actualRir === null ? {} : { rir: row.actualRir }),
    ...(row.actualTimeSec === null ? {} : { time_sec: row.actualTimeSec }),
  }));
  const painScores = rows
    .map((row) => decryptNumber(row.painScore))
    .filter((value): value is number => value !== null);

  return painScores.length === 0 ? { lastSets } : { lastSets, painScore: Math.max(...painScores) };
}
