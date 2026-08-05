/**
 * dev-user 주입은 테스트 단계 전용이다(docs/TEST_SCOPE.md).
 * 인증(소셜 OAuth + 쿠키 세션 + CSRF) 배선 전에 프로덕션으로 나가면 모든 요청이 같은 사용자가 된다
 * → 명시적 opt-in 없이는 **부팅을 거부**한다(STEP 4 평가 I-16).
 */
import { assertDevUserAuthAllowed } from "../src/auth/dev-user";

describe("dev-user 프로덕션 가드", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env.NODE_ENV = original.NODE_ENV;
    delete process.env.ALLOW_DEV_USER_AUTH;
  });

  it("프로덕션에서 opt-in 이 없으면 부팅을 거부한다", () => {
    process.env.NODE_ENV = "production";

    expect(() => assertDevUserAuthAllowed()).toThrow(/ALLOW_DEV_USER_AUTH/);
  });

  it("프로덕션이라도 ALLOW_DEV_USER_AUTH=true 면 통과한다(명시적 opt-in)", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_USER_AUTH = "true";

    expect(() => assertDevUserAuthAllowed()).not.toThrow();
  });

  it("프로덕션이 아니면(test/development) 통과한다", () => {
    for (const env of ["test", "development", undefined]) {
      process.env.NODE_ENV = env as string;
      expect(() => assertDevUserAuthAllowed()).not.toThrow();
    }
  });
});
