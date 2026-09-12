import { estimateE1rm, toWorkingSets } from "./recommend";
import type { PerformedSet } from "./types";

/** 소스 실측은 추천 엔진과 동일한 작업세트 필터·RIR 보정으로 계산한다. */
export function similarSourceE1rm(sets: PerformedSet[], rirBias: number): number | undefined {
  return estimateE1rm(toWorkingSets(sets), rirBias);
}

/** 승인된 보수 휴리스틱. 자동 매칭하지 않는다(RECOMMENDATION_ENGINE.md). */
export const SIMILAR_INIT_DEFAULT_RATIO = 0.8;

export const SIMILAR_INIT_PAIRS: Readonly<
  Record<string, ReadonlyArray<{ source: string; ratio?: number }>>
> = {
  e_incline_bench_press: [{ source: "e_bench_press" }],
  e_decline_bench_press: [{ source: "e_bench_press" }],
  e_bench_press: [{ source: "e_incline_bench_press" }, { source: "e_decline_bench_press" }],
  e_front_squat: [{ source: "e_back_squat" }],
  e_back_squat: [{ source: "e_front_squat" }],
  e_sumo_deadlift: [{ source: "e_deadlift" }],
  e_trap_bar_deadlift: [{ source: "e_deadlift" }],
  e_deadlift: [{ source: "e_trap_bar_deadlift" }, { source: "e_sumo_deadlift" }],
  e_rdl: [{ source: "e_deadlift", ratio: 0.7 }],
  e_push_press: [{ source: "e_ohp" }],
  e_ohp: [{ source: "e_push_press", ratio: 0.7 }],
  e_pendlay_row: [{ source: "e_barbell_row" }],
  e_t_bar_row: [{ source: "e_barbell_row" }],
  e_barbell_row: [{ source: "e_pendlay_row" }, { source: "e_t_bar_row" }],
  e_neutral_grip_pulldown: [{ source: "e_lat_pulldown" }],
  e_lat_pulldown: [{ source: "e_neutral_grip_pulldown" }],
  e_rope_pushdown: [{ source: "e_triceps_pushdown" }],
  e_triceps_pushdown: [{ source: "e_rope_pushdown" }],
  e_preacher_curl: [{ source: "e_barbell_curl" }],
  e_barbell_curl: [{ source: "e_preacher_curl" }],
};

/** 화이트리스트의 소스 우선순위를 유지하고 생략된 기본 계수를 채운다. */
export function similarSourcesFor(
  exerciseId: string,
): ReadonlyArray<{ source: string; ratio: number }> {
  if (!Object.hasOwn(SIMILAR_INIT_PAIRS, exerciseId)) return [];
  return SIMILAR_INIT_PAIRS[exerciseId]!.map(({ source, ratio }) => ({
    source,
    ratio: ratio ?? SIMILAR_INIT_DEFAULT_RATIO,
  }));
}
