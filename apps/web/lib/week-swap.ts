import type { components } from "./api-types";
export type ActualWeekSession = components["schemas"]["ActualWeekSession"];
export type CurrentProgramWeek = components["schemas"]["CurrentProgramWeek"];
export type WeekSwapCandidates = components["schemas"]["WeekSwapCandidates"];
export type WeekSwapRequest = components["schemas"]["WeekSwapRequest"];
export type WeekSwapResult = components["schemas"]["WeekSwapResult"];

export const SWAP_COPY = {
  title: "이번 주 일정 바꾸기",
  description:
    "오늘 운동과 이번 주의 다른 운동 날짜를 맞바꿔요. 각 운동일의 운동 구성과 세트 수는 그대로 유지돼요.",
  empty: "이번 주에 교환할 다른 운동일이 없어요.",
  unavailable: "지금은 교환할 수 있는 운동일이 없어요. 각 운동일의 사유를 확인해 주세요.",
  noToday: "오늘은 교환할 운동이 없어요. 이번 주 일정을 확인해 주세요.",
  missing: "이 정보를 찾을 수 없어요.",
  offline: "인터넷이 연결된 뒤에 일정을 바꿀 수 있어요. 연결 후 후보를 다시 확인해 주세요.",
  pending:
    "아직 반영되지 않은 운동 기록이나 변경이 있어요. 반영 상태를 확인한 뒤 다시 시도해 주세요.",
  unresolved: "요청 결과를 확인하지 못했어요. 다시 교환하기 전에 결과를 확인해 주세요.",
  unknown: "교환할 수 없는 사유를 확인하지 못했어요. 최신 일정을 다시 확인해 주세요.",
  malformed: "일정 정보를 확인하지 못했어요. 다시 불러와 주세요.",
  failed: "잠시 문제가 있었어요. 다시 시도해 주세요.",
};
const candidateCopy = {
  readonly: "이 운동일은 날짜를 바꿀 수 없어요. 다른 운동일을 골라 주세요.",
  not_scheduled: "아직 시작하지 않은 운동끼리만 날짜를 바꿀 수 있어요. 다른 운동일을 골라 주세요.",
  performed_history: "이미 기록이 있는 운동은 날짜를 바꿀 수 없어요. 다른 운동일을 골라 주세요.",
  wrong_week: "이번 주 안의 운동끼리만 날짜를 바꿀 수 있어요. 이번 주의 다른 운동일을 골라 주세요.",
  ambiguous_schedule: "일정이 겹쳐 교환할 운동을 확인할 수 없어요. 최신 일정을 다시 확인해 주세요.",
  recovery_gap_violation:
    "날짜를 바꾸면 정해진 회복 간격을 지킬 수 없어요. 다른 운동일을 골라 주세요.",
  recovery_unverifiable:
    "회복 간격을 확인할 정보가 부족해 날짜를 바꿀 수 없어요. 최신 일정을 다시 확인해 주세요.",
};
const postCopy = {
  readonly: "지금은 이 일정의 날짜를 바꿀 수 없어요. 최신 일정을 확인해 주세요.",
  not_scheduled: "아직 시작하지 않은 운동끼리만 날짜를 바꿀 수 있어요. 최신 일정을 확인해 주세요.",
  performed_history: "이미 기록이 있는 운동은 날짜를 바꿀 수 없어요. 최신 일정을 확인해 주세요.",
  wrong_week: "이번 주 안의 운동끼리만 날짜를 바꿀 수 있어요. 이번 주 일정을 다시 확인해 주세요.",
  ambiguous_schedule: candidateCopy.ambiguous_schedule,
  recovery_gap_violation:
    "날짜를 바꾸면 정해진 회복 간격을 지킬 수 없어요. 최신 일정을 확인하고 다른 운동일을 골라 주세요.",
  recovery_unverifiable: candidateCopy.recovery_unverifiable,
  stale_revision: "다른 곳에서 먼저 바뀐 것 같아요. 최신 상태로 다시 불러올게요.",
  idempotency_payload_mismatch:
    "앞서 보낸 내용과 달라 이 요청을 진행할 수 없어요. 최신 일정을 확인하고 다시 선택해 주세요.",
};
export function candidateReasonCopy(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(candidateCopy, reason)
    ? candidateCopy[reason as keyof typeof candidateCopy]
    : SWAP_COPY.unknown;
}
export function swapReasonCopy(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(postCopy, reason)
    ? postCopy[reason as keyof typeof postCopy]
    : SWAP_COPY.unknown;
}
export function knownSwapReason(reason: unknown): boolean {
  return typeof reason === "string" && Object.hasOwn(postCopy, reason);
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
function actual(value: unknown): value is ActualWeekSession {
  if (
    !object(value) ||
    !uuid(value.id) ||
    !date(value.scheduled_date) ||
    !text(value.focus) ||
    !text(value.revision) ||
    !["scheduled", "in_progress", "completed"].includes(String(value.status)) ||
    !["planned", "ad_hoc"].includes(String(value.origin)) ||
    !Array.isArray(value.planned_set_ids) ||
    !Array.isArray(value.exercises)
  )
    return false;
  if (
    !value.planned_set_ids.every(uuid) ||
    new Set(value.planned_set_ids).size !== value.planned_set_ids.length
  )
    return false;
  const ids: string[] = [];
  for (const exercise of value.exercises) {
    if (
      !object(exercise) ||
      !text(exercise.exercise_id) ||
      !Array.isArray(exercise.planned_set_ids) ||
      !exercise.planned_set_ids.every(uuid) ||
      exercise.planned_set_ids.length !== exercise.set_count ||
      !Number.isInteger(exercise.set_count) ||
      Number(exercise.set_count) < 1 ||
      Number(exercise.set_count) > 10
    )
      return false;
    ids.push(...exercise.planned_set_ids);
  }
  return (
    ids.length === value.planned_set_ids.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => (value.planned_set_ids as string[]).includes(id))
  );
}
export function parseCurrentWeek(value: unknown): CurrentProgramWeek | null {
  if (
    !object(value) ||
    !uuid(value.program_id) ||
    !date(value.week_start) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(actual) ||
    new Set(value.sessions.map((item) => item.id)).size !== value.sessions.length
  )
    return null;
  return value as CurrentProgramWeek;
}
function eligibility(eligible: unknown, reason: unknown): boolean {
  return eligible === true
    ? reason === null
    : eligible === false && typeof reason === "string" && Object.hasOwn(candidateCopy, reason);
}
export function parseCandidates(value: unknown): WeekSwapCandidates | null {
  if (
    !object(value) ||
    !uuid(value.program_id) ||
    !date(value.week_start) ||
    !eligibility(value.today_eligible, value.today_reason) ||
    !Array.isArray(value.candidates)
  )
    return null;
  if (value.today_session_id === null || value.today_revision === null) {
    if (
      value.today_session_id !== null ||
      value.today_revision !== null ||
      value.today_eligible !== false ||
      value.today_reason !== "ambiguous_schedule"
    )
      return null;
  } else if (!uuid(value.today_session_id) || !text(value.today_revision)) return null;
  if (
    !value.candidates.every(
      (item) => object(item) && actual(item.session) && eligibility(item.eligible, item.reason),
    )
  )
    return null;
  const ids = value.candidates.map((item) => (item as { session: ActualWeekSession }).session.id);
  if (new Set(ids).size !== ids.length || ids.includes(String(value.today_session_id))) return null;
  return value as WeekSwapCandidates;
}
export function parseSwapRequest(value: unknown): WeekSwapRequest | null {
  if (
    !object(value) ||
    !uuid(value.client_id) ||
    !uuid(value.today_session_id) ||
    !uuid(value.target_session_id) ||
    value.today_session_id === value.target_session_id ||
    !text(value.today_revision) ||
    !text(value.target_revision)
  )
    return null;
  return {
    client_id: value.client_id,
    today_session_id: value.today_session_id,
    target_session_id: value.target_session_id,
    today_revision: value.today_revision,
    target_revision: value.target_revision,
  };
}
export function parseSwapResult(
  value: unknown,
  request: WeekSwapRequest,
  programId: string,
): WeekSwapResult | null {
  const week = parseCurrentWeek(value);
  if (
    !week ||
    !object(value) ||
    value.client_id !== request.client_id ||
    value.program_id !== programId ||
    value.today_session_id !== request.target_session_id ||
    week.sessions.length !== 2 ||
    !week.sessions.some((s) => s.id === request.today_session_id) ||
    !week.sessions.some((s) => s.id === request.target_session_id)
  )
    return null;
  return value as WeekSwapResult;
}

export function hasUnknownCandidateReason(value: unknown): boolean {
  if (!object(value)) return false;
  const unknown = (reason: unknown) =>
    typeof reason === "string" && !Object.hasOwn(candidateCopy, reason);
  return (
    unknown(value.today_reason) ||
    (Array.isArray(value.candidates) &&
      value.candidates.some((item) => object(item) && unknown(item.reason)))
  );
}
export class UnknownSwapReason extends Error {}
