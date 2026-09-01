import { Injectable } from "@nestjs/common";
import type { Exercise, Prisma } from "@prisma/client";
import type { Goal, PackCandidate } from "shared";
import type { EngineTarget, ExerciseHistory } from "../recommendation/recommendation.service";
import { RecommendationService } from "../recommendation/recommendation.service";
import { assertAssistanceSnapshot } from "./assistance-migration";
import { repsFor, restSecFor, setCountFor, targetRirFor } from "./program-rules";

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
 * 카탈로그 행 → packer 후보. 목표별 반복/시간 상단이 수행시간 추정에 쓰이므로 targetFor 를 거친다.
 * packer 는 순수 함수라 Prisma 타입을 모른다(packages/shared).
 */
export function toPackCandidate(goal: Goal, exercise: Exercise): PackCandidate {
  const target = targetFor(goal, exercise);
  return {
    id: exercise.id,
    mechanic: exercise.mechanic,
    movement_pattern: exercise.movementPattern,
    unilateral: exercise.unilateral,
    metric: exercise.metric,
    target_reps_high: target.reps_high ?? null,
    target_time_high_sec: target.time_high_sec ?? null,
  };
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
    /**
     * batch prefetch 결과. **필수다** — 여기서 DB 를 다시 읽으면 호출자가 아무리 batch 해도
     * 종목마다 질의가 붙는다. 호출자가 spec 을 먼저 모아 한 번에 읽어 넘긴다.
     */
    history: ExerciseHistory;
    /** `undefined` 는 "RIR 축 미활성"이라는 **의미 있는 값**이다(기본값을 채우지 않는다). */
    calibration: { rir_bias: number } | undefined;
  }): Promise<PlannedSetRow[]> {
    const { goal, exercise, orderIndex } = params;
    const target = targetFor(goal, exercise);
    const setCount = params.sets ?? setCountFor(goal, exercise.mechanic);

    // **여기서 DB 를 읽지 않는다.** fallback 을 두면 호출자의 batch 가 조용히 무력화된다.
    const { history, calibration } = params;
    const recommendation = this.recommendation.recommend({
      goal,
      exercise,
      target,
      history,
      ...(calibration ? { calibration } : {}),
    });

    // 어시스트 종목은 assistance 를 아는 bundle 로 계산·저장한다(F-4a). 활성 포인터가 `.08.1`
    // 이어도 그 값으로 저장하면 그 행은 "도움 kg 을 일반 부하로 읽어야 하는 행"이 된다.
    // 처방 자체는 이제 **실제 assistance mapper 의 결과**다 — F-3 의 무게 미정 fail-safe 가 아니다.
    const assisted = exercise.loadSemantics === "assistance";
    const assistanceSnapshot = assisted
      ? {
          assistanceStepKg: exercise.defaultStepKg ?? "2.50",
          assistanceProvenance: "native" as const,
        }
      : {};
    const rulesVersion = recommendation.rules_version;

    assertAssistanceSnapshot({
      loadSemantics: exercise.loadSemantics,
      assistanceStepKg: assisted ? assistanceSnapshot.assistanceStepKg : null,
      assistanceProvenance: assisted ? "native" : null,
      rulesVersion,
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
      // immutable snapshot — 생성 시점 카탈로그 값을 굳힌다(F-3).
      loadSemantics: exercise.loadSemantics,
      ...assistanceSnapshot,
      rulesVersion,
    }));
  }
}
