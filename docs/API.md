# API 계약

- **원천(Source of Truth): `specs/openapi.yaml` (OpenAPI 3.0.3, 검증 통과).** 엔드포인트·스키마를 임의로 만들지 말고 이 파일을 따르세요.
- 서버(NestJS): openapi에 맞춰 컨트롤러/DTO 구현, 계약 테스트로 검증(또는 DTO 코드젠).
- 프론트(Next.js): openapi에서 클라이언트 타입 코드젠(openapi-typescript 등), 초기에는 목서버(prism 등)로 병행.
- 인증: httpOnly 세션 쿠키 + `X-CSRF-Token`(변경 요청). JWT를 localStorage에 저장하지 않음.
- 동기화: `/sync`는 mutation `client_id` 멱등, `(updated_at, client_id)` 기준 LWW, 서버 단조 증가 opaque cursor를 쓴다. `Idempotency-Key` 헤더는 쓰지 않는다.
- 데일리 루틴 편집: 세션 스코프 add/remove/swap 엔드포인트(FEATURES_UX.md F5). 대시보드: GET /dashboard(F8).
- M-4′ 집계: `/analytics/e1rm|volume|completion`은 수행기록 projection을 조회한다. e1RM·추천은 서버가 종목별 3세션 표시 게이트를 적용한 결과만 반환하고, 완료 세션의 실제값은 `GET /sessions/{id}`에 포함한다.
- 프로그램 lifecycle: `started_at`과 12주 status를 저장하되 미래 12주 세션을 사전 생성하지 않는다. 실제 세션이 없는 미래 주차는 template 기반 preview다.
- 결제: 국내 PG 빌링키(`/billing/checkout` → `/billing/confirm` → `/webhooks/pg`).

## 엔드포인트 요약
auth(social/refresh/logout) · me(GET/PATCH/DELETE, consents, export, calibration) · programs(generate, current, {id}) · exercises · sessions({id}, complete, exercises add/remove/swap) · sync · analytics(e1rm/volume/completion), dashboard · billing(checkout/confirm) · subscriptions/status · webhooks/pg

## 현재 주 운동일 교환 (T05)

| 경로 | 응답·변경 |
| --- | --- |
| `GET /programs/{id}/weeks/current` | 이번 주 lazy 생성과 같은 tx에서 읽은 실제 세션 요약. immutable Program.sessions와 구분 |
| `GET /programs/{id}/week-swaps/candidates` | today identity/revision·별도 자격/사유와 이번 주 후보별 자격/사유. 중복된 오늘 identity는 null |
| `POST /programs/{id}/week-swaps` | client_id·두 ID·두 revision으로 날짜 두 값만 원자 교환. exact 최초 응답 replay, 다른 body는 409 |

409는 공통 Error와 독립 WeekSwapConflict refinement를 모두 만족한다. 이유 우선순위·잠금·회복 범위는 [기능개선 계약 §W](FEATURE_IMPROVEMENTS_CONTRACT.md#w--현재-주-조회와-swap-원자성), 사용자 문구는 UX_STATES의 주간 swap 절이 정본이다.

## 기능개선 예약 계약 (2026-09-05)

[기능개선 계약](FEATURE_IMPROVEMENTS_CONTRACT.md) 중 append와 T05 실제 주 조회/swap은 활성 OpenAPI로 승격됐다. split snapshot·forward-only 전환은 각 소유 Sprint의 후속 계약이며 현재 runtime 지원 선언이 아니다.
