import type { ProgramsService } from "../../src/programs/programs.service";

/**
 * V1(`2026.08.1`) 생성 결과의 **정규화 표현**.
 *
 * current-vs-current 비교(같은 코드로 두 번 생성해 같은지 보기)는 **회귀를 못 잡는다** —
 * 규칙을 바꿔도 양쪽이 함께 바뀌므로 항상 통과한다. 그래서 이 표현을 **커밋된 정적 fixture**
 * 로 고정하고 exact equality 로 비교한다.
 *
 * UUID·생성시각만 제외한다. focus·운동 순서·세트 수·목표(reps/time/RIR)·휴식은 **전부 남긴다** —
 * 무엇 하나라도 빼면 그 축을 바꿔도 fixture 가 통과한다.
 */

export type NormalizedProgram = {
  key: string;
  rules_version: string;
  sessions: {
    day: string;
    focus: string;
    exercises: {
      id: string;
      sets: number;
      reps_low: number | null;
      reps_high: number | null;
      rir: number | null;
      time_low_sec: number | null;
      time_high_sec: number | null;
      rest_sec: number;
    }[];
  }[];
};

export function normalizeProgram(
  key: string,
  program: Awaited<ReturnType<ProgramsService["generate"]>>,
): NormalizedProgram {
  return {
    key,
    rules_version: program.rules_version,
    sessions: program.sessions.map((s) => ({
      day: s.day,
      focus: String(s.focus),
      // 순서가 계약이다 — 정렬하지 않는다.
      exercises: s.exercises.map((e) => ({
        id: e.exercise_id,
        sets: e.sets,
        reps_low: e.reps_low ?? null,
        reps_high: e.reps_high ?? null,
        rir: e.target_rir ?? null,
        time_low_sec: e.time_low_sec ?? null,
        time_high_sec: e.time_high_sec ?? null,
        rest_sec: e.rest_sec,
      })),
    })),
  };
}

/** fixture 키. 조합을 사람이 읽을 수 있게 만든다. */
export function planKey(goal: string, days: number, minutes: number, level: string): string {
  return `${goal}/${days}d/${minutes}m/${level}`;
}
