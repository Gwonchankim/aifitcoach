# 보안 · 개인정보(PIPA) — 필수 준수 (사람 검토 필수)

> 이 영역의 코드는 에이전트가 임의로 바꾸지 말 것. 변경 시 사람 리뷰를 요청한다.

## 인증/세션
- 단일 소유자 운영에서는 Secret Manager의 `OWNER_RECOVERY_CODE`로 최초 등록·재로그인한다. 원문은 DB·응답·로그에 남기지 않고 상수 시간 비교한다.
- `sid`는 httpOnly + Secure + SameSite=Lax 쿠키다. JWT를 localStorage/sessionStorage에 저장하지 않는다. `csrf`는 읽기 가능한 별도 SameSite=Lax 쿠키이며, 변경 요청은 이를 `X-CSRF-Token`으로 보내고 세션별 해시와 비교한다.
- 세션 만료·refresh 회전·로그아웃·계정 삭제 시 무효화한다. 소유자 코드에는 DB 지속 레이트리밋(15분 5회, 30분 잠금)을 적용한다.

## 데이터 보호
- 전송 TLS 1.2+. 저장 시 DB 암호화 + 민감 건강필드(body_fat, pain, 문진) 애플리케이션/컬럼 암호화.
- 시크릿은 시크릿 매니저/환경변수. 코드·리포에 하드코딩·커밋 금지(.env.example만).
- 건강데이터 접근 감사 로깅, 최소 권한.

### 필드 암호화 스킴 (확정 2026-08-05, ADR-16)
- 알고리즘 **AES-256-GCM**, 키 `FIELD_ENCRYPTION_KEY`(32바이트의 base64). 키는 환경변수/시크릿 매니저에서만 주입.
- 저장 형식 **`v1:iv:tag:ciphertext`** (각 파트 base64, iv 12B / tag 16B). `v1` 접두사는 키·알고리즘 회전용.
- 적용 필드: `users.body_fat_pct`, `performed_sets.pain_score`(둘 다 **text 컬럼**), `workout_sessions.session_feedback`의 `pain` 값.
- 결과: 이 필드들로 **DB 정렬·범위검색·집계 불가** → 해당 계산은 애플리케이션 레이어에서 복호화 후 수행한다(디로드 트리거의 "통증↑" 신호 등). 값 범위 검증(`pain 0~10`)도 DB CHECK가 아닌 DTO 검증으로 한다.
- 평문·키·암호문을 로그/에러 메시지에 남기지 않는다.

### 삭제 정책 (확정 2026-08-05, ADR-15)
- `DELETE /me` → **소프트 삭제**(즉시 접근 차단) 후 **퍼지 잡**이 실제 삭제. FK는 `ON DELETE RESTRICT` 유지(연쇄 삭제 금지).
- 퍼지는 **자식 → 부모** 순서로 실행한다:
  `access_audits` → `auth_sessions` → `performed_sets` → `assistance_audits` → `planned_sets` → `workout_sessions` → `programs` → `calibration_set` → `user_rir_calibration` → `estimated_1rm` → `muscle_weekly_load` → `sync_mutations` → `subscriptions` → `consents` → `users`
- `assistance_audits`는 사용자가 아니라 `planned_sets`에 매달린다. FK가 `ON DELETE RESTRICT`이므로 **일반 편집으로 계획세트를 지우는 경로도 같은 트랜잭션에서 audit를 먼저 지운다**(세션 운동 삭제·교체, 루틴 동기화 삭제). 순서가 어긋나면 정상 편집이 FK 위반으로 실패하고 계정 영구 삭제도 막힌다.
- `exercises`는 사용자 소유 데이터가 아니므로 퍼지 대상이 아니다.
- `scripts/purge-deleted-users.mjs`는 `PURGE_BEFORE`가 명시될 때만 실행되는 별도 Cloud Run Job이다. 기본 보존기간을 코드에 숨기지 않는다.
- `consents`·결제 관련 기록은 법정 보존 의무가 있을 수 있다. 현재 단일 사용자 스테이징은 법무 검토를 보류했으므로, 운영자가 매 실행 전에 보존 기준을 결정·기록한다.

## PIPA(개인정보보호법)
- 수집·이용 목적 명시 + 버전화된 동의 기록(consents). 목적 제한·최소 수집. 현재 저장 대상은 성별·출생연도·키·체중·체지방, 운동 목표/경력/제약, 통증·운동 수행 기록이다.
- 동의 화면에는 운영자(현재는 소유자 본인)가 지원·파일럿 분석을 위해 DB의 참가자 기록을 조회할 수 있음을 고지한다. 문안은 `2026-08-17-draft`이며 법무 검토는 제품 오너 결정으로 보류 상태다.
- 열람·이동권: `GET /me/export`(기계판독). 보존 중인 `access_audits`·`assistance_audits`도 포함한다. 삭제권과 필수 수집 동의 철회는 `DELETE /me` → 소프트 삭제 후 명시 cutoff의 퍼지 Job으로 처리한다.
- 보관기간·파기 절차·미성년 처리·처리방침/약관은 공개 사용자 확대 전에 사람/법무 검토가 필요하다.

## 결제(PG)
- PG 웹훅 서명 검증. 빌링키/결제정보는 서버 보관, 클라이언트 노출 금지.
- 전자상거래법: 정기결제 사전 고지·청약철회·환불, 통신판매업 신고.

## 입력 검증
- 모든 입력 DTO 검증(class-validator 등). 신뢰 경계에서 검증. SQL은 파라미터 바인딩(ORM).
