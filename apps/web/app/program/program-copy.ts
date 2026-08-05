/**
 * 프로그램 확인 화면(S2)의 문구 조립 (UX_STATES §2.2).
 *
 * `Program` 에는 자유 텍스트 근거 필드가 없어서 응답 필드로 문장을 만든다.
 * 라벨 목록 밖 값이 오면 **그 자리를 통째로 생략**한다 — 영문 원문을 노출하지 않는다(AC-S2-1).
 */
import type { Program } from "../../lib/api";
import { goalLabel, splitLabel } from "../../lib/program-labels";
import { painAreaLabel } from "../../components/onboarding/pain-areas";

/** '왜 이 루틴' 문장들. 만들 수 없는 문장은 넣지 않는다. */
export function whyThisRoutine(program: Program): string[] {
  const lines: string[] = [];

  const goal = goalLabel(program.goal);
  const split = splitLabel(program.split_type);
  const days = program.sessions.length;

  if (days > 0) {
    const goalPart = goal ? `${goal} 목표에 맞춰 ` : "";
    const splitPart = split ? ` ${split} 방식으로` : "";
    lines.push(`${goalPart}주 ${days}일${splitPart} 짰어요.`);
  }

  // minutes_per_day 는 Program 응답에 없다 → "하루 {n}분 기준" 문장은 만들지 않는다.
  const perDay = program.sessions[0]?.exercises.length ?? 0;
  if (perDay > 0) {
    lines.push(`운동하는 날마다 운동 ${perDay}개를 배치했어요.`);
  }

  return lines;
}

export function excludedHeading(count: number): string {
  return count > 0 ? `안전을 위해 뺀 운동 ${count}개` : "안전을 위해 뺀 운동은 없어요";
}

/**
 * 서버 `reason` 은 개발자용 해라체이고 `movement_pattern` 원문(`squat` 등)을 담고 있어
 * 그대로 노출할 수 없다(AC-S2-1, §3.0). 부위 라벨로 사유를 다시 쓴다.
 */
export function excludedReason(painArea: string): string | null {
  const label = painAreaLabel(painArea);
  return label ? `${label}에 부담이 큰 동작이라 뺐어요.` : null;
}

export const MEDICAL_DISCLAIMER =
  "일반적인 회피 가이드이며 의료적 조언이 아니에요. 통증이 계속되거나 심해지면 전문가와 상담해 주세요.";

/** 통증 부위를 골랐는데 제외가 0건일 수 있다(예: 손목 — 제외 패턴 없이 기구 우선 정렬만 한다). §6.4 */
export const NO_EXCLUSION_NOTE =
  "선택하신 부위 때문에 뺀 운동은 없어요. 대신 관절 부담이 적은 기구 위주로 골랐어요.";

/** 통증 제외로 그 날 추천할 운동이 하나도 남지 않은 경우(§2.2 빈②). */
export const EMPTY_DAY_NOTE =
  "선택하신 통증 부위 때문에 이 날 추천할 수 있는 운동이 없어요. 통증이 나아지면 계획을 다시 만들 수 있어요.";
