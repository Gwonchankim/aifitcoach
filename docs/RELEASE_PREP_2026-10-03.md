# 2026-10-03 배포 후보 준비

## 범위

운영 master `033049e6f836086a5f295dc34b557a67c603df8d`에 기능 브랜치
`c5c1785`를 통합한 `codex/release-20261003` 후보다. 운영 전환은 별도다.
원본 checkout의 미추적 자료와 기능 worktree의 미커밋 변경은 보존한다.

- T06 S1: 운동 modality, 내부 5목표 composition 및 고정 블록 시간 예산.
- T06 S2: canonical 자전거 1종과 유산소 처방 저장·읽기·오프라인 snapshot 기반.
- T06 S3: 상하체 선호 저장/삭제. 공개 지원값은 false이며 현재 생성에 적용하지 않는다.
- 활성 rules bundle은 `2026.08.1`, 공개 목표는 기존 3종을 유지한다.
  `.09.1` 활성화와 유산소 수행 기능은 이번 범위가 아니다.
- 기존 배포의 legacy null 캐시 보호, migration 이력 및 CI 격리를 유지한다.
  신규 spec22/23을 각각 Chromium/WebKit 독립 단계로 추가해 CI는 총 14단계다.
- ADR 충돌은 기존 80/81을 유지하고 신규 항목을 82~85로 정리한다.
  `load_semantics`는 resistance 명시 값/non-resistance NULL이며 DB default는 없다.
  기존 DROP DEFAULT migration과 hash 고정된 후속 migration은 변경하지 않는다.

## 배포 전 해결 조건

1. 정확한 후보 SHA의 전체 CI, 브라우저 E2E 및 아래 호환성 검증을 완료한다.
2. `SECURITY_PIPA.md`의 새 Program 로컬 snapshot을 사람이 리뷰한다.
   user-scoped IndexedDB 최대 1개에 공개 Program 응답을 저장하며,
   처방과 제외 사유의 통증 부위 라벨이 포함된다. 건강 입력 원문은 포함하지 않는다.
   현재 계정 삭제·로그아웃은 IndexedDB를 삭제하지 않는 기존 단일 사용자 경계를
   계승한다. 로컬 보존기간·삭제 시점·재로그인/오프라인 접근 정책은 명시되지 않았으므로
   저장 범위 확대와 보존 정책을 운영 전환 전에 사람이 검토·승인해야 한다.
3. 실제 전환 직전에 모든 기기의 outbox 동기화와 앱/탭 종료, 사용 중단을 다시 확인한다.
   이전 배포 때의 확인을 재사용하지 않는다. 사이트 데이터/outbox 삭제는 금지한다.
4. 운영 catalog ID가 canonical 110개와 정확히 일치하는지 읽기 전용으로 확인한다.
   S1 migration은 목록 밖 ID가 있으면 실패한다. 기존 기록 baseline과 복구 가능한
   백업을 확보하고 후보 SHA별 runtime/migrate/seed image digest를 기록한다.

## 전환 순서

사용 중단 또는 동등한 트래픽/쓰기 차단이 확인된 상태에서 진행한다.

1. 신규 migration 3개를 순서대로 적용한다.
   `20260927010000_exercise_domain`, `20260928010000_cardio_prescription`,
   `20261003000000_split_preference`. 기존 Program/수행 기록을 재작성하지 않는다.
2. 새 API를 검증하고 새 revision으로 전환한다. **구 API가 서비스 중인 상태에서
   자전거 seed를 실행하지 않는다.** 구 Prisma client는 새 equipment enum과
   non-resistance NULL 분류를 읽지 못한다.
3. 신규 seed 후 catalog 111개 및 기존 110종 값 보존을 확인한다.
4. 새 웹을 배포하고 실제 PWA의 새 service worker 활성화와 새 코드 로드를 확인한다.
   구 PWA는 전체 catalog에서 자전거를 저항 종목으로 선택할 수 있으므로, 열린 구 탭과
   오프라인 구 PWA의 사용 재개를 허용하지 않는다. 앱 재설치/저장소 삭제로 우회하지 않는다.
5. 새 웹/새 API 로그인, 기존 기록, 선호 저장·삭제·미적용, 동기화 및 offline 복구를
   확인한 뒤 사용을 재개한다. 기존 `.08.1/.08.2` Program의 template/generationInput과
   완료 planned/performed 불변, 다음 주 lazy 생성, snapshot 미보유 Program의
   `legacy_input` 표시를 전후 baseline과 대조한다. 실제 휴대폰 검증은 자동 E2E와 구별한다.

## Rollback 경계

- 자전거 seed 이후 `033049e` 구 API로 단순 traffic rollback은 불가하다.
  nullable 도메인과 새 enum을 읽는 호환 이미지가 필요하다. 현재 검증된 rollback
  image digest는 없다. seed 전 호환 이미지와 검증 결과를 확정하지 못하면 전진 복구만
  가능한 상태로 명시하고 이를 운영 전환 판단에 포함한다. 구 PWA와 새 catalog 조합도
  안전하지 않으므로 API와 웹을 함께 고려한다.
- 운영 row 삭제, 역마이그레이션, DB 전체 복원은 자동 rollback으로 실행하지 않는다.
  백업 복원은 전환 이후 새 기록 손실 여부와 별도 복구 승인을 확인해야 한다.
- 준비 완료와 운영 전환 승인/완료를 구분한다. 원격 master push, 운영 migration,
  seed 또는 traffic 전환은 이 문서를 작성하는 것으로 실행되지 않는다.

## 검증 기록

- frozen install, codegen drift, typecheck/lint/format/build, test-seed/contrast/font 검증 통과.
- 첫 전체 실행: shared 729, web 1056 통과. API 1536 통과/2 실패/1 기존 skip.
  실패 2개는 과거 NOT NULL 메타데이터 검사였다. 새 nullable + 도메인 CHECK 계약으로
  보정하고 누락 INSERT/DEFAULT 거부 및 cardio NULL 허용을 보강했다. 집중 재검증 2/2 통과.
  수정 후 전체 재검증과 최종 SHA 원격 CI 결과는 PR에 기록한다.
- 합성 DB에서 구 033049e client는 bike NULL 분류·새 enum 및 전체 catalog 조회가 실패했다.
  신규 client는 동일 DB의 111종 pagination과 bike 읽기가 통과했다. 운영 데이터 접근 없음.
- 22개 migration 적용 DB와 Prisma schema diff 없음. CHECK 제약은 별도 API 테스트로 검증한다.
- 원본 hash 고정 fixture/migration의 기존 CRLF 등은 재포맷하지 않았다.
- 운영 전환은 보류 상태이며 PIPA 사람 리뷰, 실기기 업데이트 및 rollback 준비가 남아 있다.