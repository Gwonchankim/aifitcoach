/**
 * F6-1: 당일 판정은 **서버와 같은 기준(UTC)** 이어야 한다.
 * 로컬 시간대로 판정하면 KST 00:00~09:00 구간에서 화면과 서버(409)가 어긋난다.
 */
import { describe, expect, it } from "vitest";
import { isUtcToday, utcDateString } from "../lib/utc-day";

describe("utcDateString", () => {
  it("UTC 날짜를 쓴다(로컬 시간대가 아니다)", () => {
    // KST 로 보면 2026-08-06 09:00, UTC 로 보면 2026-08-06 00:00 — 같은 날이다.
    expect(utcDateString(new Date("2026-08-06T00:00:00Z"))).toBe("2026-08-06");
    // KST 로 보면 2026-08-06 08:59 이지만 UTC 로는 아직 8월 5일이다.
    expect(utcDateString(new Date("2026-08-05T23:59:00Z"))).toBe("2026-08-05");
  });
});

describe("isUtcToday", () => {
  it("KST 자정 직후(= UTC 전날 15시)는 아직 UTC 어제다", () => {
    const kstJustAfterMidnight = new Date("2026-08-05T15:00:00Z"); // KST 2026-08-06 00:00
    expect(isUtcToday("2026-08-05", kstJustAfterMidnight)).toBe(true);
    expect(isUtcToday("2026-08-06", kstJustAfterMidnight)).toBe(false);
  });

  it("다른 날짜의 세션은 오늘이 아니다", () => {
    const now = new Date("2026-08-05T10:00:00Z");
    expect(isUtcToday("2026-08-04", now)).toBe(false);
    expect(isUtcToday("2026-08-05", now)).toBe(true);
    expect(isUtcToday("2026-08-06", now)).toBe(false);
  });

  /**
   * 테스트 고정값(NEXT_PUBLIC_AFC_TEST_TODAY)이 없는 빌드에서는 실제 오늘을 쓴다.
   * 이 값은 빌드 시점에 인라인되므로 여기서는 "설정되지 않은 기본 빌드"의 동작만 고정한다 —
   * 고정값이 켜져 있는데 이 테스트가 통과하면 프로덕션 빌드에 테스트 시드가 섞여 들어간 것이다.
   */
  it("고정값이 없으면 실제 오늘을 쓴다(기본 빌드)", () => {
    expect(process.env.NEXT_PUBLIC_AFC_TEST_TODAY).toBeUndefined();
    expect(isUtcToday(utcDateString())).toBe(true);
    expect(isUtcToday("1999-01-01")).toBe(false);
  });
});
