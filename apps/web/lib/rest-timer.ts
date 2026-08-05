/**
 * 휴식 타이머 순수 계산(FEATURES_UX F2/F3/F4, UX_STATES §4).
 *
 * 단일 진실값은 `endsAt`(절대 시각)이다 — 틱마다 남은 시간을 감산하지 않는다.
 * 그래야 탭 전환·백그라운드 스로틀·bfcache 복귀에서도 값이 어긋나지 않는다.
 * setInterval·DOM·포커스는 컴포넌트가 맡고, 여기는 계산만 한다.
 */

/** 휴식 상한 10분(F3 "합리적 상한"). 남은 시간 기준이다(UX_STATES §4.5). */
export const REST_MAX_SEC = 600;

/** 스크린리더에 알릴 남은 시간 마일스톤(UX_STATES §7.4). 매초 낭독 금지. */
export const MILESTONE_SEC = [60, 30, 10, 0];

export type RestTimer = {
  /** 현재 총 휴식 시간(초). 진행 바의 분모이고, 시간 가산 시 갱신된다. */
  totalSec: number;
  /** 종료 절대 시각(epoch ms). */
  endsAt: number;
};

function clampRest(sec: number): number {
  return Math.min(REST_MAX_SEC, Math.max(0, sec));
}

/** 세트 완료 체크 시점의 타이머를 만든다. 추천값 = planned_set.rest_sec. */
export function startRest(restSec: number, now: number): RestTimer {
  const totalSec = clampRest(Math.floor(restSec));
  return { totalSec, endsAt: now + totalSec * 1000 };
}

/**
 * 남은 시간(초). 0에서 멈추고(카운트업 없음), 시계 되돌림 같은 이상값은
 * 총시간으로 잘라낸다(UX_STATES §4.7/§4.8).
 */
export function remainingSec(timer: RestTimer, now: number): number {
  return Math.min(timer.totalSec, Math.max(0, Math.ceil((timer.endsAt - now) / 1000)));
}

/** 진행 바 값. 100%에서 0%로 줄어든다. 분모는 **현재** totalSec다. */
export function remainingPercent(timer: RestTimer, now: number): number {
  if (timer.totalSec <= 0) return 0;
  return (remainingSec(timer, now) / timer.totalSec) * 100;
}

export function isFinished(timer: RestTimer, now: number): boolean {
  return remainingSec(timer, now) <= 0;
}

/** 남은 시간이 상한에 닿았는지(=+버튼을 더 눌러도 늘지 않는지). */
export function isAtCap(timer: RestTimer, now: number): boolean {
  return remainingSec(timer, now) >= REST_MAX_SEC;
}

export type AddRestResult = {
  timer: RestTimer;
  /** 요청한 만큼 다 더하지 못했다(상한). 안내 문구 1회 노출용. */
  capped: boolean;
};

/**
 * 휴식 시간 가산(F3). 연타는 그대로 누적된다(디바운스 없음).
 * 상한에 걸리면 요청을 무시하지 않고 **가능한 만큼만** 더한다.
 * total_new = elapsed + remaining_new 이므로 진행 바 비율이 즉시 위로 점프한다.
 */
export function addRest(timer: RestTimer, deltaSec: number, now: number): AddRestResult {
  const remaining = remainingSec(timer, now);
  const elapsed = timer.totalSec - remaining;
  const nextRemaining = clampRest(remaining + deltaSec);
  return {
    timer: { totalSec: elapsed + nextRemaining, endsAt: now + nextRemaining * 1000 },
    capped: remaining + deltaSec > REST_MAX_SEC,
  };
}

/** 카운트다운 표기: 분:초, 초는 2자리 zero-pad(UX_STATES §4.3). */
export function formatCountdown(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 낭독용 한국어 표기: "1분 30초". */
export function formatDurationKo(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const min = Math.floor(total / 60);
  const rest = total % 60;
  if (min === 0) return `${rest}초`;
  if (rest === 0) return `${min}분`;
  return `${min}분 ${rest}초`;
}

/** 마일스톤에 도달한 순간에만 낭독 문구를 준다. 그 외에는 null. */
export function milestoneMessage(sec: number): string | null {
  if (!MILESTONE_SEC.includes(sec)) return null;
  if (sec === 0) return "휴식 완료";
  return `${formatDurationKo(sec)} 남음`;
}
