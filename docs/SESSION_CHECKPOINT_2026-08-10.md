# 세션 체크포인트 — STEP 6 오프라인 동기화 종료

> 작성 시각: 2026-08-16 01:59 KST
> 요청된 체크포인트 파일명은 `SESSION_CHECKPOINT_2026-08-10.md`를 유지한다.

## 1. 저장소와 CI

- STEP 6 시작 기준: `c7bbe33` (`master`, M-UIb 완료·원격 CI green)
- 오늘의 STEP 6 기술 커밋: `b3148e5fc76b49dca5458d0d7eabff4955968852`
  - 제목: `feat(sync): complete STEP 6 offline synchronization`
  - 범위: sync 서버, Dexie mirror/outbox, Serwist 앱 셸, foreground coordinator, D-31 correlation ID mapping
- 기술 마감 시점 `HEAD`와 `origin/master`: 모두 `b3148e5fc76b49dca5458d0d7eabff4955968852`
- GitHub Actions: [CI run 31896676785](https://github.com/Gwonchankim/aifitcoach/actions/runs/31896676785) — **SUCCESS**, `build-test` 6분 3초
  - pnpm 설치 → codegen 및 생성물 diff → typecheck/lint/format/build → web verifier 3종 → 전체 test → Chromium/WebKit 설치 → 전체 E2E까지 종료했다.
  - 비차단 경고는 Node 20 기반 action runtime deprecation 1건뿐이다. 별도 Node 22+ 전환 티켓을 유지한다.
- 이 체크포인트와 세션 종료용 `PROGRESS.md` 갱신은 위 기술 커밋 뒤의 별도 문서 커밋으로 남긴다.

## 2. STEP 6 완료 판정

- 상태: **완료**
- evaluator: **98/100 PASS**
- 프로젝트 총점 70 상한: **해제**
- 복구된 핵심 루프: `세트 기록 → /sync performed_set → 세션 완료 → 추천 재계산`
- 자동화의 유일한 비차단 외부 잔여: 실제 iOS/Android 설치 PWA의 OS 수준 강제 종료·재실행 워크스루

### Sprint 0~5 요약

| Sprint | 결과 |
| --- | --- |
| 0 계약 잠금·red proof | 유실·중복·LWW·cursor가 서로 다른 이유로 red임을 확인했다. OpenAPI/codegen과 데이터가 있는 DB의 `planned_set_id` UNIQUE migration을 먼저 잠갔다. |
| 1A sync 서버 | tenant/entity LWW, mutation 멱등, performed-set upsert/delete, routine snapshot, completion 재계산, opaque pull cursor를 구현했다. |
| 1B PWA 앱 셸 | Serwist precache와 navigation NetworkFirst를 추가했다. `/v1/**`와 건강 데이터는 CacheStorage에서 제외하고 폰트 CacheFirst 소유권을 유지했다. |
| 2 Dexie mirror/outbox | draft·session·routine·catalog mirror와 outbox를 IndexedDB에 두고, local entity+outbox를 단일 transaction으로 커밋했다. disk failure는 성공 UI 전에 전부 rollback된다. |
| 3 coordinator·로컬 우선 완료 | foreground trigger, 멀티탭 lease/heartbeat/fencing, 응답 전 ack 금지, 응답 유실 재시도, conflict audit, pull/cursor commit을 구현했다. |
| 4 통합+D-31 | Chromium loss/duplicate/LWW/pull/multitab/kill/reoffline, WebKit 복구와 routine correlation mapping을 완성했다. ID 치환은 네 store의 단일 transaction이고 임시 ID 유출 0을 고정했다. |
| 5 평가 | 전체 게이트와 뮤턴트 증거를 감사해 98/100 PASS. 실제 설치 PWA 워크스루만 비차단 외부 게이트로 남겼다. |

## 3. 이번 마일스톤이 드러낸 사실

M3 D-5 승인 때 `/sync`는 `performed_set upsert + client_id 멱등`만 구현하는 것으로 계획됐지만, STEP 6 착수 실측에서는 controller의 501 stub만 있었고 `sync.service.ts` 자체가 없었다. 따라서 당시 UI의 세트 기록은 서버에 도달하지 않았고 세션 완료 추천 재계산에도 들어가지 않았다.

기존 M3·M-UIa·M-UIb E2E가 통과한 이유는 테스트 준비 코드가 `performed_sets`를 직접 심어 추천 입력을 만들었기 때문이다. 즉 각 마일스톤의 범위 내 완료 판정은 유효하지만, **제품 핵심 루프인 기록→추천은 실사용에서 끊긴 상태였다.**

STEP 6은 이 공백을 실제 `/sync`, 영속 outbox, pull/LWW, 세션 완료 재계산으로 연결했다. 새 `09-offline-sync.spec.ts`는 `performed_sets` 직접 seed 없이 공개 API·브라우저 IndexedDB·최종 서버/UI 결과를 관찰한다. 다만 자동 브라우저와 실제 설치 PWA의 OS lifecycle은 같지 않으므로 실기기 확인이 마지막 현실 검증이다.

## 4. D-19~D-31 결정과 반영 위치

| 결정 | 확정 내용 | 코드·계약 반영 위치 |
| --- | --- | --- |
| D-19 | 로컬 entity와 outbox를 단일 IndexedDB transaction으로 먼저 커밋하고 그 뒤에만 성공 UI를 보인다. | `apps/web/components/session/session-db.ts`의 `commitDraft*`, `commitRoutineSnapshot`, `commitSessionCompletion`; `session-store.ts` |
| D-20 | `client_id`는 변경마다 새 mutation ID, `entity_id`는 논리 ID다. 네트워크 재시도만 같은 client ID를 재사용한다. | OpenAPI `Mutation`, `sync-request.dto.ts`, `sync.service.ts`의 replay 검사, ADR-56 |
| D-21 | performed-set 논리 ID는 `planned_set_id`이며 DB UNIQUE로 1:1을 강제한다. 완료 해제는 최신 delete tombstone이다. | `schema.prisma`, `20260815090000_sync_contract_lock`, `SyncService.applyPerformed`, ADR-57 |
| D-22 | 루틴 편집은 개별 이벤트가 아니라 `session_routine`의 전체 ordered snapshot이다. | OpenAPI entity enum/payload, `commitRoutineSnapshot`, `SyncService.applyRoutine`, ADR-57 |
| D-23 | LWW는 tenant+entity 범위의 `(updated_at, client_id)` 순서로 판정한다. | `SyncService.apply`/`compare`, sync contract tests, ADR-56 |
| D-24 | 한 batch는 routine → performed-set → session completion 순서다. 선행 conflict면 완료를 보류하고 batch 후 추천을 한 번 재계산한다. | `SyncService.sync`, `SessionsService.recomputeAfterSync`, contract/E2E order assertions, ADR-57 |
| D-25 | pull은 단조 증가 `server_seq`를 숨긴 opaque cursor로 사용하며 손상·replay를 검증한다. | `SyncMutation.serverSeq`, `parseCursor`/`encodeCursor`, OpenAPI `next_cursor`, ADR-56 |
| D-26 | Serwist는 폰트·정적·navigation만 캐시한다. `/v1/**`와 건강 데이터는 CacheStorage에서 제외한다. | `apps/web/app/sw.ts`, `next.config.mjs`, `pwa-shell.test.ts`, ADR-58 |
| D-27 | foreground sync는 필수이고 Background Sync는 보조다. 앱 시작·online·focus·visibility·enqueue가 coordinator를 깨우며 user-scoped lease로 탭을 직렬화한다. | `sync-coordinator.ts`, `providers.tsx`, lease tests, ADR-58 |
| D-28 | conflict를 전송 실패처럼 버리지 않고 local conflict store와 서버 mutation audit에 보존한다. | Dexie `conflicts`, `SyncService.recordConflict`, OpenAPI `conflicts`, ADR-59 |
| D-29 | 민감한 onboarding `profile`은 ADR-33대로 공개 sync entity에서 제외한다. | OpenAPI/DTO entity allowlist, ADR-59 |
| D-30 | 오프라인 provisional 세트 수·추천은 API와 공유하는 mirror 규칙으로 즉시 만들고, sync 후 서버 권위 결과로 교체한다. | `packages/shared/src/routine-plan.ts`, `program-rules.ts`, `SessionScreen.tsx`, ADR-04·59 |
| D-31 | provisional planned set마다 correlation UUID를 쓰고 서버 ID mapping을 받는다. 재전송은 같은 mapping이며 drafts+outbox+session/routine mirror 치환은 단일 IndexedDB transaction이다. | `PlannedSet.clientCorrelationId`, `20260816001000_planned_set_correlation`, `SyncService.plannedSetMappings`, `SyncCoordinator.applyPlannedSetMappings`, OpenAPI `planned_set_mappings`, ADR-60 |

## 5. 최종 게이트

커밋 직전 최신 코드에서 다시 실행한 결과다.

| 게이트 | 결과 |
| --- | ---: |
| contract | 31/31 |
| shared | 81/81 |
| web | 270/270 |
| api | 256/256 |
| E2E 전체 | 64/64, 직렬 |
| 06-mobile | Chromium 7/7 + WebKit 7/7 |
| axe | 20화면, violation 0 |
| S1 전체 흐름 soak | 20/20 |
| codegen | SHA-256 전후 `AD213D22…F782` 동일 |
| typecheck/lint/format:check/build | green |
| web verifier | no-test-seed 135파일, contrast 30조합, font 92 subsets·2,957,724B |

## 6. 착수 때 발견한 계약 불일치 3건

| 불일치 | 해소 상태 |
| --- | --- |
| `performed_sets.planned_set_id`가 비UNIQUE | **해소** — `ux_performed_planned` UNIQUE migration 적용. 중복 데이터가 있는 scratch DB에서 migration 중단→runbook 정리→재적용까지 검증했다. |
| DB `sync_mutations`와 OpenAPI `Mutation` 필드 불일치 | **해소** — `entity_id`, `updated_at`을 최상위 계약으로 통일하고 codegen/contract check를 잠갔다. |
| OpenAPI `Idempotency-Key`가 CORS 허용 헤더에 없음 | **해소** — 중복 transport header를 제거하고 body `client_id` 하나로 멱등 계약을 통일했다. |

## 7. 환경 상태

- Docker Desktop/engine: 동작 중
- `scripts-postgres-1`: PostgreSQL 16, healthy, `localhost:5432`
- `scripts-redis-1`: Redis 7, running, `localhost:6379`
- Prisma migrations: 9개

| DB | 용도 | `prisma migrate status` |
| --- | --- | --- |
| `afc` | 로컬 개발 | up to date |
| `afc_test` | API 통합 테스트 | up to date |
| `afc_e2e` | Playwright E2E | up to date |

세 DB 모두 sync contract lock과 D-31 correlation migration이 적용돼 있다.

## 8. 남은 이월 항목

### 다음 제품 마일스톤

- **M-4′ 기록·주간 프로그램 탭**: 집계 계층을 새로 만들어야 한다. `Estimated1rm`과 `MuscleWeeklyLoad`는 현재 미사용 모델이고 `/analytics/e1rm`, `/analytics/volume`, `/analytics/completion`은 501이다. R-11 재배치와 R-21 backfill 결정이 선행한다.
- **M-7′ 페이월·구독·RIR 튜토리얼/캘리브레이션**: 결제·법무 보류 해제(D-9)가 필요하다. RIR 캘리브레이션은 결제와 분리할 수 있다.

### 비차단 UI·운영 defer

- F14 한글 키커 대체 어법: 별도 design 티켓.
- 펼친 완료행 세트번호/접기 버튼 `16×44px`: 세트 행 그리드를 다시 만지는 다음 디자인 접근성 티켓 또는 grid 계약 개정에서 최우선. M-4′가 grid를 건드리지 않으면 계속 이월 가능.
- CI Node 22+ 전환: 현재 `setup-node`는 Node 20이며 Actions가 Node 20 deprecation 경고를 낸다. 로컬 Node 24는 green이지만 Ubuntu/PostgreSQL의 Node 22+ 전체 게이트는 미실증이다.
- 실제 iOS/Android HTTPS 설치 PWA의 OS 강제 종료·재실행 워크스루.
- 4탭 IA 셸은 M-4′ 화면이 생기기 직전 별도 티켓으로 유지한다.
- 기기 교체·초기 설치로 local history가 없을 때 서버 이력 조회 계약이 필요한지 STEP 6 이후 별도로 판단한다. 임의 endpoint는 만들지 않는다.
- R-08·R-09·R-10·R-25 엔진 변경은 M-4′와 섞지 않고 rules version 상승+골든 선행의 별도 TDD 티켓으로 둔다.
- 장기 운영: Lighthouse CI 승격, 파생 test DB localhost/CI guard, STEP 7 구독·캘리브레이션 필드/501 계약 정합화.

## 9. 내일 최우선 권고 — 실기기 워크스루 재실행

STEP 6에서 핵심 루프가 처음으로 실사용 코드에 연결됐다. 이전 마일스톤의 E2E는 추천 검증을 위해 `performed_sets`를 직접 심었으므로 실제 UI 기록 전송의 증거가 아니었다. 새 자동 E2E는 직접 seed 없이 브라우저/API 종단을 검증하지만, 설치 PWA의 OS 강제 종료·기내모드·모바일 lifecycle까지 대신하지는 못한다.

따라서 M-4′ 개발보다 먼저 실제 기기에서 아래 한 번의 종단 워크스루를 수행하는 것이 가장 값싸고 위험을 크게 줄인다. 여기서 유실·중복이 나오면 M-4′보다 STEP 6 fix-now가 우선이다.

## 10. 내일 재개 체크리스트

1. `AGENTS.md`, `CLAUDE.md`, `docs/README.md`, 이 체크포인트, `docs/WORKFLOW.md`, `docs/ARCHITECTURE.md`의 오프라인 절, ADR-56~60, `docs/TEST_SCOPE.md`, `PROGRESS.md`를 읽는다.
2. `master`, `origin/master`, 작업트리 clean, 마지막 CI success를 확인한다.
3. Docker의 PostgreSQL/Redis health와 `afc`·`afc_test`·`afc_e2e` 9개 migration 적용 상태를 확인한다.
4. HTTPS로 접근 가능한 실제 기기에 PWA를 설치하고 온라인에서 앱 셸·카탈로그·세션을 한 번 warm한다.
5. 기내모드에서 운동 add 또는 swap 직후 첫 세트를 포함해 N개 세트를 기록하고 세션을 완료한다.
6. 동기화 전에 앱을 OS 수준에서 강제 종료하고, 여전히 오프라인인 상태로 재실행해 루틴·N개 기록·완료 상태가 모두 남는지 확인한다.
7. 온라인 복귀 중 한 차례 다시 오프라인으로 전환한 뒤 재복귀해 outbox가 결국 비고 서버에 정확히 N개만 생기는지 확인한다.
8. 대시보드/요약과 다음 추천이 서버 권위 performed-set을 반영하는지, 임시 ID·중복 planned/performed set이 0인지 확인한다.
9. 기기·OS·브라우저·시각·네트워크 전환 순서·관찰값을 `TEST_SCOPE.md` 또는 새 runbook 증거로 남긴다.
10. 통과하면 M-4′ 기획으로 이동한다. 실패하면 데이터 유실/중복을 최우선 fix-now하고 같은 워크스루를 재실행한다.
