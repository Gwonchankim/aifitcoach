/**
 * dev-user 주입은 테스트 단계 전용이다(docs/TEST_SCOPE.md).
 * 세션 인증이 배선된 뒤에도 dev-user를 켜면 모든 요청이 같은 사용자가 된다.
 * production에서는 opt-in 없이가 아니라 **어떤 opt-in으로도** 금지한다(ADR-66).
 */
import { authenticationMode } from "../src/auth/auth-mode";
import { assertDevUserAuthAllowed } from "../src/auth/dev-user";

describe("dev-user 프로덕션 가드", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env.NODE_ENV = original.NODE_ENV;
    delete process.env.ALLOW_DEV_USER_AUTH;
    if (original.AUTH_MODE === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = original.AUTH_MODE;
  });

  it("프로덕션 기본값은 세션 인증이고 dev-user는 허용하지 않는다", () => {
    process.env.NODE_ENV = "production";

    delete process.env.AUTH_MODE;
    expect(authenticationMode()).toBe("session");
    expect(() => assertDevUserAuthAllowed()).toThrow(/세션 인증/);
  });

  it("프로덕션에서 ALLOW_DEV_USER_AUTH=true·AUTH_MODE=dev-user 모두 우회가 되지 않는다", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_DEV_USER_AUTH = "true";
    process.env.AUTH_MODE = "dev-user";

    expect(() => authenticationMode()).toThrow(/AUTH_MODE=dev-user/);
    expect(() => assertDevUserAuthAllowed()).toThrow(/세션 인증/);
  });

  it("프로덕션이 아니면(test/development) 통과한다", () => {
    for (const env of ["test", "development", undefined]) {
      process.env.NODE_ENV = env as string;
      expect(() => assertDevUserAuthAllowed()).not.toThrow();
    }
  });
});
