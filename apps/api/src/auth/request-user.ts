/** 실제 세션과 테스트 dev-user가 공유하는 요청 인증 컨텍스트. */
export interface RequestWithUser {
  userId?: string;
  authSessionId?: string;
}
