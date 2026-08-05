/**
 * 휴식 타이머 순수 로직 계약(F2/F3/F4, UX_STATES §4).
 * 시간은 전부 인자로 주입하므로 가짜 타이머가 필요 없다.
 */
import { describe, expect, it } from "vitest";
import {
  addRest,
  formatCountdown,
  formatDurationKo,
  isAtCap,
  isFinished,
  milestoneMessage,
  REST_MAX_SEC,
  remainingPercent,
  remainingSec,
  startRest,
} from "../lib/rest-timer";

const T0 = 1_700_000_000_000;

describe("startRest", () => {
  it("rest_sec 를 총시간으로 잡고 종료 시각을 절대값으로 고정한다", () => {
    const timer = startRest(90, T0);
    expect(timer).toEqual({ totalSec: 90, endsAt: T0 + 90_000 });
  });

  it("10분을 넘는 추천값은 상한으로 잘라낸다", () => {
    expect(startRest(900, T0).totalSec).toBe(REST_MAX_SEC);
  });

  it("음수는 0으로 잘라낸다", () => {
    expect(startRest(-30, T0)).toEqual({ totalSec: 0, endsAt: T0 });
  });
});

describe("remainingSec", () => {
  it("경과한 만큼 줄어든다(백그라운드 60초 후 복귀 = 정확히 60초 감소, AC-T-6)", () => {
    const timer = startRest(180, T0);
    expect(remainingSec(timer, T0)).toBe(180);
    expect(remainingSec(timer, T0 + 60_000)).toBe(120);
  });

  it("0에서 멈춘다 — 초과해도 음수로 가지 않는다(AC-T-7)", () => {
    const timer = startRest(90, T0);
    expect(remainingSec(timer, T0 + 300_000)).toBe(0);
    expect(isFinished(timer, T0 + 300_000)).toBe(true);
  });

  it("시계가 되돌아가도 총시간을 넘지 않는다(§4.8)", () => {
    const timer = startRest(90, T0);
    expect(remainingSec(timer, T0 - 60_000)).toBe(90);
  });

  it("남은 시간을 올림한다 — 0.2초 남았으면 1초로 보인다", () => {
    const timer = startRest(90, T0);
    expect(remainingSec(timer, T0 + 89_800)).toBe(1);
  });
});

describe("remainingPercent (진행 바)", () => {
  it("시작 100%, 절반 50%, 종료 0% 로 단조 감소한다(AC-T-2)", () => {
    const timer = startRest(120, T0);
    expect(remainingPercent(timer, T0)).toBe(100);
    expect(remainingPercent(timer, T0 + 60_000)).toBe(50);
    expect(remainingPercent(timer, T0 + 120_000)).toBe(0);
  });

  it("총시간이 0이어도 NaN 을 만들지 않는다", () => {
    expect(remainingPercent(startRest(0, T0), T0)).toBe(0);
  });
});

describe("addRest (F3 시간 증가)", () => {
  it("+30초 3연타 = 남은 시간 정확히 +90초(AC-T-3)", () => {
    let timer = startRest(90, T0);
    const now = T0 + 30_000; // 60초 남음
    for (let i = 0; i < 3; i += 1) timer = addRest(timer, 30, now).timer;
    expect(remainingSec(timer, now)).toBe(150);
  });

  it("총시간 = 경과 + 새 남은 시간 이라서 진행 바 분모가 갱신된다", () => {
    const timer = startRest(90, T0);
    const now = T0 + 30_000; // 경과 30, 남은 60
    const next = addRest(timer, 30, now).timer;
    expect(next.totalSec).toBe(120);
    // 분모를 옛 총시간(90)으로 쓰면 100% 를 넘겨버린다. 새 총시간 기준이면 90/120.
    expect(remainingPercent(next, now)).toBe(75);
  });

  it("가산 직후 비율이 즉시 위로 점프한다", () => {
    const timer = startRest(90, T0);
    const now = T0 + 60_000; // 30초 남음 → 33.3%
    const before = remainingPercent(timer, now);
    const after = remainingPercent(addRest(timer, 60, now).timer, now);
    expect(before).toBeCloseTo(33.33, 1);
    expect(after).toBeCloseTo(60, 5); // 90 남음 / 총 150
    expect(after).toBeGreaterThan(before);
  });

  it("상한 590초 + 1분 = 600초로 잘리고 capped 를 알린다(AC-T-4)", () => {
    const timer = startRest(590, T0);
    const result = addRest(timer, 60, T0);
    expect(remainingSec(result.timer, T0)).toBe(REST_MAX_SEC);
    expect(result.capped).toBe(true);
    expect(isAtCap(result.timer, T0)).toBe(true);
  });

  it("상한에서 더 눌러도 600초를 유지한다", () => {
    const capped = addRest(startRest(600, T0), 30, T0);
    expect(remainingSec(capped.timer, T0)).toBe(REST_MAX_SEC);
    expect(capped.capped).toBe(true);
  });

  it("상한에 닿지 않으면 capped 는 false 다", () => {
    expect(addRest(startRest(90, T0), 60, T0).capped).toBe(false);
  });

  it("가산은 남은 시간 기준이라 경과 시간이 있어도 상한을 넘기지 않는다", () => {
    const timer = startRest(600, T0);
    const now = T0 + 100_000; // 500초 남음(총 600)
    const result = addRest(timer, 300, now);
    expect(remainingSec(result.timer, now)).toBe(REST_MAX_SEC);
    expect(result.timer.totalSec).toBe(700); // 경과 100 + 남은 600
  });
});

describe("표기", () => {
  it("분:초, 초는 2자리(AC-T-1)", () => {
    expect(formatCountdown(90)).toBe("1:30");
    expect(formatCountdown(7)).toBe("0:07");
    expect(formatCountdown(45)).toBe("0:45");
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });

  it("낭독용 한국어 표기", () => {
    expect(formatDurationKo(90)).toBe("1분 30초");
    expect(formatDurationKo(120)).toBe("2분");
    expect(formatDurationKo(45)).toBe("45초");
    expect(formatDurationKo(0)).toBe("0초");
  });

  it("마일스톤에서만 낭독 문구를 준다(AC-A-3)", () => {
    expect(milestoneMessage(60)).toBe("1분 남음");
    expect(milestoneMessage(30)).toBe("30초 남음");
    expect(milestoneMessage(10)).toBe("10초 남음");
    expect(milestoneMessage(0)).toBe("휴식 완료");
    expect(milestoneMessage(59)).toBeNull();
    expect(milestoneMessage(11)).toBeNull();
  });
});
