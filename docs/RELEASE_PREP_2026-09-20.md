# 2026-09-20 배포 후보 준비

## 후보 범위

`codex/release-20260913` (`b9901eb`)에 `autobuild/full-feature-improvements`
(`4d07cf8`)를 통합한다. 운영 master는 `474fdd8`이며 후보는 별도
`codex/release-20260920` 브랜치에서 검증한다.

- 기존 후보의 유사 운동 초기 처방, ADR-70 표시 게이트, legacy null 캐시 보호를 보존한다.
- 신규 T05는 현재 주 실제 일정/교환 후보 조회, 두 운동일 교환, 응답 유실 복구를 추가한다.
- 기존 owned E2E runner와 migration 이력을 보존한다. spec21을 Chromium/WebKit별
  독립 DB·principal phase로 추가한다. 전체 runner는 10단계다.
- ADR 번호 충돌은 기존 캐시 정책 ADR-80을 유지하고 T05를 ADR-81로 정리한다.
- 원본 checkout의 미추적 자료와 기능 worktree의 미커밋 수정은 그대로 보존한다.

## 전환 순서와 검토 사항

1. 정확한 후보 SHA의 정적/빌드/unit/API/전체 E2E 결과를 확인한다. 이전 후보의 CI
   성공을 신규 후보의 성공으로 대체하지 않는다.
2. `week_swap_receipts` 및 삭제 사용자 purge 변경을 사람이 검토한다
   (`CLAUDE.md`의 보안/개인정보 변경 리뷰 규칙). receipt는 구조적 요청/결과만
   저장하고 수행·건강값을 복제하지 않는다. 합성 DB의 receipt 포함 purge 회귀를 확인한다.
3. 실제 전환 직전에 모든 기기 미전송 기록 동기화와 앱/탭 종료를 확인하고,
   운영 데이터 baseline·복구 가능한 백업을 확보한다. 사이트 데이터는 삭제하지 않는다.
4. 정확한 후보 SHA로 runtime/migrate/seed 이미지를 만들고 digest를 기록한다.
   이번 신규 migration은 `20260920010000_week_swap_receipts` 한 개다.
   기존 18개 이력을 보존하며 신규 테이블/인덱스/FK만 추가하고 기존 일정 backfill은 없다.
   운영 적용 목록과 Prisma drift를 다시 확인한다. catalog 변경이 없으므로 seed 재실행은
   신규 기능의 필수 단계가 아니다.
5. migration → 새 API → 새 웹 순서로 전환한다. 새 웹의 current-week GET은 구 API에
   없으므로 웹 선배포는 금지한다. 새 API의 no-traffic 확인만으로 DB 호환성 검증을
   완료했다고 판단하지 않는다.
6. purge Job도 신규 receipt 삭제 로직이 포함된 migrate 이미지로 갱신한다.
   실제 사용자 삭제/purge는 smoke로 실행하지 않는다.
7. 로그인·현재 주/후보 조회·기존 기록·동기화·activated SW·운영 fact 보존을 확인한다.
   구 PWA는 교환 후에도 immutable template을 표시할 수 있으므로 T05 사용 전에
   기존 탭/PWA를 닫고 새 웹 로드를 확인한다. 실제 휴대폰 검증은 자동 E2E와 구별한다.

## Rollback

- 신규 테이블을 유지한 채 호환 API/웹을 함께 되돌릴 수 있다. 새 웹과 구 API를
  조합하지 않는다. 교환 후 실제 일정이 구 웹 template과 다르게 보이는 한계를 고려한다.
- receipt가 생긴 뒤에는 **purge Job을 구 이미지로 되돌리지 않는다**. 신규 FK는
  `ON DELETE RESTRICT`이며 구 purge는 receipt를 지우지 않아 사용자 물리 삭제가 실패한다.
- receipt 테이블 drop, 운영 데이터 삭제, 역마이그레이션을 임의 실행하지 않는다.
- `afc-staging-api-00010-sil`은 9월 13일 후보이며 T05가 없는 이미지다. 이번 후보의
  이미지나 검증 결과로 혼동하지 않는다.

## 검증 기록

통합 후보 검증 결과는 실행 완료 후 아래에 기록한다. 운영 migration·트래픽 전환·master
push는 배포 준비와 별개이며 이 문서 작성으로 실행한 것으로 간주하지 않는다.
