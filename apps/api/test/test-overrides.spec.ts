/**
 * 테스트 전용 오버라이드의 **경계**를 고정한다 — ADR-50, 사람 승인 조건(2026-08-09).
 *
 * 이 스펙이 지키는 것:
 *  1) 오버라이드가 실제로 "오늘"을 바꾼다(안 바뀌면 요일 고정이 무의미하다).
 *  2) **프로덕션에서는 환경변수가 있어도 무조건 무시된다.** opt-in 으로도 못 켠다.
 *  3) 형식이 틀리면 조용히 무시하지 않고 던진다.
 *
 * 2)가 이 파일의 존재 이유다. 시간이 조용히 고정되면 스트릭·주간 볼륨·당일 수정 판정이 전부 틀어지는데
 * 화면은 멀쩡해 보인다 — 운영에서 가장 늦게 발견되는 종류의 사고다.
 */
import { testOverridesAllowed } from "../src/auth/dev-user";
import { TEST_TODAY_ENV, isoDate, testTodayOverride, utcToday } from "../src/common/date/utc-day";

const FIXED = "2026-08-12"; // 수요일

describe("테스트 오버라이드 경계", () => {
  const original = { node: process.env.NODE_ENV, today: process.env[TEST_TODAY_ENV] };

  afterEach(() => {
    process.env.NODE_ENV = original.node;
    if (original.today === undefined) delete process.env[TEST_TODAY_ENV];
    else process.env[TEST_TODAY_ENV] = original.today;
  });

  describe("비프로덕션", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "test";
    });

    it("오늘을 지정한 날짜로 고정한다", () => {
      process.env[TEST_TODAY_ENV] = FIXED;
      expect(isoDate(utcToday())).toBe(FIXED);
    });

    it("설정이 없으면 실제 오늘을 쓴다", () => {
      delete process.env[TEST_TODAY_ENV];
      expect(testTodayOverride()).toBeNull();
      const now = new Date();
      expect(isoDate(utcToday())).toBe(
        `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`,
      );
    });

    it.each(["2026/08/12", "20260812", "오늘", "2026-13-01"])(
      "형식이 틀리면 조용히 무시하지 않고 던진다: %s",
      (bad) => {
        process.env[TEST_TODAY_ENV] = bad;
        expect(() => utcToday()).toThrow();
      },
    );
  });

  describe("프로덕션 — 무조건 비활성", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
      process.env[TEST_TODAY_ENV] = FIXED;
    });

    it("오버라이드를 허용하지 않는다", () => {
      expect(testOverridesAllowed()).toBe(false);
      expect(testTodayOverride()).toBeNull();
    });

    it("환경변수가 있어도 오늘이 고정되지 않는다", () => {
      expect(isoDate(utcToday())).not.toBe(FIXED);
    });

    it("dev-user opt-in 으로도 켤 수 없다", () => {
      // ALLOW_DEV_USER_AUTH 는 dev-user 인증 대체를 프로덕션에서 켜는 명시적 opt-in 이다(ADR-23).
      // 시간 오버라이드는 그것과 **별개**로 항상 꺼져 있어야 한다.
      const originalOptIn = process.env.ALLOW_DEV_USER_AUTH;
      process.env.ALLOW_DEV_USER_AUTH = "true";
      try {
        expect(testOverridesAllowed()).toBe(false);
        expect(isoDate(utcToday())).not.toBe(FIXED);
      } finally {
        if (originalOptIn === undefined) delete process.env.ALLOW_DEV_USER_AUTH;
        else process.env.ALLOW_DEV_USER_AUTH = originalOptIn;
      }
    });
  });
});
