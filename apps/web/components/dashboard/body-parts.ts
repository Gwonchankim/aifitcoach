/**
 * 즉석 세션(F8-1)의 부위 목록.
 *
 * 전송값은 계약 enum(`CreateAdHocSessionRequest.body_part`)에서 타입으로 고정한다 —
 * 라벨과 분리해서 라벨을 실수로 전송하는 일이 없게 한다(F0-1 통증 부위와 같은 원칙).
 * 6개 구분은 F5 운동 추가 팝업의 부위 탭과 같다.
 */
import type { BodyPart } from "../../lib/api";

export const BODY_PARTS: { id: BodyPart; label: string }[] = [
  { id: "chest", label: "가슴" },
  { id: "back", label: "등" },
  { id: "shoulders", label: "어깨" },
  { id: "arms", label: "팔" },
  { id: "legs", label: "하체" },
  { id: "core", label: "코어" },
];

/** 회복 안내를 띄우는 연속 운동일(F8-1: 7일 연속 이상). 막지는 않는다. */
export const RECOVERY_STREAK_DAYS = 7;

export function needsRecoveryNotice(streakDays: number): boolean {
  return streakDays >= RECOVERY_STREAK_DAYS;
}
