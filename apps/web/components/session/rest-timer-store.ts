/**
 * 휴식 타이머의 로컬 지속.
 *
 * 타이머가 React state 에만 있으면 새로고침·앱 강제 종료로 사라진다. 사용자는 휴식 중에 화면을
 * 끄거나 다른 앱으로 넘어가므로 그게 곧 "돌아왔더니 타이머가 없다"가 된다.
 *
 * **새 store 도, 새 스키마 버전도 만들지 않는다.** 기존 `syncMeta` 에 `rest-timer:` 네임스페이스로
 * 넣는다. F-4b marker 는 `assistance-remediation:` 접두사이고 그쪽 코드는 전부 **정확한 키**로만
 * 읽고 지우므로(`markerKeyFor`), 두 네임스페이스는 서로를 볼 수 없다.
 *
 * 남은 시간은 **저장하지 않는다.** 언제나 `Date.now()` 와 `ends_at` 으로 계산한다 — 감산한 값을
 * 저장하면 백그라운드에 있던 시간만큼 어긋난다.
 */
import { DEV_USER_SCOPE, sessionDb } from "./session-db";
import { REST_MAX_SEC, type RestTimer } from "../../lib/rest-timer";

export const REST_TIMER_PREFIX = "rest-timer:";

/**
 * 레코드 모양의 버전. 모양을 바꿀 일이 생기면 이 값을 올리고, **모르는 버전은 읽지 않는다**
 * (fail closed). 스키마 버전이 아니라 값 안의 버전이라 Dexie migration 이 필요 없다.
 */
export const REST_TIMER_RECORD_VERSION = 1;

/**
 * 이 시간이 더 지난 기록은 복구하지 않는다.
 *
 * 만료된 타이머도 0 으로 복구하는 게 계약이지만(§4.7), **무한정** 복구하면 어제 닫은 휴식이
 * 오늘 다시 뜬다. 특히 닫을 때 삭제가 실패하면 그 낡은 기록이 그대로 남는다 — 그래서 시간이
 * 마지막 방어선이다.
 *
 * 값은 새로 만들지 않고 **휴식 상한을 그대로 쓴다**: 최대 휴식 하나만큼 더 지났으면 그건
 * 지금 하고 있는 휴식이 아니다.
 */
export const REST_TIMER_STALE_AFTER_MS = REST_MAX_SEC * 1000;

/** `syncMeta.value` 에 JSON 으로 들어가는 모양. 화면 복구에 필요한 최소치만 담는다. */
export type StoredRestTimer = {
  v: number;
  session_id: string;
  planned_set_id: string;
  /** "벤치프레스 2세트 후 휴식". 로컬 표시용이고 **알림에는 절대 싣지 않는다**. */
  title: string;
  total_sec: number;
  ends_at: number;
};

export function restTimerKeyFor(sessionId: string): string {
  return `${REST_TIMER_PREFIX}${sessionId}`;
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * 저장된 값을 레코드로 해석한다. **모르는 모양은 전부 거절한다** — 손상된 값이나 다른 세션의
 * 기록을 화면에 올리는 것보다 타이머를 잃는 편이 낫다.
 *
 * @param sessionId 지금 열려 있는 세션. 레코드가 이 세션 것이 아니면 거절한다.
 */
export function parseStoredRestTimer(
  raw: string | undefined,
  sessionId: string,
): StoredRestTimer | null {
  if (raw === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record.v !== REST_TIMER_RECORD_VERSION) return null;
  if (!isNonEmptyString(record.session_id) || record.session_id !== sessionId) return null;
  if (!isNonEmptyString(record.planned_set_id)) return null;
  if (!isNonEmptyString(record.title)) return null;
  if (!isPositiveInt(record.ends_at)) return null;
  // 총시간은 0 이 될 수 있다(rest_sec 0). 상한을 넘는 값은 저장된 적이 없어야 한다.
  if (
    typeof record.total_sec !== "number" ||
    !Number.isInteger(record.total_sec) ||
    record.total_sec < 0 ||
    record.total_sec > REST_MAX_SEC
  )
    return null;

  return {
    v: record.v,
    session_id: record.session_id,
    planned_set_id: record.planned_set_id,
    title: record.title,
    total_sec: record.total_sec,
    ends_at: record.ends_at,
  };
}

/** 너무 오래 지난 기록인가. 만료 자체는 정상(0 으로 복구)이고, **지나치게** 오래된 것만 버린다. */
export function isStaleRestTimer(record: StoredRestTimer, now: number): boolean {
  return now >= record.ends_at + REST_TIMER_STALE_AFTER_MS;
}

/**
 * 타이머를 저장한다. 실패는 삼킨다 — 지속은 부가 기능이고, 여기서 던지면 세트 기록이 막힌다.
 * @returns 실제로 저장됐는지(호출부가 판단에 쓰지는 않는다. 테스트용 신호다.)
 */
export async function saveRestTimer(
  userId: string,
  sessionId: string,
  plannedSetId: string,
  title: string,
  timer: RestTimer,
): Promise<boolean> {
  const record: StoredRestTimer = {
    v: REST_TIMER_RECORD_VERSION,
    session_id: sessionId,
    planned_set_id: plannedSetId,
    title,
    total_sec: timer.totalSec,
    ends_at: timer.endsAt,
  };
  try {
    await sessionDb.syncMeta.put({
      user_id: userId,
      key: restTimerKeyFor(sessionId),
      value: JSON.stringify(record),
    });
    return true;
  } catch {
    return false;
  }
}

/** 타이머 기록을 지운다. 실패는 삼킨다 — 남더라도 만료·검증 단계가 다시 걸러낸다. */
export async function clearRestTimer(userId: string, sessionId: string): Promise<void> {
  try {
    await sessionDb.syncMeta.delete([userId, restTimerKeyFor(sessionId)]);
  } catch {
    // 다음 복구 시도에서 stale 로 걸린다.
  }
}

export type RehydratedRestTimer = {
  plannedSetId: string;
  title: string;
  timer: RestTimer;
};

/**
 * 열려 있는 세션의 타이머를 복구한다.
 *
 * 만료된 타이머도 **그대로** 돌려준다 — 화면이 0 으로 표시하고 자동으로 닫지 않는 것이 계약이다.
 * 거절한 기록(다른 세션·손상·모르는 버전·너무 오래됨)은 그 자리에서 지운다.
 */
export async function loadRestTimer(
  userId: string,
  sessionId: string,
  now: number,
): Promise<RehydratedRestTimer | null> {
  let raw: string | undefined;
  try {
    raw = (await sessionDb.syncMeta.get([userId, restTimerKeyFor(sessionId)]))?.value;
  } catch {
    return null;
  }
  if (raw === undefined) return null;

  const record = parseStoredRestTimer(raw, sessionId);
  if (!record || isStaleRestTimer(record, now)) {
    await clearRestTimer(userId, sessionId);
    return null;
  }

  return {
    plannedSetId: record.planned_set_id,
    title: record.title,
    timer: { totalSec: record.total_sec, endsAt: record.ends_at },
  };
}

/** 화면이 쓰는 기본 스코프 바인딩. 사용자 스코프는 앱 전체에서 하나다. */
export const restTimerStore = {
  save: (sessionId: string, plannedSetId: string, title: string, timer: RestTimer) =>
    saveRestTimer(DEV_USER_SCOPE, sessionId, plannedSetId, title, timer),
  clear: (sessionId: string) => clearRestTimer(DEV_USER_SCOPE, sessionId),
  load: (sessionId: string, now: number) => loadRestTimer(DEV_USER_SCOPE, sessionId, now),
};
