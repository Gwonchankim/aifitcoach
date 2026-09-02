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

/**
 * **세션별 쓰기 큐.** 같은 세션의 save/clear 를 부른 순서대로 커밋한다.
 *
 * 없으면 이런 일이 난다: 사용자가 휴식을 닫는 순간 저장이 아직 날아가는 중이면, 늦게 도착한
 * save 가 방금 지운 레코드를 **되살린다.** 그러면 닫은 타이머가 stale 창 동안 reload 마다
 * 다시 뜬다. 실측으로 재현된다 — IndexedDB 가 부른 순서대로 커밋해 줄 거라고 가정하면 안 된다.
 *
 * 세션마다 독립이라 한 세션의 느린 쓰기가 다른 세션을 막지 않는다.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation);

  // **실패 격리는 여기가 전부다.** 큐에 남기는 것은 `run` 이 아니라 두 결말을 모두 삼킨
  // `settled` 라, 앞 작업이 실패해도 다음 작업은 정상적으로 이어진다. 실패 하나가 이후 clear 를
  // 영영 막으면 그게 곧 지우지 못한 타이머다.
  const settled: Promise<void> = run.then(forget, forget);
  function forget() {
    // 찌꺼기 정리: 내가 꼬리일 때만 지운다. 뒤에 누가 붙었으면 그쪽이 꼬리다.
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  }

  writeQueues.set(key, settled);
  return run;
}

/** 큐에 남은 세션 수. **찌꺼기가 쌓이지 않는다**는 것을 테스트가 확인하는 창구다. */
export function restTimerQueueDepth(): number {
  return writeQueues.size;
}

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
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * 누적 총시간의 계약.
 *
 * **남은 시간 상한(600초)을 여기에 적용하면 안 된다.** `addRest` 는
 * `totalSec = elapsed + nextRemaining` 으로 누적하므로, 600초 휴식에서 100초를 보낸 뒤 300초를
 * 더하면 남은 시간은 600(상한)이고 **총시간은 700**이다. 이건 정상 경로다
 * (`test/session-rest-timer.test.ts` 가 이미 고정하고 있다).
 *
 * 처음 판에서 `> REST_MAX_SEC` 를 거절했더니 그 정상 타이머가 reload 에서 손상 레코드로 판정돼
 * **삭제됐다.** 그래서 여기서는 새 상한을 만들지 않고 안전한 정수·비음수만 본다.
 */
const isSafeTotalSec = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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
  // 총시간은 0 일 수도(rest_sec 0), 600 을 넘을 수도(연장 누적) 있다. 상한을 두지 않는다.
  if (!isSafeTotalSec(record.total_sec)) return null;

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
  return enqueue(restTimerKeyFor(sessionId), async () => {
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
  });
}

/** 타이머 기록을 지운다. 실패는 삼킨다 — 남더라도 만료·검증 단계가 다시 걸러낸다. */
export async function clearRestTimer(userId: string, sessionId: string): Promise<void> {
  await enqueue(restTimerKeyFor(sessionId), () => rawDelete(userId, sessionId));
}

async function rawDelete(userId: string, sessionId: string): Promise<void> {
  try {
    await sessionDb.syncMeta.delete([userId, restTimerKeyFor(sessionId)]);
  } catch {
    // 다음 복구 시도에서 stale 로 걸린다.
  }
}

async function rawRead(userId: string, sessionId: string): Promise<string | undefined> {
  try {
    return (await sessionDb.syncMeta.get([userId, restTimerKeyFor(sessionId)]))?.value;
  } catch {
    return undefined;
  }
}

/**
 * 그 세트의 타이머일 때만 지운다.
 *
 * 완료 취소는 화면에 타이머가 떠 있든 아니든 **저장된 것까지** 정리해야 한다 — 복구가 아직
 * 대기 중이거나 읽기가 잠깐 실패했으면 화면 state 는 비어 있어도 레코드는 남아 있다.
 * 그렇다고 통째로 지우면 **다른 세트의 정상 타이머**를 죽이므로 세트를 대조한다.
 */
export async function clearRestTimerForPlannedSet(
  userId: string,
  sessionId: string,
  plannedSetId: string,
): Promise<void> {
  await enqueue(restTimerKeyFor(sessionId), async () => {
    const raw = await rawRead(userId, sessionId);
    if (raw === undefined) return;
    const record = parseStoredRestTimer(raw, sessionId);
    // 파싱되지 않는 값은 어차피 복구되지 않는다. 여기서는 **남의 세트를 지우지 않는 것**만 본다.
    if (record !== null && record.planned_set_id !== plannedSetId) return;
    await rawDelete(userId, sessionId);
  });
}

/**
 * 오프라인에서 만든 임시 세트 id 가 서버 id 로 승격될 때 저장된 타이머도 함께 옮긴다.
 *
 * 옮기지 않으면 복구가 authoritative 세트 목록과 대조하다 못 찾고 **타이머를 지운다.**
 * 같은 세션 큐 안에서 읽고 쓰므로 그 사이 다른 저장이 끼어들 수 없다.
 *
 * @returns 실제로 옮겼는지
 */
export async function remapRestTimerPlannedSet(
  userId: string,
  sessionId: string,
  fromPlannedSetId: string,
  toPlannedSetId: string,
): Promise<boolean> {
  if (fromPlannedSetId === toPlannedSetId) return false;
  return enqueue(restTimerKeyFor(sessionId), async () => {
    const raw = await rawRead(userId, sessionId);
    if (raw === undefined) return false;
    const record = parseStoredRestTimer(raw, sessionId);
    // 다른 세트의 타이머는 건드리지 않는다.
    if (record === null || record.planned_set_id !== fromPlannedSetId) return false;
    try {
      await sessionDb.syncMeta.put({
        user_id: userId,
        key: restTimerKeyFor(sessionId),
        value: JSON.stringify({ ...record, planned_set_id: toPlannedSetId }),
      });
      return true;
    } catch {
      return false;
    }
  });
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
 *
 * 읽기·판정·조건부 삭제를 **같은 세션 큐 안**에서 한다. 밖에서 하면 읽은 뒤 삭제를 큐에 넣는
 * 사이에 새 저장이 끼어들어, 뒤늦은 삭제가 **방금 저장된 정상 타이머를 지운다.**
 * 그래도 남는 틈(읽기 실패 후 재시도 등)은 `clearIfUnchanged` 의 원문 대조가 막는다.
 */
export async function loadRestTimer(
  userId: string,
  sessionId: string,
  now: number,
): Promise<RehydratedRestTimer | null> {
  return enqueue(restTimerKeyFor(sessionId), async () => {
    const raw = await rawRead(userId, sessionId);
    if (raw === undefined) return null;

    const record = parseStoredRestTimer(raw, sessionId);
    if (!record || isStaleRestTimer(record, now)) {
      // 내가 본 그 값일 때만 지운다.
      if ((await rawRead(userId, sessionId)) === raw) await rawDelete(userId, sessionId);
      return null;
    }

    return {
      plannedSetId: record.planned_set_id,
      title: record.title,
      timer: { totalSec: record.total_sec, endsAt: record.ends_at },
    };
  });
}

/**
 * **복구 시도의 정체성.** 어느 세션을 복구하려 했는지 기억한다.
 *
 * 단순 `useRef(false)` 로는 안 된다. 같은 컴포넌트가 세션 A 에서 B 로 옮겨 가면 그 플래그는
 * 이미 참이라 **B 를 영영 복구하지 않는다.** 반대로 아무 방어가 없으면 A 의 읽기가 늦게 끝나
 * **B 화면에 A 의 타이머가 올라온다.** closure 만으로는 뒤엣것을 막을 수 없다 — 늦게 온 결과가
 * "지금 무엇을 보고 있는지" 를 물어볼 곳이 있어야 한다.
 */
/** 복구 한 번을 가리키는 표. 세션 문자열만으로는 A→B→A 재진입을 구분하지 못한다. */
export type RestoreToken = { sessionId: string; generation: number };

export type RestoreCoordinator = {
  /**
   * 진행 중인 복구를 전부 무효로 만든다. **세션 전환·언마운트·사용자 동작**(새 타이머 저장,
   * 연장, 닫기, 완료 취소, 세션 종료)에서 부른다. 늦게 도착할 결과가 화면에 닿지 못한다.
   */
  invalidate: () => void;
  /** 이 세션 복구를 시작하고 표를 받는다. 이미 이 세대에서 같은 세션을 시작했으면 `null`. */
  begin: (sessionId: string) => RestoreToken | null;
  /** 이 표가 아직 유효한가. 세대가 하나라도 올라갔으면 아니다. */
  isCurrent: (token: RestoreToken) => boolean;
};

/**
 * **복구 시도의 정체성 — 단조 증가 세대로 판정한다.**
 *
 * 세션 문자열 하나만 기억하면 두 가지가 깨진다. ① A→B 로 옮기는 동안 B 의 authoritative
 * 질의가 아직 안 끝났으면 조정자는 여전히 A 를 current 로 보고, 늦게 온 A 결과가 **B 화면에**
 * 올라간다. ② A→B→A 로 돌아오면 **처음 A 요청까지 다시 current** 가 된다.
 *
 * 세대는 되돌아가지 않으므로 한 번 무효가 된 표는 영원히 무효다. 같은 세션을 다시 복구하려면
 * 새 표를 받으면 된다.
 */
export function createRestoreCoordinator(): RestoreCoordinator {
  let generation = 0;
  let current: RestoreToken | null = null;

  return {
    invalidate() {
      generation += 1;
      current = null;
    },
    begin(sessionId) {
      if (current !== null && current.sessionId === sessionId) return null;
      generation += 1;
      current = { sessionId, generation };
      return current;
    },
    isCurrent(token) {
      return current !== null && current.generation === token.generation;
    },
  };
}

/**
 * 복구 한 번의 전체 판단. 화면은 이 함수를 부르고 `apply` 로 받기만 한다.
 *
 * @param token `begin` 이 준 표. 결과를 적용하기 **직전에** 다시 확인한다.
 * @param plannedSetIds 지금 세션의 계획 세트 id. 여기 없는 세트의 타이머는 올릴 자리가 없다.
 */
export async function restoreRestTimer(
  coordinator: RestoreCoordinator,
  token: RestoreToken,
  plannedSetIds: readonly string[],
  now: number,
  apply: (restored: RehydratedRestTimer) => void,
): Promise<void> {
  const stored = await restTimerStore.load(token.sessionId, now);
  // 읽는 사이에 세션이 바뀌었거나 사용자가 무언가 했으면 이 결과는 낡았다.
  if (!coordinator.isCurrent(token) || !stored) return;

  if (!plannedSetIds.includes(stored.plannedSetId)) {
    // 운동이 삭제·교체돼 그 세트가 사라졌다 — 그 세트의 기록만 버린다.
    void restTimerStore.clearForPlannedSet(token.sessionId, stored.plannedSetId);
    return;
  }
  apply(stored);
}

/** 화면이 쓰는 기본 스코프 바인딩. 사용자 스코프는 앱 전체에서 하나다. */
export const restTimerStore = {
  save: (sessionId: string, plannedSetId: string, title: string, timer: RestTimer) =>
    saveRestTimer(DEV_USER_SCOPE, sessionId, plannedSetId, title, timer),
  clear: (sessionId: string) => clearRestTimer(DEV_USER_SCOPE, sessionId),
  clearForPlannedSet: (sessionId: string, plannedSetId: string) =>
    clearRestTimerForPlannedSet(DEV_USER_SCOPE, sessionId, plannedSetId),
  remap: (sessionId: string, fromPlannedSetId: string, toPlannedSetId: string) =>
    remapRestTimerPlannedSet(DEV_USER_SCOPE, sessionId, fromPlannedSetId, toPlannedSetId),
  load: (sessionId: string, now: number) => loadRestTimer(DEV_USER_SCOPE, sessionId, now),
};
