# 단계별 프롬프트 (복사·붙여넣기) — 구체화판

## 사용 규칙
- **한 번에 한 STEP만.** 각 STEP의 "성공 기준"이 모두 충족될 때까지 반복.
- 모든 프롬프트는 아래 **공통 서두**로 시작한다(복사해 앞에 붙일 것):

```
[공통 서두]
먼저 CLAUDE.md와 아래 지정한 docs 파일을 읽어라. Karpathy 4원칙을 지켜라:
(1) 가정을 명시하고 불명확하면 먼저 질문한다(추측 금지),
(2) 요청한 것만 최소 코드로(투기적 추상화·유연성 금지),
(3) 외과적 변경(무관한 파일·주석·포맷 건드리지 말 것, 내 변경이 만든 미사용만 제거),
(4) 성공 기준을 먼저 정하고 테스트/검증으로 통과시킨다.
이번엔 이 STEP의 티켓만 처리하고, 끝나면 실행한 명령과 결과(typecheck/lint/test)를 보여줘라.
```

---

## STEP 0 — 스캐폴딩 & CI  (docs: ARCHITECTURE.md)
```
[공통 서두]
목표: pnpm 모노레포와 실행·테스트 바닥을 만든다.

만들 것:
- apps/web: Next.js(App Router, TypeScript) + Tailwind. PWA는 다음 단계 대비 next-pwa 설치만.
- apps/api: NestJS(TypeScript) + Prisma(초기 datasource만) + ioredis.
- packages/shared: tsconfig + 타입 자리. recommendNextSet(input): Recommendation 스텁 함수와
  RECOMMENDATION_ENGINE.md의 입력/출력 타입 정의만(로직은 비움, throw "not implemented").
- scripts/docker-compose.yml: postgres:16, redis:7 (포트 5432/6379, .env.example 값 사용).
- 각 패키지에 scripts: typecheck / lint / test. 루트 package.json이 pnpm -r로 호출(이미 있음).
- ESLint + Prettier(TS strict) 공통 설정.

성공 기준(verify):
- `pnpm install` 성공.
- `pnpm typecheck` / `pnpm lint` / `pnpm test` 모두 통과(테스트는 비어도 통과 상태).
- `.github/workflows/ci.yml`(이미 있음)의 스텝이 로컬에서 동일하게 통과.
제약: 화면·비즈니스 로직·엔드포인트는 아직 만들지 말 것. 스캐폴딩만.
```

## STEP 1 — DB 스키마 + 시드  (docs: DATA_MODEL.md, specs/exercises_seed.json)
```
[공통 서두]
목표: DATA_MODEL.md를 Prisma 스키마로 옮기고 운동 시드를 적재한다.

만들 것:
- apps/api/prisma/schema.prisma: DATA_MODEL.md의 엔티티/관계/인덱스를 1:1로. enum(goal, experience_level,
  movement_pattern, mechanic, region, equipment, difficulty, metric, subscription status 등)을 정의.
- 마이그레이션 생성(prisma migrate dev).
- scripts/seed-exercises.ts: docs/specs/exercises_seed.json을 읽어 exercises에 upsert(id 기준).
  필드/enum이 스키마와 정확히 일치하는지 검증(불일치 시 실패).

성공 기준(verify):
- 마이그레이션이 로컬 postgres에 적용됨.
- 시드 스크립트 실행 후 exercises count == 30, 대체(substitutions) 참조가 모두 존재.
- 통합 테스트 1개: 시드 적재 후 임의 운동(e_bench_press) 조회가 스키마대로 반환.
제약: exercises_seed.json을 임의로 수정하지 말 것(불일치는 스키마/매핑을 고쳐 해결).
```

## STEP 2 — OpenAPI 코드젠 & 목서버  (docs: API.md, specs/openapi.yaml)
```
[공통 서두]
목표: openapi.yaml을 계약으로 삼아 타입·스텁·목서버를 만든다.

만들 것:
- packages/shared(또는 apps/web): openapi-typescript로 클라이언트 타입 생성(생성물 커밋).
- apps/api: openapi 경로에 대응하는 컨트롤러/DTO 스텁(구현은 501 또는 최소). DTO는 openapi 스키마와 일치.
- 목서버 스크립트(prism 등): `pnpm mock`으로 openapi 기반 목서버 기동.

성공 기준(verify):
- 타입 생성물이 openapi와 일치(빌드 통과).
- 목서버가 뜨고 GET /v1/exercises 등 주요 경로가 예시 응답 반환.
- api 컨트롤러 경로 목록이 openapi paths와 누락 없이 대응.
제약: openapi.yaml에 없는 엔드포인트/필드를 추가하지 말 것. 필요하면 먼저 제안(질문).
```

## STEP 3 — 추천 엔진 TDD (핵심 IP, 먼저)  (docs: RECOMMENDATION_ENGINE.md, GOLDEN_TESTS.md, specs/golden_tests.json)
```
[공통 서두]
목표: packages/shared의 recommendNextSet를 구현해 골든 테스트를 전부 통과시킨다. 테스트 먼저.
성공 기준은 **golden_tests.json 전 케이스**다(현재 18개, GC-05/11/12/14는 결번 — 없는 케이스를 새로 만들지 말 것).

계획(각 단계 verify):
1) 테스트 하네스 작성 → verify: golden_tests.json을 로드해 케이스별로 실행되는 실패 테스트가 뜬다.
   (GOLDEN_TESTS.md의 러너 스켈레톤을 참고. weight/reps_low/reason_code/e1rm(tolerance)/reason_code_in/confidence_max/suggest_substitution 비교.)
2) 판정 유틸 구현(hit_top, too_hard, round_to_step, e1RM) → verify: 관련 케이스 통과.
3) 더블 프로그레션 구현 → verify: GC-01~09, GC-16~18 통과.
4) RIR 오토레귤레이션(corrected_RIR) 구현 → verify: GC-19~22 통과.
5) 안전 가드레일(통증/볼륨 캡)을 진행규칙보다 우선 적용 → verify: GC-13 통과.
6) 유사운동/베이스라인/결측/비정상 처리 → verify: GC-15, GC-17 통과.

성공 기준(verify): `pnpm --filter shared test`에서 golden_tests.json 전 케이스 통과(reason_code 정확 일치, e1rm tolerance 이내).
제약(중요):
- RECOMMENDATION_ENGINE.md의 규칙을 그대로 구현. 규칙이 모호하면 임의 결정 말고 질문.
- 테스트를 삭제·완화해서 통과시키지 말 것. 실패하면 로직을 고친다.
- 결정론적 순수 함수로 유지(부작용·랜덤·시간 의존 금지). rules_version을 출력에 포함.
```

## STEP 4 — 백엔드 엔드포인트 (테스트 스코프: 로그인 보류)  (docs: specs/openapi.yaml, SECURITY_PIPA.md, **TEST_SCOPE.md**)
```
[공통 서두]
목표: 계약대로 핵심 엔드포인트를 구현한다. 단, docs/TEST_SCOPE.md에 따라 로그인/인증은 이 단계에서 구현하지 않는다.

인증 대신(TEST_SCOPE.md):
- 고정 개발용 사용자(dev-user) 미들웨어/가드를 둔다: 모든 요청 컨텍스트에 user_id = env DEV_USER_ID(기본 "dev-user")를 주입.
  이 지점은 나중에 소셜 OAuth + 쿠키 세션 + CSRF로 "이 부분만" 교체할 수 있게 한 곳으로 격리한다.
- auth(social/refresh/logout), me/consents/export/delete는 이번 STEP에서 구현하지 않는다(보류).

구현(각각 verify: 통합 테스트 통과 + openapi 계약 일치, user_id=dev-user):
1) programs: POST /v1/programs/generate(룰 기반: 목표·일수·시간·장비로 분할/운동/기본세트 생성), GET /programs/current.
2) sessions: GET /v1/sessions/{id}, POST /v1/sessions/{id}/complete → 완료 시 packages/shared recommendNextSet로 다음 planned_set.recommended_* 갱신.
3) sessions 루틴 편집(FEATURES_UX.md F5): POST /sessions/{id}/exercises(추가), DELETE .../exercises/{plannedExerciseId}(삭제), POST .../exercises/{plannedExerciseId}/swap(교체).

성공 기준(verify): 각 그룹 통합 테스트(Testcontainers postgres) 통과, 응답이 openapi 스키마 검증 통과, 모든 데이터가 user_id에 매달려 저장됨.
제약: 시크릿 미커밋. 데이터는 반드시 user_id 기준(dev-user라도). 인증 지점을 한 곳으로 격리해 나중 교체 가능하게. 로그인/결제/법무는 TEST_SCOPE.md대로 보류.
```

## STEP 5 — 프론트 핵심 플로우  (docs: PRODUCT.md, **FEATURES_UX.md**)
```
[공통 서두]
목표: 대시보드 + 데일리 루틴(세트 로깅·휴식 타이머·루틴 편집·운동 종료)을 FEATURES_UX.md 명세대로 구현한다.
먼저 docs/FEATURES_UX.md(F1~F8)를 읽고 그 동작을 정확히 따라라.

만들 것:
- 온보딩(프로필·목표·주당일수·시간·문진) + 프로그램 확인('왜 이 루틴' 근거).
- 데일리 루틴 화면(오늘 세션):
  - F1 각 세트: 무게/횟수(+선택 RIR) 입력 + 완료 체크 버튼(추천값 프리필, 체크 취소 가능).
  - F2 완료 체크 시 휴식 타이머 팝업 자동: 초 카운트다운 + 아래 진행(스테이징) 바가 100→0%로 감소.
  - F3 팝업에 +5초/+10초/+30초/+1분 버튼(연타 시 그만큼 현재 카운터에 누적 가산, 상한 10분).
  - F4 팝업 하단 '휴식 종료' 버튼(즉시 종료·다음 세트).
  - F5 루틴 편집: 운동 삭제 / '운동 추가'·'교체' 팝업(부위별 탭 + 운동 DB 종목 선택, 교체는 같은 pattern 우선).
  - F6 최하단 '운동 종료' 버튼 → POST /sessions/{id}/complete → 요약(볼륨·완료 세트·PR·다음 추천 미리보기).
  - F7 부분 수행 허용(완료 체크된 세트만 기록).
- F8 대시보드 화면: 오늘 미수행이면 '오늘 수행할 운동' 또는 '오늘은 휴식';
  오늘 수행했으면 '오늘 수행한 기록 요약' + '내일 수행 예정' 또는 '내일은 휴식'. (+주간 완료율·스트릭·e1RM 추세.)
- API는 STEP 2 코드젠 클라이언트/목서버 사용(세션 편집·GET /dashboard 포함).

성공 기준(verify): 대시보드→데일리 루틴→세트 완료 체크→휴식 타이머(+증가/종료)→루틴 편집→운동 종료→요약까지
목/실서버로 끝까지 동작. 부분 수행 시 완료 세트만 기록됨. 큰 탭·한 손·다크(로깅) 원칙, 접근성(대체텍스트·대비).
제약: 디자인 시스템을 새로 발명하지 말고 Tailwind 기본 + 최소 컴포넌트. FEATURES_UX.md에 없는 기능은 추가하지 마라.
```

## STEP 6 — 오프라인 동기화 (난제)  (docs: ARCHITECTURE.md)
```
[공통 서두]
목표: 로컬 우선 + Outbox + 멱등 + LWW 동기화를 구현하고, 오프라인→복구→재계산을 E2E로 증명한다.

만들 것:
- IndexedDB(Dexie): users/program/session/planned_set/performed_set 미러 + sync_mutations(outbox).
- 세트 로깅은 로컬 트랜잭션 우선(즉시 UI 반영). 변경을 outbox에 client_id UUID로 기록.
- Service Worker(Workbox)로 앱 셸 오프라인 캐시.
- POST /v1/sync 클라이언트/서버: client_id 멱등, updated_at LWW, 세션 완료 시 서버 추천 재계산 반영, since 커서 pull.

성공 기준(verify): E2E 테스트로 '오프라인에서 세트 로깅 → 온라인 복귀 → /sync → 서버 추천 반영'을
재현하고, 재시도 시 **중복 없음/유실 없음**을 단언한다.
사람 검토 필요: 멱등·충돌 해소·데이터 유실 0. iOS Safari 백그라운드 제약은 포그라운드 동기화 폴백으로 처리.
```

## STEP 7 — 결제(PG)·계측·RIR 튜토리얼  (docs: SECURITY_PIPA.md, RIR_TUTORIAL.md, specs/tutorial_program_rir.json)
```
[공통 서두]
목표: 국내 PG 정기결제, 분석 계측, RIR 캘리브레이션(P1)을 구현한다.

만들 것(각 verify 포함):
1) 결제: /v1/billing/checkout → /billing/confirm(빌링키 확정·첫 결제) → /webhooks/pg(서명 검증)로 갱신·해지·환불 반영.
   엔타이틀먼트 미들웨어로 Pro 기능 게이팅. verify: 구독 상태 머신 테스트(trial→active→cancelled) 통과.
2) 계측: 핵심 이벤트(set_logged, recommendation_shown/accepted, session_completed, paywall_viewed, subscribe 등) 전송. verify: 이벤트 스키마·필수 속성 검증.
3) RIR 튜토리얼: tutorial_program_rir.json 기반 3~7일 적응형 흐름, 스킵 게이트(1세트 정확도), bias 산출·저장,
   메인 추천에 corrected_RIR 반영. verify: bias 계산·졸업 판정 단위 테스트.

사람 검토 필요: PG 웹훅·엔타이틀먼트·환불, 전자상거래법 고지, 개인정보 처리.
```

## STEP 8 — QA·안전·배포  (docs: RECOMMENDATION_ENGINE.md 안전 절, .github/workflows/ci.yml)
```
[공통 서두]
목표: 안전 플로우·브라우저 E2E·관측·프리뷰 배포로 베타를 준비한다.

만들 것:
- 통증 보고(pain_score>=4) 안전 플로우: 대체/감량 안내 + 상담 권고(UI+서버).
- 브라우저 E2E(모바일 Safari/Chrome, iOS 홈 화면 PWA 포함)로 핵심 플로우.
- Sentry + OpenTelemetry 설정. 프리뷰 URL로 베타 배포 파이프라인.

성공 기준(verify): 안전 플로우·E2E 통과, 프리뷰 배포 성공, 골든 테스트가 CI test 스텝에서 게이트로 동작(실패 시 머지 차단).
사람 검토 필요: 안전(통증 대응)·개인정보 노출 여부 최종 점검.
```

---
## 매 STEP 공통 종료 체크
- `pnpm typecheck && pnpm lint && pnpm test` 결과 보고.
- diff에 요청과 무관한 변경이 없는지 확인(외과적 변경).
- 새 결정은 docs/ARCHITECTURE.md ADR 표에 한 줄 추가.
