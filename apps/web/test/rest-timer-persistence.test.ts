/**
 * 휴식 타이머 지속·복구 계약.
 *
 * 사용자는 휴식 중에 화면을 끄고 다른 앱으로 넘어간다. 그래서 "돌아왔더니 타이머가 없다"가
 * 이 기능의 진짜 실패 모드다. 여기서는 **새 Dexie 인스턴스**로 앱 강제 종료까지 모사한다.
 *
 * 동시에 **절대 건드리면 안 되는 것**이 있다: `drafts`·`outbox`·`sessions` 와 F-4b 의
 * `assistance-remediation:` marker. 사용자가 실제로 한 기록과 안전 경계다.
 * 그래서 byte 단위로 같은지 본다.
 */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEV_USER_SCOPE,
  MARKER_PREFIX,
  REMEDIATION_PENDING,
  markerKeyFor,
  remediationStateFor,
  sessionDb,
} from "../components/session/session-db";
import {
  REST_TIMER_PREFIX,
  REST_TIMER_RECORD_VERSION,
  REST_TIMER_STALE_AFTER_MS,
  clearRestTimer,
  isStaleRestTimer,
  loadRestTimer,
  parseStoredRestTimer,
  restTimerKeyFor,
  saveRestTimer,
} from "../components/session/rest-timer-store";
import { REST_MAX_SEC, addRest, remainingSec, startRest } from "../lib/rest-timer";

const USER = DEV_USER_SCOPE;
const SESSION = "s-1";
const OTHER_SESSION = "s-2";
const SET = "ps-1";
const TITLE = "벤치프레스 2세트 후 휴식";
const T0 = 1_700_000_000_000;

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});

/** 사용자의 기록. 이 티켓은 이걸 한 바이트도 건드리면 안 된다. */
async function seedUserData() {
  await sessionDb.drafts.put({
    user_id: USER,
    session_id: SESSION,
    planned_set_id: SET,
    weight: 60,
    reps: 8,
    rir: 2,
    time_sec: null,
    completed: true,
    updated_at: "2026-08-14T08:00:00.000Z",
  } as never);
  await sessionDb.outbox.put({
    client_id: "c-1",
    user_id: USER,
    entity: "performed_set",
    entity_id: SET,
    op: "upsert",
    updated_at: "2026-08-14T08:00:00.000Z",
    payload: { actual_weight: 60, actual_reps: 8 },
    request_started_at: 0,
  } as never);
  await sessionDb.sessions.put({
    user_id: USER,
    session_id: SESSION,
    session: { id: SESSION, status: "in_progress", planned_sets: [] },
    updated_at: "2026-08-14T08:00:00.000Z",
  } as never);
}

/** 세 store 를 통째로 직렬화한다 — 필드 하나가 바뀌어도 문자열이 달라진다. */
async function userDataBytes(): Promise<string> {
  return JSON.stringify([
    await sessionDb.drafts.toArray(),
    await sessionDb.outbox.toArray(),
    await sessionDb.sessions.toArray(),
  ]);
}

describe("네임스페이스 — F-4b marker 와 섞이지 않는다", () => {
  it("키 접두사가 서로 다르다", () => {
    expect(REST_TIMER_PREFIX).toBe("rest-timer:");
    expect(restTimerKeyFor(SESSION).startsWith(MARKER_PREFIX)).toBe(false);
    expect(markerKeyFor(SESSION).startsWith(REST_TIMER_PREFIX)).toBe(false);
  });

  it("타이머를 저장해도 remediation 상태는 그대로다", async () => {
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: markerKeyFor(SESSION),
      value: REMEDIATION_PENDING,
    });

    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));

    expect(await remediationStateFor(USER, SESSION)).toBe("refetch");
    expect(await sessionDb.syncMeta.count()).toBe(2);
  });

  it("타이머를 지워도 marker 는 남는다", async () => {
    await sessionDb.syncMeta.put({
      user_id: USER,
      key: markerKeyFor(SESSION),
      value: REMEDIATION_PENDING,
    });
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));

    await clearRestTimer(USER, SESSION);

    expect(await remediationStateFor(USER, SESSION)).toBe("refetch");
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)])).toBeUndefined();
  });
});

describe("복구 — 시계가 흐른 만큼만 줄어든다", () => {
  it("40초 뒤에 복구하면 남은 시간이 정확히 40초 줄어 있다", async () => {
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));

    const restored = await loadRestTimer(USER, SESSION, T0 + 40_000);

    expect(restored).toEqual({
      plannedSetId: SET,
      title: TITLE,
      timer: { totalSec: 90, endsAt: T0 + 90_000 },
    });
    expect(remainingSec(restored!.timer, T0 + 40_000)).toBe(50);
  });

  it("만료된 타이머도 0 으로 복구한다 — 버리지 않는다", async () => {
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));

    const restored = await loadRestTimer(USER, SESSION, T0 + 120_000);

    expect(restored).not.toBeNull();
    expect(remainingSec(restored!.timer, T0 + 120_000)).toBe(0);
  });

  it("+초로 늘린 뒤 저장하면 새 endsAt 으로 복구한다", async () => {
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));
    await saveRestTimer(USER, SESSION, SET, TITLE, { totalSec: 120, endsAt: T0 + 120_000 });

    const restored = await loadRestTimer(USER, SESSION, T0 + 40_000);

    expect(restored!.timer).toEqual({ totalSec: 120, endsAt: T0 + 120_000 });
    expect(remainingSec(restored!.timer, T0 + 40_000)).toBe(80);
  });

  it("저장된 것이 없으면 null 이다", async () => {
    expect(await loadRestTimer(USER, SESSION, T0)).toBeNull();
  });

  /**
   * **연장 누적은 남은 시간 상한을 넘는다.** `addRest` 는 `totalSec = elapsed + nextRemaining`
   * 이므로 600초 휴식에서 100초를 보낸 뒤 300초를 더하면 남은 시간 600 · 총시간 **700** 이다
   * (`session-rest-timer.test.ts` 가 이미 고정한 계약).
   *
   * 첫 판은 `total_sec > 600` 을 손상으로 보고 **정상 타이머를 지웠다.** 그래서 이 왕복이
   * 새 Dexie 인스턴스까지 살아남는지 본다.
   */
  it("600초에서 100초 경과 후 +300 한 700초 타이머가 새 DB 인스턴스에서 그대로 복구된다", async () => {
    const started = startRest(REST_MAX_SEC, T0);
    const extended = addRest(started, 300, T0 + 100_000);
    expect(extended.timer.totalSec).toBe(700);
    expect(remainingSec(extended.timer, T0 + 100_000)).toBe(REST_MAX_SEC);

    await saveRestTimer(USER, SESSION, SET, TITLE, extended.timer);

    sessionDb.close();
    const reopened = new Dexie("afc-session-v1");
    await reopened.open();
    reopened.close();
    await sessionDb.open();

    const restored = await loadRestTimer(USER, SESSION, T0 + 200_000);
    expect(restored).not.toBeNull();
    expect(restored!.timer).toEqual(extended.timer);
    expect(remainingSec(restored!.timer, T0 + 200_000)).toBe(500);
    // 지워지지 않았다.
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)])).toBeDefined();
  });

  it("연장을 여러 번 누적해도(총 1500초) 거절하지 않는다", async () => {
    let timer = startRest(REST_MAX_SEC, T0);
    for (let step = 1; step <= 3; step += 1) {
      timer = addRest(timer, 300, T0 + step * 300_000).timer;
    }
    expect(timer.totalSec).toBeGreaterThan(REST_MAX_SEC);

    await saveRestTimer(USER, SESSION, SET, TITLE, timer);

    expect((await loadRestTimer(USER, SESSION, T0 + 900_000))!.timer).toEqual(timer);
  });
});

/**
 * **두 값이 각각 통과해도 조합이 불가능하면 손상이다.**
 *
 * `total_sec` 과 `ends_at` 을 따로만 보면 "1초짜리인데 1년 뒤에 끝나는" 좀비가 통과한다.
 * 화면에는 1초가 1년 동안 줄지 않고 뜨고 stale 도 되지 않는다.
 *
 * 기준점은 `saved_at` 이다 — **쓰인 그 순간에 불가능했는지**만 본다. 저장 뒤의 시계 되돌림은
 * 손상이 아니라 표시 문제이고 `remainingSec` 의 clamp 가 이미 다룬다(UX_STATES §4.8).
 */
describe("시간 관계 — 불가능한 조합은 거절한다", () => {
  const record = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      v: REST_TIMER_RECORD_VERSION,
      session_id: SESSION,
      planned_set_id: SET,
      title: TITLE,
      total_sec: 90,
      ends_at: T0 + 90_000,
      saved_at: T0,
      ...overrides,
    });

  it("1초짜리인데 1년 뒤에 끝나는 좀비를 거절한다", () => {
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    expect(
      parseStoredRestTimer(record({ total_sec: 1, ends_at: T0 + oneYear }), SESSION),
    ).toBeNull();
  });

  it("시작 시각이 저장 시점보다 미래면 거절한다", () => {
    // 저장할 때 이미 "아직 시작도 안 한" 타이머 — 있을 수 없다.
    expect(
      parseStoredRestTimer(record({ total_sec: 60, ends_at: T0 + 120_000 }), SESSION),
    ).toBeNull();
  });

  it("시작 시각이 epoch 이전이면 거절한다 — total 이 터무니없다", () => {
    expect(
      parseStoredRestTimer(record({ total_sec: 2_000_000_000, ends_at: T0 + 1_000 }), SESSION),
    ).toBeNull();
  });

  it("경계: 시작 시각이 저장 시점과 같으면 통과한다", () => {
    expect(
      parseStoredRestTimer(record({ total_sec: 90, ends_at: T0 + 90_000 }), SESSION),
    ).not.toBeNull();
  });

  it("경계: 1ms 라도 미래면 거절한다", () => {
    expect(
      parseStoredRestTimer(record({ total_sec: 90, ends_at: T0 + 90_001 }), SESSION),
    ).toBeNull();
  });

  it("**정상 700·1500 누적은 그대로 통과한다** — 새 상한을 만들지 않았다", () => {
    let timer = startRest(REST_MAX_SEC, T0);
    const extended = addRest(timer, 300, T0 + 100_000).timer;
    expect(extended.totalSec).toBe(700);
    expect(
      parseStoredRestTimer(
        record({ total_sec: extended.totalSec, ends_at: extended.endsAt, saved_at: T0 + 100_000 }),
        SESSION,
      ),
    ).not.toBeNull();

    let savedAt = T0;
    for (let step = 1; step <= 3; step += 1) {
      savedAt = T0 + step * 300_000;
      timer = addRest(timer, 300, savedAt).timer;
    }
    expect(timer.totalSec).toBe(1500);
    expect(
      parseStoredRestTimer(
        record({ total_sec: timer.totalSec, ends_at: timer.endsAt, saved_at: savedAt }),
        SESSION,
      ),
    ).not.toBeNull();
  });

  it("저장 뒤 시계가 되돌아간 것은 **거절하지 않는다** — 표시만 clamp 한다", async () => {
    // 저장은 정상이었다. 읽는 시점의 시계만 과거로 갔다.
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0), T0);

    const restored = await loadRestTimer(USER, SESSION, T0 - 60_000);

    expect(restored).not.toBeNull();
    // remainingSec 이 totalSec 으로 잘라 준다(§4.8).
    expect(remainingSec(restored!.timer, T0 - 60_000)).toBe(90);
  });
});

describe("강제 종료 모사 — 새 Dexie 인스턴스", () => {
  it("DB 를 닫았다 다시 열어도 타이머가 살아 있고, 기록은 한 바이트도 안 바뀐다", async () => {
    await seedUserData();
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(180, T0));
    const before = await userDataBytes();

    // OS 가 프로세스를 죽인 상황: 열려 있던 연결이 사라지고 새 연결이 열린다.
    sessionDb.close();
    const reopened = new Dexie("afc-session-v1");
    await reopened.open();
    reopened.close();
    await sessionDb.open();

    const restored = await loadRestTimer(USER, SESSION, T0 + 60_000);
    expect(restored!.timer).toEqual({ totalSec: 180, endsAt: T0 + 180_000 });
    expect(remainingSec(restored!.timer, T0 + 60_000)).toBe(120);

    // 사용자의 기록은 이 기능과 무관하다.
    expect(await userDataBytes()).toBe(before);
  });

  it("저장·복구 왕복이 drafts/outbox/sessions 를 바꾸지 않는다", async () => {
    await seedUserData();
    const before = await userDataBytes();

    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));
    await loadRestTimer(USER, SESSION, T0 + 10_000);
    await clearRestTimer(USER, SESSION);

    expect(await userDataBytes()).toBe(before);
  });
});

describe("fail closed — 남의 것·손상된 것은 화면에 올리지 않는다", () => {
  const put = (value: string, key = restTimerKeyFor(SESSION)) =>
    sessionDb.syncMeta.put({ user_id: USER, key, value });

  it("다른 세션의 기록은 가져오지 않는다", async () => {
    await saveRestTimer(USER, OTHER_SESSION, SET, TITLE, startRest(90, T0));

    expect(await loadRestTimer(USER, SESSION, T0 + 10_000)).toBeNull();
    // 남의 세션 기록을 지우지도 않는다.
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(OTHER_SESSION)])).toBeDefined();
  });

  it("키는 이 세션인데 안의 session_id 가 다르면 거절하고 지운다", async () => {
    await put(
      JSON.stringify({
        v: REST_TIMER_RECORD_VERSION,
        session_id: OTHER_SESSION,
        planned_set_id: SET,
        title: TITLE,
        total_sec: 90,
        ends_at: T0 + 90_000,
        saved_at: T0,
      }),
    );

    expect(await loadRestTimer(USER, SESSION, T0)).toBeNull();
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)])).toBeUndefined();
  });

  it.each([
    ["JSON 아님", "not json"],
    ["빈 객체", "{}"],
    ["배열", "[]"],
    ["null", "null"],
    ["문자열", '"nope"'],
  ])("%s 은 거절한다", async (_label, raw) => {
    await put(raw);
    expect(await loadRestTimer(USER, SESSION, T0)).toBeNull();
  });

  it.each([
    ["모르는 버전", { v: 99 }],
    ["옛 버전(v1)", { v: 1 }],
    ["버전 없음", { v: undefined }],
    ["planned_set_id 없음", { planned_set_id: "" }],
    ["title 없음", { title: "" }],
    ["ends_at 이 문자열", { ends_at: "later" }],
    ["ends_at 이 0", { ends_at: 0 }],
    ["total_sec 음수", { total_sec: -1 }],
    ["total_sec 0 — 진행 바 분모가 0 이다", { total_sec: 0 }],
    ["total_sec 이 안전정수 초과", { total_sec: Number.MAX_SAFE_INTEGER }],
    ["saved_at 없음(v1 잔재)", { saved_at: undefined }],
    ["saved_at 이 0", { saved_at: 0 }],
    ["saved_at 이 NaN", { saved_at: Number.NaN }],
    ["total_sec 이 소수", { total_sec: 1.5 }],
    ["total_sec 이 NaN", { total_sec: Number.NaN }],
    ["total_sec 이 Infinity", { total_sec: Number.POSITIVE_INFINITY }],
    ["ends_at 이 NaN", { ends_at: Number.NaN }],
    ["ends_at 이 음수", { ends_at: -1 }],
    ["ends_at 이 안전정수 초과", { ends_at: Number.MAX_SAFE_INTEGER + 2 }],
  ])("%s 인 레코드는 거절한다", async (_label, override) => {
    const record: Record<string, unknown> = {
      v: REST_TIMER_RECORD_VERSION,
      session_id: SESSION,
      planned_set_id: SET,
      title: TITLE,
      total_sec: 90,
      ends_at: T0 + 90_000,
      saved_at: T0,
      ...override,
    };
    expect(parseStoredRestTimer(JSON.stringify(record), SESSION)).toBeNull();
  });

  it("거절한 기록은 그 자리에서 지운다 — 다음 마운트에서 또 만나지 않는다", async () => {
    await put('{"v":99}');

    await loadRestTimer(USER, SESSION, T0);

    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)])).toBeUndefined();
  });
});

describe("stale — 너무 오래된 기록은 복구하지 않는다", () => {
  const record = {
    v: REST_TIMER_RECORD_VERSION,
    session_id: SESSION,
    planned_set_id: SET,
    title: TITLE,
    total_sec: 90,
    ends_at: T0 + 90_000,
    saved_at: T0,
  };

  it("상한은 휴식 상한(10분)과 같다 — 새 숫자를 만들지 않는다", () => {
    expect(REST_TIMER_STALE_AFTER_MS).toBe(600_000);
  });

  it("경계 직전은 살아 있고 경계에서 죽는다", () => {
    const endsAt = record.ends_at;
    expect(isStaleRestTimer(record, endsAt + REST_TIMER_STALE_AFTER_MS - 1)).toBe(false);
    expect(isStaleRestTimer(record, endsAt + REST_TIMER_STALE_AFTER_MS)).toBe(true);
  });

  it("어제 닫다 만 타이머는 복구하지 않고 지운다", async () => {
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));

    expect(await loadRestTimer(USER, SESSION, T0 + 86_400_000)).toBeNull();
    expect(await sessionDb.syncMeta.get([USER, restTimerKeyFor(SESSION)])).toBeUndefined();
  });
});

describe("정리 — 닫기·완료 취소·세션 종료", () => {
  it("지우면 복구되지 않는다", async () => {
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));

    await clearRestTimer(USER, SESSION);

    expect(await loadRestTimer(USER, SESSION, T0 + 10_000)).toBeNull();
  });

  it("없는 것을 지워도 던지지 않는다", async () => {
    // 지울 것이 없는 것도 "정리됐다"이다.
    await expect(clearRestTimer(USER, SESSION)).resolves.toBe(true);
  });

  it("한 세션을 지워도 다른 세션 타이머는 남는다", async () => {
    await saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0));
    await saveRestTimer(USER, OTHER_SESSION, SET, TITLE, startRest(90, T0));

    await clearRestTimer(USER, SESSION);

    expect(await loadRestTimer(USER, OTHER_SESSION, T0 + 10_000)).not.toBeNull();
  });
});

describe("저장 실패는 기록을 막지 않는다", () => {
  it("syncMeta 쓰기가 던져도 false 를 돌려줄 뿐이다", async () => {
    sessionDb.close();

    await expect(saveRestTimer(USER, SESSION, SET, TITLE, startRest(90, T0))).resolves.toBe(false);

    await sessionDb.open();
  });

  it("읽기가 던져도 null 이다", async () => {
    sessionDb.close();

    await expect(loadRestTimer(USER, SESSION, T0)).resolves.toBeNull();

    await sessionDb.open();
  });

  it("지우기가 던져도 예외가 새지 않는다", async () => {
    sessionDb.close();

    await expect(clearRestTimer(USER, SESSION)).resolves.toBe(false);

    await sessionDb.open();
  });
});
