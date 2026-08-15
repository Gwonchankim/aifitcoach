# API 계약

- **원천(Source of Truth): `specs/openapi.yaml` (OpenAPI 3.0.3, 검증 통과).** 엔드포인트·스키마를 임의로 만들지 말고 이 파일을 따르세요.
- 서버(NestJS): openapi에 맞춰 컨트롤러/DTO 구현, 계약 테스트로 검증(또는 DTO 코드젠).
- 프론트(Next.js): openapi에서 클라이언트 타입 코드젠(openapi-typescript 등), 초기에는 목서버(prism 등)로 병행.
- 인증: httpOnly 세션 쿠키 + `X-CSRF-Token`(변경 요청). JWT를 localStorage에 저장하지 않음.
- 동기화: `/sync`는 mutation `client_id` 멱등, `(updated_at, client_id)` 기준 LWW, 서버 단조 증가 opaque cursor를 쓴다. `Idempotency-Key` 헤더는 쓰지 않는다.
- 데일리 루틴 편집: 세션 스코프 add/remove/swap 엔드포인트(FEATURES_UX.md F5). 대시보드: GET /dashboard(F8).
- 결제: 국내 PG 빌링키(`/billing/checkout` → `/billing/confirm` → `/webhooks/pg`).

## 엔드포인트 요약
auth(social/refresh/logout) · me(GET/PATCH/DELETE, consents, export, calibration) · programs(generate, current, {id}) · exercises · sessions({id}, complete, exercises add/remove/swap) · sync · analytics(e1rm/volume/completion), dashboard · billing(checkout/confirm) · subscriptions/status · webhooks/pg
