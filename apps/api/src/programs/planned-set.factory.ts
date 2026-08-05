import { Injectable } from "@nestjs/common";
import type { Exercise, Prisma } from "@prisma/client";
import type { Goal } from "shared";
import type { EngineTarget } from "../recommendation/recommendation.service";
import { RecommendationService } from "../recommendation/recommendation.service";
import { RULES_VERSION, repsFor, restSecFor, setCountFor, targetRirFor } from "./program-rules";

export type PlannedSetRow = Omit<Prisma.PlannedSetCreateManyInput, "sessionId">;

/**
 * planned_set 의 목표값.
 * metric=reps 는 목표별 표(program-rules)를, metric=time(e_plank)은 반복·RIR 축이 없어
 * 카탈로그의 default_time_*_sec(시드 20~60초)를 그대로 쓴다 — 문서에 시간 종목의 목표별 표가 없다(해석).
 */
export function targetFor(goal: Goal, exercise: Exercise): EngineTarget {
  if (exercise.metric === "time") {
    return {
      ...(exercise.defaultTimeLowSec === null ? {} : { time_low_sec: exercise.defaultTimeLowSec }),
      ...(exercise.defaultTimeHighSec === null
        ? {}
        : { time_high_sec: exercise.defaultTimeHighSec }),
    };
  }
  const reps = repsFor(goal, exercise.mechanic);
  return { reps_low: reps.low, reps_high: reps.high, rir: targetRirFor(goal) };
}

/**
 * 한 운동에 대한 planned_set 행들을 만든다(프로그램 생성 · 루틴 편집 공용).
 * 목표값은 program-rules, 추천값(recommended_*)은 packages/shared 엔진이 정한다.
 */
@Injectable()
export class PlannedSetFactory {
  constructor(private readonly recommendation: RecommendationService) {}

  async build(params: {
    userId: string;
    goal: Goal;
    exercise: Exercise;
    orderIndex: number;
    sets?: number;
  }): Promise<PlannedSetRow[]> {
    const { userId, goal, exercise, orderIndex } = params;
    const target = targetFor(goal, exercise);
    const setCount = params.sets ?? setCountFor(goal, exercise.mechanic);

    const [history, calibration] = await Promise.all([
      this.recommendation.historyFor(userId, exercise.id),
      this.recommendation.calibrationFor(userId),
    ]);
    const recommendation = this.recommendation.recommend({
      goal,
      exercise,
      target,
      history,
      ...(calibration ? { calibration } : {}),
    });

    return Array.from({ length: setCount }, (_unused, index) => ({
      exerciseId: exercise.id,
      orderIndex,
      setNo: index + 1,
      // metric=time 종목은 반복·RIR 축이 없어 null 이고 target_time_*_sec 를 쓴다.
      targetRepsLow: target.reps_low ?? null,
      targetRepsHigh: target.reps_high ?? null,
      targetRir: target.rir ?? null,
      restSec: restSecFor(goal),
      targetTimeLowSec: target.time_low_sec ?? null,
      targetTimeHighSec: target.time_high_sec ?? null,
      // BASELINE 은 weight 0("무게 미정")을 반환한다 — 서버는 엔진 값을 그대로 저장하고
      // reason_code 로 의미를 전달한다(0kg 렌더링 가드는 프론트 몫, PROGRESS.md STEP 3).
      // 맨몸·시간 종목은 weight=null(추가 부하 없음)이다.
      recommendedWeight: recommendation.weight,
      recommendedReps: recommendation.reps_low ?? null,
      reasonCode: recommendation.reason_code,
      confidence: recommendation.confidence,
      rulesVersion: RULES_VERSION,
    }));
  }
}
