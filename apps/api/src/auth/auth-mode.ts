/**
 * dev-user 이음새의 종료 조건.
 *
 * 테스트/로컬 개발은 기존 회귀 스펙을 위해 명시적으로 dev-user 모드를 유지하되,
 * production 은 어떤 환경변수로도 dev-user를 켤 수 없다. 실서버는 항상 세션 인증이다.
 */
export type AuthenticationMode = "dev-user" | "session";

export function authenticationMode(): AuthenticationMode {
  const configured = process.env.AUTH_MODE;
  const mode = configured ?? (process.env.NODE_ENV === "production" ? "session" : "dev-user");
  if (mode !== "dev-user" && mode !== "session") {
    throw new Error("AUTH_MODE 는 dev-user 또는 session 이어야 한다.");
  }
  if (process.env.NODE_ENV === "production" && mode === "dev-user") {
    throw new Error("프로덕션에서는 AUTH_MODE=dev-user 를 사용할 수 없다. 세션 인증만 허용된다.");
  }
  return mode;
}

export function usesDevUserAuth(): boolean {
  return authenticationMode() === "dev-user";
}
