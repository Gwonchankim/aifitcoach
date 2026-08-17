/**
 * 테스트 단계의 인증 대체 지점 — docs/TEST_SCOPE.md.
 *
 * 이 파일 + dev-user.service.ts 가 "요청 → user_id" 를 정하는 **유일한** 곳이다.
 * 나중에 소셜 OAuth + httpOnly 세션 쿠키 + CSRF 를 붙일 때 여기(미들웨어 + user 프로비저닝)만
 * 교체하면 되고, 나머지 서비스는 `@CurrentUser()` 로 받은 user_id 만 쓴다.
 */

/** 사람 결정(PROGRESS.md, ADR-17): users.id 는 uuid 유지 → dev-user 도 고정 UUID. */
export const DEFAULT_DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * production에서 dev-user는 절대 허용하지 않는다. 명시적 opt-in은 공개 API의 데이터를
 * 한 계정에 섞는 사고를 막지 못하므로 제거했다(ADR-66).
 */
export function assertDevUserAuthAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("프로덕션에서는 dev-user 인증 대체를 사용할 수 없다. 세션 인증을 사용하라.");
  }
}

/**
 * 테스트 전용 오버라이드(현재는 "오늘" 고정 — ADR-50)가 허용되는가.
 *
 * **프로덕션에서는 환경변수·opt-in 과 무관하게 무조건 false 다**(사람 결정 2026-08-09).
 * dev-user는 production에서 금지되므로, 이 경계는 세션 인증 운영에서 테스트 날짜가 절대 켜지지 않게 한다.
 *
 * dev-user 이음새 안에 두는 이유: 실제 인증이 붙어 이 파일이 사라질 때 오버라이드도 **함께 사라져야** 한다.
 */
export function testOverridesAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function devUserId(): string {
  const id = process.env.DEV_USER_ID ?? DEFAULT_DEV_USER_ID;
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`DEV_USER_ID 는 UUID 여야 한다(users.id 가 uuid). 현재 값: ${id}`);
  }
  return id;
}

/** 전역 미들웨어(app.setup.ts 에서 등록). DB 접근 없이 user_id 만 주입한다. */
export function devUserMiddleware(
  req: import("./request-user").RequestWithUser,
  _res: unknown,
  next: (error?: unknown) => void,
): void {
  try {
    req.userId = devUserId();
    next();
  } catch (error) {
    next(error);
  }
}
