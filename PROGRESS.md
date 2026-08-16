# AIFITCOACH (AFC) 개발 진행 기록

> `/goal` 명령이 이 파일을 읽어 마지막 완료 STEP 다음부터 이어서 진행하고, STEP마다 이 파일을 갱신한다.

## 상태 요약
| STEP | 내용 | 상태 | 점수 |
|---|---|---|---|
| 0 | 스캐폴딩 & CI | ✅ 완료 (2026-08-04) | 82 → fix 후 재검증 green |
| 1 | DB 스키마 + 시드 | ✅ 완료 (2026-08-05) | 88 → fix 후 재검증 green |
| 2 | OpenAPI 코드젠 & 목서버 | ✅ 완료 (2026-08-05) | 84 |
| 3 | 추천 엔진 TDD (핵심 IP) | ✅ 완료 (2026-08-05) | 78 → fix 후 뮤턴트 14/14 사살 |
| 4 | 백엔드 엔드포인트 (테스트 스코프: 로그인 보류·dev-user) | ✅ 완료 (2026-08-05) | 77 → fix-now 7건 + 결정 4건 반영 후 재평가 |
| 5 | 프론트 핵심 플로우 (FEATURES_UX F0~F8) | ✅ **M-UIa·M-UIb 완료** — M-UIb Sprint 0~4 직렬 종료, fix-now 반영·defer 1건 분리 | M-UIa **71** · M-UIb **95** |
| 6 | 오프라인 동기화 | ✅ **완료 (2026-08-16)** — D-19~D-31, Sprint 0~5 종료 · 핵심 루프 복구 | **98 PASS** |
| 7 | 엔타이틀먼트 토글 + 계측 (결제 제외) | ⬜ 예정 | |
| 8 | QA·안전·배포 | ⬜ 예정 | |
| — | 최종 다각도 평가 (≥99/100) | ⬜ 예정 | |

## 테스트 단계 스코프
- 로그인·결제·법무 보류(docs/TEST_SCOPE.md). STEP 4는 고정 dev-user로 진행, 결제는 STEP 7 엔타이틀먼트 토글.
- **테스트 우선 목표 = STEP 6까지**(핵심 루프: 온보딩→프로그램→오프라인 로깅→추천→동기화).

---

## STEP 0 — 스캐폴딩 & CI (완료)

### 스코어카드 (evaluator, 82/100 → PASS, 이후 fix-now 5건 반영)
| 성공 기준 | 판정 | 근거 |
|---|---|---|
| `pnpm install` 성공 | pass | pnpm 9.15.9, `--frozen-lockfile` 재실행도 green |
| typecheck / lint / test 통과 | pass | shared·web·api 3패키지 typecheck Done, `eslint .` exit 0(13파일 실검사), 테스트 3/3 통과 |
| ci.yml 스텝 로컬 동일 통과 | pass | install/typecheck/lint/format:check/build/test 전부 로컬 green |
| 산출물 완비 | pass | web(Next 15.5.22+Tailwind 4.3.3, `next build` green), api(Nest 11+Prisma CLI 6.19.3 datasource만+ioredis), shared(타입+`recommendNextSet` throw 스텁), scripts/docker-compose.yml(pg16/redis7, .env.example와 값 일치) |
| 제약(스캐폴딩만·시크릿·외과적) | pass | 컨트롤러 0개·비즈니스 로직 0줄, 추적 env는 `.env.example`뿐, 캐럿(^) 범위 0건, `git diff --check` clean |

배점 상세: 필수 verify 43/45, 산출물 20/25, 제약 15/15, 게이트 강제력 3/10(→ fix 후 보강), 프로세스 1/5(→ 본 문서·ADR로 보강).

### 이슈 트리아지
| # | 이슈 | 심각도 | 결정 |
|---|---|---|---|
| I-1 | `pnpm format`이 `.prettierignore` 부재로 docs/specs(진실의 원천)를 재작성할 위험 | major | **fix-now** — `.prettierignore`(docs/·*.md·lock 제외) + `format:check` 스크립트 + CI 스텝 추가 |
| I-2 | CI에 빌드 게이트 없음(`next build`/`nest build` 파손이 green 통과) | major | **fix-now** — 루트 `build: pnpm -r build` + ci.yml 스텝 추가 |
| I-3 | 패키지별 `lint` 스크립트 부재 | minor | **fix-now(문서화 택1)** — ADR-11로 루트 단일 lint 결정 기록 |
| I-4 | 결정이 ADR 표에 미기록 | minor | **fix-now** — ADR-08~12 추가 |
| I-5 | README 실행 블록이 stale(`docker compose up -d`가 루트에서 실패) | minor | **fix-now** — `db:up`/`db:down` 스크립트 + README 갱신 |
| I-6 | Node 버전 미고정(로컬 v24 / CI 20, vitest 4는 ^20.19 요구) | minor | **fix-now** — 루트 `engines.node: >=20.19` |
| I-7 | Next ESLint 플러그인 미설치(react-hooks 규칙 부재) | minor | **defer → STEP 5** — 프론트 구현 착수 시 frontend가 도입 |
| I-8 | `packages/shared`가 web/api 어디에도 연결되지 않음(소비 방식 미결) | major-risk | **defer → STEP 3** — 소비자가 생기기 전 배선은 투기적. STEP 3 종료 전 결정 필요 |
| I-9 | 골든 케이스 실제 18개인데 지침은 "25개" | info | **해결(2026-08-05 사람 결정)** — 전 케이스(18) 기준으로 문구 정정 |

### 기술 결정(ADR-08~12로 docs/ARCHITECTURE.md에 기록)
- PWA: `next-pwa`(2022-08 이후 방치, App Router 미지원) 대신 **`@serwist/next` 9.5.12**(Workbox 계열) 설치만. 배선은 STEP 6.
- 버전 고정: Next **15.5.22**(16은 jsx 강제), Prisma CLI **6.19.3**(7은 datasource url 이동), TS **5.9.3**(typescript-eslint peer `<6.1.0`), ESLint **9.39.5**, Tailwind **4.3.3**(`@tailwindcss/postcss` 동일 버전), pnpm **9.15.9** 정확 고정.
- 테스트 러너 이원화: api=**jest+ts-jest**(vitest/esbuild는 `emitDecoratorMetadata` 미지원 → Nest DI 파손), web·shared=**vitest 4**.
- lint는 루트 단일 패스(`eslint .`), Prettier는 `docs/`·`*.md` 제외 + CI `format:check` 게이트.
- `@prisma/client`는 STEP 0에 설치하지 않음(모델 0개에서 postinstall generate 실패) → STEP 1에서 추가.
- web/api tsconfig는 `tsconfig.base.json`(NodeNext)을 상속하지 않음. web=bundler+jsx preserve, api=commonjs+데코레이터.

### 실행한 명령과 결과
```
pnpm install                 → Done (803 resolved)
pnpm install --frozen-lockfile → Lockfile is up to date
pnpm typecheck               → shared/api/web 모두 Done
pnpm lint                    → eslint . exit 0
pnpm format:check            → All matched files use Prettier code style!
pnpm build                   → web: ✓ 4 static pages / api: nest build Done
pnpm test                    → shared 1 passed, web 1 passed, api 1 passed
prisma validate              → The schema at prisma\schema.prisma is valid 🚀
git diff --check             → clean
```

### 환경 메모
- 로컬 Windows에서 `next build` 시 `@next/swc-win32-x64-msvc`가 **Application Control 정책으로 차단**되어 wasm 폴백으로 빌드된다(빌드는 성공, 다만 느림). CI(ubuntu)에는 영향 없음.
- Docker Desktop 데몬이 꺼져 있으면 STEP 1(마이그레이션·시드·통합테스트)을 진행할 수 없다. `pnpm db:up` 전에 Docker Desktop 실행 필요.

### 명시한 가정
- PROMPTS의 "next-pwa 설치"는 **PWA 런타임 확보**가 목적이라고 해석해 유지보수되는 Workbox 포크로 대체(ADR-08).
- "각 패키지에 lint 스크립트"는 **lint가 게이트에서 강제되는 것**이 목적이라고 해석해 루트 단일 패스로 충족(ADR-11).
- `Recommendation` 타입에 `e1rm?`·`suggest_substitution?`을 포함했다 — golden_tests.json의 `expect`가 두 값을 검증하므로 계약상 필요(투기적 추가 아님).

---

## STEP 1 — DB 스키마 + 시드 (완료)

### 스코어카드 (evaluator, 88/100 → PASS, blocker 0, 이후 fix-now 3건 반영)
| 성공 기준 | 판정 | 근거(실측) |
|---|---|---|
| schema.prisma가 DATA_MODEL.md를 1:1 이전 | pass | 테이블 13개(+_prisma_migrations), **누락 테이블·컬럼 0**, FK 14개, DATA_MODEL "인덱스" 5개가 이름·컬럼·정렬(DESC)까지 일치 |
| 마이그레이션 적용·재현 | pass | 빈 DB에 cold 적용 성공, `prisma migrate diff --exit-code` → **No difference detected**(스키마↔마이그레이션 드리프트 0) |
| 시드 upsert + 불일치 시 실패 | pass | 잘못된 enum / dangling 참조 / 미지 필드 3종 주입 → 전부 exit 1. 시드 JSON은 sha256 동일로 원복 증명 |
| count == 30, substitutions 참조 존재 | pass | `select count(*) → 30`(afc·afc_test 양쪽), dangling 참조 `0 rows` |
| 통합 테스트(e_bench_press) | pass | 20개 컬럼 전체 `toEqual` 완전 일치 + metric=time(e_plank) 경계. api 테스트 5 passed |
| 제약(시드/docs 불변·시크릿·외과적) | pass | `git diff -- docs/` 빈 출력, `.env` 미추적, `.skip/.only` 0건, `git diff --check` clean |

게이트: `pnpm typecheck / lint / format:check / build / test` 5종 green, `install --frozen-lockfile`에서 `postinstall: prisma generate` 정상.

### 이슈 트리아지
| # | 이슈 | 심각도 | 결정 |
|---|---|---|---|
| I-1 | 스펙 divergence 6건이 ADR/PROGRESS에 미기록 | major | **fix-now** — 본 섹션 + ADR-13~15 기록 |
| I-2 | 통합 테스트 `execSync(stdio:"pipe")`가 실패 원인을 삼킴 | major | **부분 fix-now** — stdout/stderr를 예외에 실어 던지도록 수정. globalSetup 이관은 **defer → STEP 4**(DB spec 2개째부터 worker 경합) |
| I-3 | `scripts/seed-exercises.ts`가 타입체크 밖 | minor | **fix-now** — api tsconfig include에 `../../scripts/**/*.ts` 추가 |
| I-4 | 시더가 시드에 없는 잔여 행을 탐지 못함(exit 0) | minor | **fix-now** — `total !== count`면 SeedError. 고아 행 주입으로 exit 1 실측 확인 |
| I-5 | `nest build`가 test/시드를 dist에 배포 | minor | **fix-now(동반 해결)** — `tsconfig.build.json` 분리. dist는 `main.js`·`app.module.js`만 |
| I-6 | Decimal/pain_score 등 DB CHECK 제약 없음 | minor | **defer → STEP 6** — 동기화 입력 방어선. DTO 검증으로 대체할지 함께 결정 |
| I-7 | openapi에 있으나 DATA_MODEL/스키마에 없는 필드(`Subscription.product_id`, 캘리브레이션 `method`·`perceived_difficulty`) | minor | **defer → STEP 7** — 스펙 공백, 사람 질의 필요 |
| I-8 | 파생 `<db>_test`가 원격 DSN을 가리키면 원격에 DB 생성 | minor | **defer → STEP 8** — localhost/CI 가드 추가 |

### 명시한 가정 (스펙 침묵 구간에서 내린 결정)
- exercises 컬럼 3개 추가·reps nullable 완화(ADR-13). 시드가 진실의 원천이므로 스키마가 수용.
- Decimal 정밀도: 무게/e1RM `(6,2)`, step `(5,2)`, 신장/체중 `(5,1)`, confidence/bias `(3,2)`, volume_load `(10,2)`. 타임스탬프는 `Timestamptz(3)` 일괄.
- 테스트 DB는 `<DB>_test` 파생(ADR-14). CI의 `afc_test`는 접미사 중복 없이 그대로 사용.
- `sync_mutations.status = pending|applied|conflict` — **openapi `SyncResponse`(applied/conflicts)에서 추정**. STEP 6에서 확정 필요.
- 시드 로직은 `apps/api/prisma/seed-exercises.ts`(@prisma/client 소유자), `scripts/seed-exercises.ts`는 런처. pnpm 격리 설치 때문.
- 환경변수는 루트 `.env` 하나로 통일(스크립트가 루트로 이동해 실행, CI의 실제 env가 항상 우선).

### 남은 열린 질문
- `performed_sets.planned_set_id`를 1:1(UNIQUE)로 볼지 1:N으로 둘지(현재 1:N). 부분 수행·재시도 의미론과 연결(STEP 6).
- openapi `Exercise`(`rep_range_low/high`, `media_url`) ↔ DB(`default_reps_*`, `media` jsonb, time 범위) 매핑 계층 위치(STEP 2/4).
- SECURITY_PIPA.md가 요구하는 **건강데이터 접근 감사 로깅용 테이블이 DATA_MODEL.md에 없다**(스펙 공백, STEP 4 이전 결정).

### 실행한 명령과 결과
```
pnpm db:up                     → scripts-postgres-1(healthy), scripts-redis-1
prisma migrate dev --name init → Applying migration `20260804145653_init` / in sync
prisma migrate diff --exit-code→ No difference detected
pnpm --filter api db:seed      → seeded 30 exercises (table count = 30)  (재실행 멱등)
psql: count(*) from exercises  → 30 / dangling substitutions → 0 rows
pnpm typecheck/lint/format:check/build/test → 전부 green (api 5, web 1, shared 1 테스트)
```

---

## STEP 2 — OpenAPI 코드젠 & 목서버 & 컨트롤러 스텁 (완료, 84/100)

### 스코어카드 (evaluator)
| 성공 기준 | 판정 | 근거(실측) |
|---|---|---|
| 타입 생성물·재생성 멱등 | pass | `apps/web/lib/api-types.ts`(1577줄) 커밋, `pnpm codegen` 재실행 전후 sha256 동일 |
| 컨트롤러/DTO 스텁 501 + DTO↔openapi 일치 | pass | 빌드 산출물 기동 실측: `GET /v1/exercises` → 501 `{error:{code:"NOT_IMPLEMENTED"...}}`, DTO 15개 필드/enum/min·max 1:1, 스펙 밖 필드 0건 |
| 목서버 기동 | pass | prism 29 operation 라우팅, 4개 경로 예시 응답 확인 |
| **경로 양방향 대응** | pass | yaml에서 동적 로드해 대조. 라우트 주석 처리 → 누락 검출, 가짜 라우트 추가 → 초과 검출(둘 다 실패 확인 후 원복) |
| openapi 무단 변경 없음 | pass | `required` 키만 제거하면 HEAD와 **semantically identical**, 삭제 라인 0(순수 additive) |

### 이슈 트리아지
| # | 이슈 | 심각도 | 결정 |
|---|---|---|---|
| I-1 | `required` 40블록을 선언했지만 **응답이 계약을 지키는지 검증하는 테스트가 0개** | major | **defer → STEP 4 DoD** — "모든 200 응답이 openapi 스키마(ajv) 통과"를 STEP 4 완료 조건으로 명문화 |
| I-2 | CI에 코드젠 드리프트 가드 없음 | major | **fix-now** — ci.yml에 `pnpm codegen` + `git diff --exit-code` 스텝 추가 |
| I-3 | `POST /me/consents` 배열 바디 미검증(실측: 잘못된 요소·비배열 모두 501) | major | **fix-now** — `ParseArrayPipe` + 400 회귀 테스트 |
| I-4 | `/sync`의 `client_id`가 **openapi 자체 예시(`m_9f2`)와 `format: uuid`가 충돌** | major | **사람 결정 대기**(아래 열린 질문) |
| I-5 | 목서버 baseURL·쿠키 미문서화 | minor | **fix-now** — README에 `/v1` 차이·`sid` 쿠키 기재 |
| I-6 | `required` 정책이 스키마마다 불일치(SubscriptionStatus·CheckoutResponse 미적용) | minor | **defer → STEP 7** — 구독 구현 시 일괄. 규칙은 ADR-22로 명문화 |
| I-7 | `PerformedSet`이 required 0개 + 미참조 고아 스키마 | minor | **defer → STEP 6** — sync payload 계약 확정 시 |
| I-9 | STEP 2 결정이 ADR/PROGRESS에 없음 | minor | **fix-now** — ADR-19~22 + 본 섹션 |
| I-10 | openapi `Exercise`에 `metric`/시간 범위가 없어 `e_plank` 표현 불가 | minor | **사람 결정 대기**(아래 열린 질문) |
| I-11 | `ErrorEnvelopeFilter`가 `@Catch(HttpException)`만 → 비HTTP 500은 엔벨로프 밖 | minor | **defer → STEP 4** |
| I-12 | `pnpm typecheck`가 postinstall 산출물에 하드 의존 | minor | **fix-now** — 루트 typecheck를 `pnpm --filter shared build && pnpm -r typecheck`로 |
| I-13 | 경로 파라미터 enum 미검증(`/auth/social/{provider}`) | info | **defer → STEP 7** |

### 확정된 계약 강화 (사람 승인)
- 응답 스키마 `required` 9블록 → **40블록**. `Session`/`PlannedSet`(12필드 전부)/`Recommendation`/`DashboardSummary` 등이 필수화되어 STEP 5의 non-null 가드가 사라진다.
- 규칙(ADR-22): "서버가 항상 내리는 필드만 required, 해당 없으면 명시적 `null`". `Exercise.rep_range_low/high`는 시드 30종 중 `e_plank`(metric=time) 1건이 결측이라 **제외**(실데이터로 검증).
- 요청 바디는 승인 범위 밖이라 손대지 않았다.

---

## STEP 3 — 추천 엔진 TDD (완료, 78/100 → fix 반영)

### 스코어카드 (evaluator, 뮤테이션 테스트 기반)
| 성공 기준 | 판정 | 근거(실측) |
|---|---|---|
| 골든 전 케이스(18) 통과 | pass | GC-01~22 개별 확인, 계약 파일 무변경(`git diff` 빈 출력) |
| GOLDEN_TESTS.md 비교 규칙 준수 | pass | weight/reps_low/reason_code 정확 일치, e1rm tolerance 폴백, confidence_max, suggest_substitution + `rules_version` 에코 |
| 결정론적 순수 함수 | pass | `Math.random`/`Date`/전역 `let`·`var` **grep 0건**, 100회 반복 동일·입력 비변형 테스트 |
| RECOMMENDATION_ENGINE.md 준수 | pass(수정 후) | `too_hard`는 raw RIR(L25), 오토레귤레이션은 corrected RIR(L52) 구분까지 문서와 일치 |
| 부정행위 없음 | pass | 케이스 id 분기 0건(소스의 `GC-` 3건은 전부 주석), 러너는 JSON 동적 순회, `.skip/.only` 0건 |

**초기 78점의 원인 = 테스트 유효성.** 뮤턴트 24종 중 11종 생존(사살률 54%), 특히 "clamp를 검증한다"는 이름의 테스트가 **clamp를 제거해도 통과**했다.

### fix-now로 처리한 것 (전부 뮤턴트 재주입으로 사살 확인)
| 항목 | 조치 | 재검증 |
|---|---|---|
| clamp(0~6) 무검증 + 가짜 테스트 | e1rm 값으로 상·하한을 고정하는 테스트 3종, 기존 테스트 이름·내용 일치화 | clamp 제거/상한 제거/하한 제거 3종 KILLED |
| `ADD_ONE_REP` 반복 규칙 무검증 | 다세트(9/9/8→9, 12/10/9→10) 고정 테스트 | `+1` 제거·`min→max`·`min→maxReps` 3종 KILLED |
| 통증 경로 confidence 하드코딩(스펙 L28 위반) | 전 경로가 데이터 품질 기반 confidence 사용, 단조성·범위 불변식 추가 | 하드코딩 복원 뮤턴트 KILLED |
| 골든 러너가 미지 `expect` 키를 무시 | `KNOWN_EXPECT_KEYS` 화이트리스트 + 감지기 자기검증 | 키 훼손 뮤턴트 KILLED |
| **증량 반올림(사람 결정)** | ADR-18: 오프스텝은 그리드 정규화 후 한 칸 이동 | 구 동작(round) 복원 등 6종 KILLED |

최종: shared 테스트 **46개 green**, 누적 뮤턴트 **14/14 사살**. 실측 동작: 증량 62.5→65, 유지 62.5→60, 감량·통증 61→60, on-step 60→65(기존과 동일).

### `packages/shared` 배선 (STEP 3 종료 조건 — 해소)
- 방식(ADR-19): shared가 dist(CJS+`.d.ts`) 빌드 → api/web이 `workspace:*` 의존 → 루트 `postinstall`이 shared 빌드.
- 양방향 실효 검증(evaluator): api는 `apps/api/dist`에서 `require("shared")` 런타임 성공(62.5 반환), web은 임시 import 후 `next build` 프리렌더 산출물에 계산값 `62.5`가 포함됨.
- 콜드 부트: dist 삭제 시 typecheck가 실제로 깨지는 것을 확인했고, CI 순서(install→typecheck→…)가 postinstall로 복구됨을 실측. 추가로 루트 `typecheck`가 shared 빌드를 선행하도록 굳혔다(I-12).

### 구현하지 않은 reason_code (입력 스키마상 불가 — 게으름 아님, evaluator 확인)
`VOLUME_SPIKE_CAP`(주간 볼륨 이력 없음), `DELOAD_SUGGESTED`(다세션 추세·수면·피로 없음), `SIMILAR_INIT`(유사운동 e1RM 없음 → `BASELINE`으로 귀결, GC-15가 둘 다 허용), `CALIBRATION_*`(캘리브레이션 상태·날짜 없음). 구현하려면 **입력 스키마 확장 + 골든 케이스 추가가 선행**돼야 한다(결번 GC-05/11/12/14와 대응 추정).

### 계약으로 문서화해야 할 엔진 동작
- **`calibration` 존재 = RIR 축 활성 스위치**. 백엔드가 `rir_bias`를 기본 0으로 항상 채우면 GC-06/07 계열 동작이 뒤집힌다 → 튜토리얼 미완료 사용자에겐 `calibration`을 **생략**해야 한다(STEP 4 필수 준수).
- `BASELINE`은 `weight = 0`(무게 미정)을 반환한다 → 프론트가 "0kg 추천"으로 렌더링하면 UX 오류(STEP 5 가드 필요).
- `CONFIDENCE.full = 0.85`의 절대값은 골든에 고정돼 있지 않다(순서·범위 불변식만 존재).

---

## STEP 4 — 백엔드 엔드포인트 (완료)

### 스코어카드 (evaluator 1차 77/100 조건부 PASS → fix-now 7건 + 사람 결정 4건 반영)
| 성공 기준 | 판정 | 근거(실측) |
|---|---|---|
| dev-user 격리 | pass | 주입 지점 `app.setup.ts` **1줄**, 읽기는 `@CurrentUser()` 단일 통로. `DEV_USER_ID`가 UUID가 아니면 **부팅 실패**. auth/me/consents/export/delete는 501 유지 |
| programs generate/current | pass | 201/200 + ajv 계약 통과. 템플릿은 `programs.template`에 고정(ADR-24) |
| sessions 조회·완료 + 추천 갱신 | pass | 실측: complete 전 `0.00/BASELINE` ×3 → 후 `62.50/WEIGHT_UP_REP_TARGET_MET/0.85` ×3 |
| 루틴 편집 3종(F5) | pass | 추가(위치 지정)·삭제·교체 실측. 중복은 409 |
| 데이터가 user_id에 매달림 | pass | 타 사용자 세션에 5개 엔드포인트 전부 404 + 추천 계산 격리 |
| 통합 테스트 + openapi 응답 검증 | pass | 실제 postgres, ajv가 openapi를 **동적 로드**. api 테스트 **150개** |

### 1차 평가에서 나온 결함과 조치 (전부 fix-now)
| # | 결함 | 조치·검증 |
|---|---|---|
| I-1 **blocker** | 테넌시 술어(`program: { userId }`)를 지워도 85개 테스트가 전부 통과 — 남의 수행기록이 내 추천에 섞여도 미탐지 | `tenancy.spec.ts` 8건 신설. 뮤턴트 재주입 시 **8/8 실패** |
| I-2 **데이터 손실** | 세션 재완료가 암호화된 `pain`을 `{}`로 파괴 | **멱등 + 키 단위 병합**(ADR-25). 409로 막지 않은 이유: 아웃박스 재시도가 정상 경로 |
| I-3 | `GET /programs/current`가 세션 편집에 오염(F5 위반) | 템플릿 분리(ADR-24) |
| I-4 | `sets` 무제한 → `1e10`이 봉투 밖 500 | `@Min(1)@Max(10)` + `ErrorEnvelopeFilter`를 `@Catch()`로 확대(내부 메시지·스택 미노출 단언) |
| I-12 | ajv가 여분 필드 유출을 못 잡음(평문 `pain`·`user_id`) | 계약 검사에 **키셋 검증** 내장(PIPA) |
| I-13 | 완료된 세션이 계속 편집 가능 | 409로 차단 |
| I-15 | 프로덕션에서 dev-user 주입이 그대로 활성 | 명시적 opt-in 없으면 **부팅 거부**(ADR-23) |

### 사람 결정 4건 반영 (2026-08-05)
1. **`pain_areas` 제외 매핑** → `docs/SAFETY_PAIN_MAPPING.md` 신설(의료 조언 아님 고지, `SUBSTITUTE_PAIN`과의 관계 명시). 실측: `["knee"]` → `e_back_squat`·`e_goblet_squat`·`e_leg_press`·`e_walking_lunge`·`e_leg_extension` 제외(squat/lunge/knee_extension **0건**), 빈자리는 같은 근육군 머신/케이블로 대체, 사유는 `Program.excluded_exercises`로 응답. `wrist`는 제외 없이 머신/케이블 우선 정렬(ADR-28).
2. **맨몸·시간 진행 모델**(ADR-27) → 골든 **18 → 30건**(기존 케이스 무변경 증명), reason_code 6종 추가, 뮤턴트 12/12 사살.
   - 이후 **경계 상수를 계약으로 승격**: GC-30~32(맨몸 대체 임계 2회 양방향, 시간 하향 바닥 10초), GC-33~34(**안전 가드레일 `pain_score >= 4` 임계 양방향** — 이전엔 GC-13이 5라 임계를 밟지 않아 `4→5` 회귀가 골든을 통과했다). 엔진 코드는 변경 0 — 부족했던 건 계약 커버리지였다. `equipment: ["bodyweight"]`만으로도 프로그램 생성(이전엔 400). E2E 실측: dips 12/12/12 → `REPS_UP_BODYWEIGHT`(reps_high 6–13), pullup 2/1 → `SUBSTITUTE_TOO_HARD_BODYWEIGHT`, plank 60/65 → `TIME_UP`(20–70초).
   - **버그 수정**: `step_kg: ?? 0`이 맨몸을 `INVALID_INPUT`으로 만들던 문제 → `?? null`. `0`(잘못된 증량 단위)과 `null`(맨몸)은 다른 의미다.
3. **openapi에 404/409/400 명시** → 세션 편집 3종·complete에 응답 10개 추가(전부 기존 `Error` 재사용, 순수 추가 증명). 계약 테스트에 **상태코드 축** 추가 — 409를 404로 바꾸거나 계약에서 409 선언만 지워도 실패한다. 존재하지 않는 `exercise_id`는 지시대로 **400**으로 정정.
4. **세션 내 중복 종목 금지**(ADR-26) → 추가·교체 409, 생성 로직 중복 방지, DB 유니크 제약으로 동시성까지 차단(경합 실측: 제약 제거 시 `[200,500]`, 제약 있으면 `[200,409]`).

### 기술 결정·주의사항
- `rules_version` **2026.08.1**로 상향(ADR-29). `program-rules.ts`·`golden_tests.json`·`RECOMMENDATION_ENGINE.md`·openapi 예시를 함께 갱신. `exercises_seed.json.rules_version_ref`는 시드 저작 시점 메타데이터라 그대로 뒀다.
- `complete()`의 엔진 target 출처를 "다음 세션"에서 **"방금 수행한 세션"** 으로 변경 — 맨몸/시간은 목표 범위 자체가 움직여서 기존 방식이면 아웃박스 재전송이 목표를 두 번 올린다. 가중·반복 종목은 값이 동일해 동작 변화 없음.
- openapi 완화(`recommended_weight` 등 nullable)에서 **`required` 리스트는 한 곳도 바뀌지 않았다** — 키셋 보장은 유지되고 값만 null 허용.
- DB 컬럼 추가: `workout_sessions.focus`, `planned_sets.order_index`/`target_time_*_sec`, `programs.template`/`excluded_exercises`, `performed_sets.actual_time_sec`. `DATA_MODEL.md` 동기화 완료.

### 최종 재평가(81/100)에서 나온 fix-now 3건 — 처리 완료
| # | 결함 | 조치·증거 |
|---|---|---|
| **비원자적 swap → 데이터 손실** | `swapExercise`가 트랜잭션 없이 delete→create. 동시 요청 시 **사용자는 409(실패)를 받았는데 원래 운동이 소실**(평가자 재현) | `$transaction`으로 swap·add·generate 쓰기를 묶음. 재현 테스트는 커밋 안 한 트랜잭션으로 유니크 인덱스 대기를 만들어 **스케줄링 운에 의존하지 않게** 구성. 뮤턴트(순차 실행 복원) 3건 사살 |
| **최대 테이블 Seq Scan** | `performed_sets.planned_set_id`·`programs.user_id` 인덱스 부재. `DATA_MODEL.md` 인덱스 절 자체의 공백 | 24만 행 스크래치 DB로 EXPLAIN before/after 실측: buffers **4,966 → 144**(historyFor), **3,693 → 46**(수행기록 가드). 불필요한 인덱스는 근거를 대고 **넣지 않음** |
| **`pain_areas` 오타가 안전 필터를 무력화** | `"Knee"`·`"knees"`·`"무릎"`이 전부 조용히 통과해 통증 사용자가 스쿼트를 배정받음 | openapi `enum` 8종 + `@IsIn` → 400. 문서↔계약↔코드 동기화 테스트 추가. 400 메시지가 **사용자가 보낸 값을 되뱉지 않음**(건강 입력 누출 방지) |
| (minor) `Program.excluded_exercises`가 required 아님 | 안전 근거가 계약상 생략 가능 | required 추가. 서비스에서 필드 생략 시 3건 실패 확인 |

**⚠️ `pain_areas` enum은 순수 추가가 아니라 요청 값 제약 강화다**(기존에 임의 문자열을 보내던 클라이언트에는 파괴적). 현재 `pain_areas`를 보내는 프론트 코드가 없어 실영향 0이며, **온보딩 UI는 반드시 이 8개로 입력을 제한해야 한다**(자유 입력이면 사용자가 400을 만난다) — STEP 5 필수 전달사항.

### 남은 사람 결정 / 리스크
- **프로그램 생성 규칙이 대부분 해석**이다(분할 2-3=full_body/4=upper_lower/5-6=PPL, 운동 수 30분→3…90분→7, `target_rir` 범위 중앙 올림, 세트 3/스트렝스 복합 5). `program-rules.ts`에 문서 근거와 해석이 구분 표기돼 있으나 **제품 리뷰 필요**.
- `pain_areas`에 enum이 없어 **오타를 조용히 무시**한다 → 안전 필터 무력화 가능. enum 고정 여부는 제품 결정.
- 시간 종목의 목표가 goal별 표 없이 카탈로그 기본값(20~60초)을 쓴다(스펙 공백).
- `PlannedSet`의 reps 축이 nullable이 되어 프론트가 `metric`을 봐야 유효 축을 안다. 더 엄격히 하려면 `oneOf` 구조 변경 필요(순수 추가가 아니라 미실시).
- `performed_sets.actual_time_sec` 추가·`actual_weight/reps` nullable 완화는 STEP 6 `/sync` payload 검증 설계에 영향.

---

## STEP 5 — 프론트 핵심 플로우 (완료)

### 스코어카드 (evaluator 69.5/100 → fix 8건 반영. **디자인·UI·UX가 처음 채점된 STEP**)
| 항목 | 배점 | 점수 | 근거 |
|---|---|---|---|
| 기능 완성도 | 25 | 18 | F0-1·F1~F5·F7 충실. 감점: 로깅 통증 보고 누락(→수정), F0 프로필 폐기(→수정), C-5/C-7 임의결정 |
| 코드 품질·보안 | 15 | 10.5 | 순수함수 분리·CORS 부팅 가드·에러 원문 차단 우수. 감점: 컴포넌트/DOM 테스트 0개(→일부 도입), Next lint 플러그인 미도입(→도입) |
| 디자인 | 12 | 8.5 | 의미 토큰·AA 계산 근거·탭 토큰 우수. 감점: 세로 밀도 폭발(→수정), 요약 여백, 비활성 시각 미구분(→수정) |
| UI | 12 | 8 | 프리미티브 일관·가로 스크롤 0. 감점: 읽기 전용 입력칸 잔존(→수정), 제외 목록 미접힘 |
| UX | 14 | 9.5 | 키보드 완주·axe 0·드래프트 재개·자연스러운 한국어. 감점: 삭제될 데이터를 묻는 스텝(→수정), 운동별 통증 보고 부재(→수정) |
| 성능 | 12 | 9 | LH 98~100/100/100, TBT 20~30ms. 감점: LH가 일회성 산출물(CI 게이트 아님) |
| 실 사용성 | 10 | 6 | 실브라우저·실API 종단 루프 성립. 감점: 새로고침 시 기록 소실(**STEP 6 범위 — 아래 판정**) |

### 하드 게이트 판정 정정 (기술총괄)
evaluator가 "핵심 루프 오프라인 동작 실패"로 상한 70을 적용했으나 **근거 문서를 잘못 골랐다**.
- 원천: `PROMPTS.md` STEP 6 = "IndexedDB(Dexie) 미러 + outbox", `FEATURES_UX.md` F1 = "로컬 우선 저장 → outbox, **STEP 6**", "오프라인(**STEP 6**)".
- evaluator가 인용한 `UX_STATES.md:67`("STEP 5에서는 로컬 IndexedDB 저장까지")은 **파생 문서가 원천과 모순된 것** → 원천에 맞게 정정했다(ADR-32).
- 실점 69.5가 이미 상한 미만이라 **점수 자체는 변하지 않는다**. 분류만 바로잡았다.

### 평가 지적 중 실제 결함 — 전부 수정
| # | 결함 | 조치·검증 |
|---|---|---|
| **안전·스펙 위반** | 로깅 화면에 통증 보고가 없어 **운동별 `SUBSTITUTE_PAIN`을 UI에서 유발할 수 없었다**(FEATURES_UX 안전 절) | 운동 카드에 [통증 기록] 보조 액션 + `PainSheet`(0~10 라디오). `pain>=4`면 [운동 교체]/[무게 줄이고 계속]/[그냥 계속] + 의료 고지. `SetDraft.pain_score`로 openapi `PerformedSet`과 계속 1:1 → STEP 6 `/sync`에 그대로 실린다 |
| **버그** | 프리필된 무게를 지우고 완료하면 `actual_weight: null`(볼륨 0) | UX_STATES §2.4대로 **빈 축은 추천값으로 확정**, 프리필이 없으면 차단+포커스. red→green |
| **F0 위반** | 온보딩이 프로필 4개를 묻고 제출 즉시 폐기 | 저장소 분리(ADR-33). 프로필은 로컬 잔존, **`pain_areas`는 어디에도 저장 안 함**(PIPA) |
| UI | 완료 세션에 `disabled` 입력칸 잔존 → "시작 안 한 운동"처럼 보임 | `readOnly`면 **미렌더** + 기록 요약행. `react-dom/server`로 실제 렌더해 `<input>` 0개 고정 |
| 디자인 | 15세트 페이지 **5,064px**(6화면 스크롤) | 원인 실측: RIR 줄 가용폭 218px < 필요폭 390px → 구조적 2줄. `ScaleGroup`(한 줄+가로 스크롤, 44px 유지) + 2줄 그리드 + compact 밀도 → **3,208px(-37%)** |
| 접근성 | 10분 상한 버튼이 시각적으로 구분 안 됨 | `Button`의 variant 클래스 교체 방식(`aria-disabled:` 변형은 `hover:`와 특이도가 같아 소스 순서 의존). 대비 다크 4.40:1 / 라이트 3.78:1 |
| 이월분 | `@next/eslint-plugin-next`·`eslint-plugin-react-hooks` 미도입(STEP 0 이월) | 도입 + `exhaustive-deps`를 error로. 새로 잡힌 `no-img-element` 1건은 억제하지 않고 `next/image`로 교체 |
| 정직성 | complete 실패 문구가 "기록은 저장했어요"(영속화 없음 = 거짓) | 문구 교정 + "저장" 문자열 금지 테스트 |

### 브라우저 검증 (qa, Playwright 1.62.1 — 이 저장소 첫 DOM 검증)
- **E2E 37/37**(chromium-mobile + webkit-ios), 프로덕션 빌드 기동, 실서버 직접 호출
- **axe 15개 화면 위반 0**(모달 열린 상태 포함)
- **Lighthouse**(프로덕션 빌드): 성능 98~100 / 접근성 100 / 베스트프랙티스 100. 각 리포트에서 **API 200 수신을 확인**해 "빈 화면 고득점"이 아님을 검증
- **모바일 390×844 실측**: 완료 체크 72×72, 휴식 종료 358×72(y=756), 운동 종료 358×72(y=760), 가로 스크롤 0
- **타이머**: 10초 실대기로 `2:00→1:50` + 진행 바를 `boundingBox().width`로 실측, +30초 3연타 = +90초, 10분 상한
- qa가 **자기 보고를 스스로 정정**했다: 1차 측정이 코드 변경 중에 이뤄졌고, 일부 Lighthouse 수치는 프록시가 죽은 상태(에러 화면)를 잰 무효값이었으며, **자신의 테스트 2개가 잘못된 동작("운동 1" 임시 이름)을 정답으로 고정**하고 있었다 → 전량 재측정·재작성

### 발견·수정된 blocker
**API에 CORS 설정이 없어 브라우저에서 앱이 전혀 동작하지 않았다**(`OPTIONS` 프리플라이트 404 → 모든 POST/DELETE 차단). 브라우저 검증을 하지 않았다면 끝까지 발견되지 않았을 결함이다. `WEB_ORIGIN` 허용목록으로 수정(ADR-34).

### 기술총괄 결정 (평가자가 "임의결정"으로 지적 → 정식 기록)
- **C-5**: 운동 종료 시트에서 통증(0~10) 수집 — 근거: FEATURES_UX 안전 절. 이후 **운동별 통증 보고를 추가**해 세션 단위만으로 부족했던 점을 해소.
- **C-7**: '운동 종료'를 하단 **고정 바**로 — F6 "최하단"의 한 손 조작 해석. qa 실측 y=760(하단 10%).
- **F5 부위 탭**: 계약에 `region` 쿼리·필드가 없어 **클라이언트 필터**(30종 규모). 카탈로그가 커지면 계약 추가 제안.

---

## Deferred(이월) 항목
- ~~**→ STEP 3**: `packages/shared` 소비 방식 결정(I-8)~~ → **해소**(ADR-19, 양방향 실효 검증 완료).
- ~~**→ STEP 4 (DoD)**: ajv 응답 스키마 검증~~ → **해소**(키셋 검증까지 포함).
- ~~**→ STEP 4**: `ErrorEnvelopeFilter`를 `@Catch()`로~~ → **해소**.
- ~~**→ STEP 4**: 배선 스모크의 62.5 결합 완화~~ → **해소**.
- ~~**→ STEP 4**: DB 통합 테스트를 `globalSetup`으로 이관~~ → **해소**.
- **→ STEP 5**: `GET /exercises`(부위별 카탈로그)가 아직 501 — F5 추가/교체 팝업의 후보 목록 소스라 선행 구현 필요. 세션 응답의 `planned_sets[].exercise_id`로 "이미 포함된 종목" 비활성 표시는 가능(계약 추가 불필요).
- **→ STEP 5**: `BASELINE`의 `weight: 0`과 맨몸의 `weight: null`을 "무게 미정 / 자체중량"으로 렌더링(0kg 추천으로 표시 금지).
- **→ STEP 6**: `PATCH /programs/{programId}` 구현 시 템플릿과 세션을 함께 갱신(반대 방향 드리프트 방지).
- **→ STEP 6 (F1 "이전 기록" 표시 완성)** — 사람 승인(2026-08-05):
  1. STEP 6에서 **Dexie 로컬 미러**가 붙으면 클라이언트가 **지난 세션의 `performed_set`을 조회**할 수 있게 된다. 그때 F1의 "이전 기록도 함께 보여준다"를 완성한다.
  2. STEP 6 이후에도 **서버 조회가 필요하다고 판단되면**(기기 교체·초기 설치로 로컬 이력이 없는 경우 등) openapi에 **이력 조회 계약 추가를 별도로 제안**한다. **임의로 만들지 않는다.**
  3. 그때까지는 **"직전 세트만 표시"가 의도된 축소**임을 UI에서 오해 없게 처리한다(이전 기록이 없을 때의 빈 상태 문구 등).
  - 배경: 현재 `Session`·`PlannedSet` 어디에도 지난 세션 실측이 없고 조회 계약도 없어, 같은 세션 안의 직전 완료 세트만 표시 가능하다.
- **→ STEP 7**: 스텁이 내는 501과 `/me/*`·`/billing/*`·`/webhooks/pg`의 400을 계약에 일괄 선언(구현 시점).
- **→ STEP 6 (STEP 5 평가에서 확인된 것)**: ① Dexie 영속화 — `session-store.ts`의 `write()` 단일 관문과 `PerformedSet` 1:1 드래프트(9키, `pain_score` 포함)가 이미 준비돼 있어 배선만 하면 된다. 완료 후 **"세트 3개 체크 → reload → 유지"** E2E로 고정. ② `@serwist/next` 배선(현재 `test.fail()` 마커가 회귀를 감시한다). ③ `next_recommendations`·대시보드 `done_summary`·요약 PR은 `/sync`로 서버에 수행기록이 실린 뒤에야 종단 검증 가능.
- **→ STEP 8**: Lighthouse를 일회성 산출물이 아니라 `pnpm --filter web lh` + CI 임계값 게이트로 승격. 컴포넌트 테스트(jsdom+Testing Library) 확대 — 현재 web 143개 중 렌더 테스트는 읽기 전용 행 1건뿐이라 렌더 회귀는 대부분 E2E에만 의존한다.
- **→ STEP 8**: E2E는 **직렬 실행 필수**. 여러 프로세스가 같은 API·DB를 쓰면 `GET /dashboard`가 최신 프로그램 1개만 보기 때문에 서로의 "오늘 세션"을 갈아치운다(실측: 15초에 프로그램 6개 생성 → 대량 실패). Windows에서 `.next` 삭제 직후 첫 `next build`가 manifest ENOENT로 실패하는 현상도 있어 CI에 재시도가 필요하다.
- **→ STEP 5**: `@next/eslint-plugin-next` + `eslint-plugin-react-hooks` 도입(STEP 0 I-7).
- **→ STEP 6**: `@serwist/next` 실제 배선(Service Worker·앱셸 캐시).
- **→ STEP 4**: DB 통합 테스트 부트스트랩을 jest `globalSetup`으로 이관(STEP 1 I-2). DB spec이 2개 이상이 되면 worker별 `migrate deploy` 경합.
- **→ STEP 6**: 동기화 입력 방어선(Decimal 범위·`pain_score` 0~10 CHECK 또는 DTO 검증) 결정(STEP 1 I-6).
- **→ STEP 7**: openapi에만 있는 필드(`Subscription.product_id`, 캘리브레이션 `method`·`perceived_difficulty`) 스펙 정합 질의(STEP 1 I-7).
- **→ STEP 8**: 파생 테스트 DB의 localhost/CI 가드(STEP 1 I-8).

## 사람 결정(확정 — 2026-08-05)
1. **골든 기준 = `golden_tests.json` 전 케이스(현재 18개)**. 결번(GC-05/11/12/14) 보강하지 않음. → CLAUDE.md·PROMPTS.md 문구 정정 완료.
2. **`users.id`는 uuid 유지**, `DEV_USER_ID=00000000-0000-4000-8000-000000000001` 고정 UUID(.env.example 반영). dev-user 주입은 **가드 한 곳에만 격리**(STEP 4). → ADR-17.
3. **민감정보 앱 레벨 암호화 즉시 도입**: AES-256-GCM / `FIELD_ENCRYPTION_KEY`(32바이트 base64) / `v1:iv:tag:ciphertext` text 저장. 대상 `users.body_fat_pct`, `performed_sets.pain_score`, `session_feedback.pain`. → ADR-16, SECURITY_PIPA.md "필드 암호화 스킴".
4. **삭제 = 소프트 삭제 + 퍼지 잡, FK RESTRICT 유지**, 퍼지 순서 자식→부모로 명시. → ADR-15 확정, SECURITY_PIPA.md "삭제 정책".

### 결정 3의 파급(암호화로 DB 연산이 불가능해지는 지점 — 앱 레이어로 이동)
- **디로드 트리거의 "통증↑" 신호**(RECOMMENDATION_ENGINE.md L75): pain 추세를 SQL로 집계할 수 없다 → 대상 세션 행을 읽어 **복호화 후 앱에서 계산**(P1, STEP 7).
- **`pain` 0~10 범위 검증**(openapi L339·L819): DB CHECK 불가 → **DTO 검증(class-validator)**. STEP 1 I-6(범위 CHECK 이월)은 이 결정으로 "DTO 검증" 쪽으로 확정.
- **`body_fat_pct` 추세·정렬**: 현재 스펙에 해당 화면·쿼리 없음(FEATURES_UX 대시보드는 완료율·스트릭·e1RM만). 추후 체지방 추세 기능을 만들면 앱 레이어 집계 필요.
- **영향 없음 확인**: 안전 가드레일 `pain_score >= 4`(RECOMMENDATION_ENGINE L78, 골든 GC-13)는 **입력값 in-memory 판정**이라 암호화와 무관. `muscle_weekly_load` 집계(hard_sets·volume_load·avg_rir)에는 pain/body_fat이 없다.

## ▶ 다음 세션은 여기부터 읽어라 (2026-08-16 M-4′ Sprint 0~2 완료 시점)

> **한 장 요약은 `docs/SESSION_CHECKPOINT_2026-08-10.md` 에 있다. 그걸 먼저 읽어라.**
> STEP 6 기술 커밋 `b3148e5` 완료·`origin/master` 동기화·[CI 31896676785](https://github.com/Gwonchankim/aifitcoach/actions/runs/31896676785) green. D-31 routine correlation mapping으로 C-4 해소.
> 최신 통합 게이트: shared 81 · web 270 · api 256 · **E2E 65/65** · `06-mobile` 14/14 · axe 20화면 0 · S1 soak 20/20 · verify:contrast 30조합.

### 로드맵 현재 위치

[테스트격리 ✅] → [M-UIa ✅] → [T-UI-1·2 ✅] → [M-UIb ✅] → [STEP 6 오프라인 동기화·종단 A·B ✅] → [M-4′ Sprint 0·1·2 ✅] → **M-4′ Sprint 3 클라이언트 데이터 계층(다음)** → Sprint 4 UI → Sprint 5 평가 → M-7′

### STEP 6 종단 워크스루 A·fix-now (2026-08-16)

- 데스크톱 Chrome 종단에서 서버 무결성은 통과했다. 오프라인 add 직후 3세트와 두 탭의 서로 다른 2세트가
  서버에 모두 도달했고, 최종 `planned=12`, `performed=5`, planned/performed 중복 0, 임시 correlation ID
  유출 0, 대시보드·요약·다음 추천 일치를 DB와 화면으로 함께 확인했다.
- **fix-now 발견**: 최초 재연결 탭의 오래된 session GET(9 planned)이 mapping 적용 뒤 도착해 서버 12와
  달리 화면이 20초 이상 `계획 9세트`로 남았다. 지연 응답을 주입한 Chromium E2E가 수정 전
  `서버 18 / 화면 15`로 red임을 확인했다. mapping 시 해당 query를 취소(AbortSignal 전달)하고 mapped cache
  보존 후 권위 서버를 refetch하도록 수정했으며, 취소 제거 뮤턴트가 같은 E2E를 red로 되돌리는 것을
  SHA-256 주입·원복 절차로 확인했다.
- **A의 한계**: Browser Use가 네트워크 offline 전환을 제공하지 않아 서버 종료로 transport loss를 만들었고,
  IndexedDB outbox 수는 직접 읽지 못해 서버 mutation `applied`와 중복 0으로 간접 확인했다. 두 한계는 B의
  실제 기내모드·OS 강제 종료·DB 재대조로 보완한다.
- **production-LAN 준비**: `build:lan`+`start:lan`을 실제 기동해 TLS·page/API/SW 200을 확인했다.
  `verify:lan-pwa` 실측은 controller=`/sw.js`, state=`activated`, `afc-pages-v1` root 1개,
  `afc-fonts-v1` 6개, 실제 Chromium offline reload PASS다. `dev:lan`은 Serwist가 비활성이므로 화면 개발에만 쓴다.
- fix-now 최종 게이트는 contract 31/31, shared 81, web 270, api 256, E2E 65/65(신규 Chromium
  경합 회귀 1건 포함), 06-mobile Chromium 7/7+WebKit 7/7, axe 20화면 위반 0으로 기존 기준선이 감소하지 않았다.
- Background Sync는 ADR-58의 선택적 최적화로 계속 미구현이다. B에서는 자동 백그라운드 전송을 기대하지
  않고, 앱 재실행/focus 시 foreground sync가 반드시 수렴하는지를 판정한다.

### ✅ STEP 6 종단 워크스루 B·최종 완료 (제품 오너, 2026-08-16)

- 갤럭시 Z 플립6 Chrome production-LAN PWA에서 실제 비행기 모드 기록·저장이 정상 동작했다.
- 폰 완전 종료와 앱 강제 종료 뒤에도 기록이 보존돼 IndexedDB transaction commit 뒤의 로컬 내구성을
  실기기 프로세스 경계에서 확인했다. 운동 중 가독성과 한 손 조작감도 양호했다.
- 커버 스크린은 갤럭시 Z 플립6의 커버 화면 실행 앱 목록에 Chrome이 없어 검증 대상에서 제외했다.
  커버 화면·접기 전환은 현재 지원 환경의 AC에서 제거하며, Chrome 지원 상태가 바뀔 때 별도 호환성 티켓으로 재평가한다.
- A의 서버 무결성·재연결 경합 회귀와 B의 실제 기내모드·강제 종료 내구성 증거가 합쳐졌고 유실·중복·추천
  불일치는 발견되지 않았다. **STEP 6 최종 완료**, evaluator 98/100 PASS와 프로젝트 총점 70 상한 해제 판정을 유지한다.

### ▶ M-4′ Sprint 0 — 계약 잠금·red proof (2026-08-16)

- D-32~D-44 승인. D-37은 12주 세션 사전 생성 대신 lifecycle 메타 + lazy 생성으로, D-39는 단일
  `packages/shared/display-gate.ts` + 서버 권위 게이트 결과로 수정 확정됐다(ADR-63·64).
- 실측 정정: 저장소에는 설명에 있던 `generation_input` 컬럼과 `planWeek` 함수가 아직 없다. 기존 program에는
  반복 가능한 `template`이 있으므로 lifecycle backfill은 `started_at`만 설정하고 template snapshot을 lazy
  fallback으로 쓴다. 신규 프로그램부터 generation input을 보존하며 복원 불가능한 레거시 입력을 추측하지 않는다.
- 대시보드 PR의 raw Epley와 추천 엔진 e1RM 공식 불일치는 결함으로 확정했다. 저반복 우선+RIR 보정 공용
  함수로 통일하고 기존 `estimated_1rm`/PR 파생값을 전체 rebuild한다.
- 계약 원천: `docs/M4_CONTRACT.md`, `docs/specs/openapi.yaml`, `docs/DATA_MODEL.md`.
- Sprint 0 red는 analytics 501 하나로 전부 실패하면 무효다. Program lifecycle 누락, Session actual 누락,
  Dashboard rhythm/gate 누락과 fixture mutant(삽입 순서·증분 parity·세트/세션 오계수·raw Epley)를 각각 분리한다.
- **red proof 실측**: `test:red:m4`는 의도대로 **4/4 red** — Program의
  `started_at/total_weeks/current_week/status`, Session의 `recommendation_gate/performed_set`, Dashboard의
  `weekly_rhythm/primary_e1rm`, analytics의 **501→200**이 서로 다른 원인으로 발화했다. 메타 하네스는 정상
  fixture 1건과 삽입순서/증분 parity/세트→세션 오계수/raw-Epley mutant 4종을 모두 판별해 **5/5 green**이었다.
- Sprint 0 계약 자체의 codegen·route/스키마 contract는 **31/31 green**, harness 포함 집중 테스트 **38/38**,
  lint·format:check·`git diff --check` green이다. production 미구현을 숨기지 않아 전체 typecheck는 새 status와
  required gate/actual 타입에서 red, 전체 test는 shared **81/81**·web **270/270**, api **222 passed / 41 red**다.
  Sprint 1은 이 red를 일반 gate로 승격해 구현하고 기존 기준선 이하로 줄이지 않는다.
- 제품 오너가 제공한 프로토타입 원본 HTML 7종에서 실행 런타임·폰트 자산을 제외한 템플릿/스타일/카피를
  `scripts/extract-prototypes.mjs`로 결정론적으로 추출해 `docs/prototypes/`에 보존했다. 원본 SHA-256과
  `--check` 바이트 재현성을 고정하고, 홈·기록·주간 프로그램의 픽셀·문구 체크리스트를
  `docs/M4_CONTRACT.md` §9에 추가했다. 추가 충돌 D-45~D-49 중 기존 승인 D-39/D-42/D-1/ADR-38을
  우선 적용하고, D-47~D-49도 제품 오너가 권장안대로 확정했다. 결제·미래 planning mutation은
  M-4′에서 앞당기지 않는다.

### ✅ M-4′ Sprint 1A projector ∥ Sprint 1B T-UI-3 (2026-08-16)

- 승인된 유일한 병렬 구간을 Orca orchestration으로 실행했다. 1A는 API·Prisma·shared, 1B는 web
  app shell·route·E2E만 소유해 같은 상태를 동시에 쓰지 않았다.
- **1A projector**: 추천 엔진의 기존 corrected-RIR 저반복 e1RM 함수를 공용 export로 재사용하고,
  완료 세션에서 사용자·종목·세션 e1RM과 UTC 주/주동근 hard sets·volume·avg RIR을 만드는 순수
  projector를 추가했다. 세션 완료·sync 뒤 targeted recompute와 전체 rebuild가 같은 함수를 쓰며,
  파생 테이블 교체는 transaction 안에서 수행한다. `estimated_1rm`은 `session_id` 논리 키로 바꾸고
  `muscle_weekly_load.avg_rir` 결측을 `null`로 보존한다.
- projector 전용 테스트는 **5/5 green**이다. 삽입 순서 byte equality, 주 단위 증분==전체 결과,
  tenant 격리, 재실행 idempotency, corrected-RIR 수치를 고정했다. 첫 정렬 뮤턴트가 테스트의 약한
  insertion-order 배치를 드러내 한 번 살아남았고, 반대 tenant를 실제 선행 배치하도록 oracle을 고친 뒤
  정렬 제거·중복 세션 방지 제거·RIR 보정 제거 3종이 각각 red가 됨을 SHA-256 주입→판정→원복→일치로 확인했다.
- migration은 데이터가 있는 `afc`(`performed_sets=12`)와 `afc_test`, `afc_e2e`
  (`performed_sets=440`)에 적용했다. 세 DB 모두 **10 migrations**이며 파생 테이블은 적용 전 0행이라
  손실 대상이 없었다. backfill/reconcile 실행 경로는 마련했지만 실제 운영 backfill 실행과 대조 보고는
  이후 집계 API Sprint의 필수 게이트로 남긴다.
- **1B T-UI-3**: 고정 50px 4탭 `오늘/기록/프로그램/내 정보`를 실제 링크와
  `aria-current=page`로 연결했다. 390px에서 각 97.5px, hit area ≥44px, 본문 하단 여백을 수치 단언하고,
  세션·온보딩 렌더 트리에는 내비를 넣지 않는다. `/history`와 비민감 읽기 전용 `/profile` route shell을
  추가했다. 단위 **2/2**, 집중 E2E **3/3** green이며 직접 영향 화면 9개의 증거 이미지만 갱신했다.
- **통합 게이트**: contract **31/31**, shared **81/81**, web **272/272**, projector **5/5**,
  lint·format:check·build·verify 3종 green. 전체 E2E 직렬 **68/68**, `06-mobile` Chromium 7/7 +
  WebKit 7/7, axe 20화면 위반 0이다. API 전체는 **227 passed / 41 intentional red**로 Sprint 0보다
  projector 5개가 늘고 red 수는 동일하다. root typecheck red도 lifecycle/gate/actual 응답을 아직 구현하지
  않은 Sprint 0 계약 경계뿐이며 API·shared typecheck와 새 T-UI-3 타입은 green이다.

### ✅ M-4′ Sprint 2 — 서버 집계·이력·dashboard·12주 lifecycle (2026-08-16)

- Sprint 0의 intentional-red 4건을 일반 `m4-server-contract.spec.ts`로 승격했다. analytics e1RM/volume/
  completion 3종, Program lifecycle, Session actual+gate, Dashboard rhythm+gate가 모두 200/OpenAPI 키셋을
  통과하며 root typecheck red도 해소됐다.
- D-37은 program POST 시 12주 세션을 만들지 않고 lifecycle/template/generation input만 저장한다. 첫 read가
  현재+다음 주만 lazy 생성한다. `generation_input`이 null인 레거시는 template fallback으로 통과하며,
  migration은 earliest session(없으면 created_at) 주로 `started_at`만 backfill한다.
- D-39 gate 정의는 `packages/shared/src/display-gate.ts` 하나뿐이다. 세션·완료 추천·analytics·dashboard와
  D-31 sync mapping까지 서버가 distinct 완료 세션 수로 값을 제거하며 웹은 wrapper의 nullable 추천을
  그대로 신뢰한다. 0/1/2/3회 단위 테스트와 early/ready 렌더 테스트로 웹 재판정 경로가 없음을 고정했다.
- D-34는 projector와 대시보드 PR이 추천 엔진의 공용 corrected-RIR/저반복 e1RM 함수를 쓴다. 운영 명령
  `pnpm --dir apps/api run analytics:backfill`을 추가했고 데이터가 있는 `afc`에서 실행해 performed set 12행을
  e1RM 3행·주간 부하 3행으로 재생성했다. 레거시 program 1행의 started_at/12주 제약은 충족했고 기존 session
  7행은 그대로라 사전 생성이 없었다.
- 세 DB `afc`·`afc_test`·`afc_e2e`에 **12 migrations** 적용·up-to-date를 확인했다. PostgreSQL은 healthy,
  Redis는 running이다.
- 결정론 통합 테스트는 source fact 삽입 순서를 뒤집은 API 응답의 byte equality와 affected-session 증분 ==
  derived 전량 삭제 후 full rebuild를 실제 PostgreSQL 행으로 증명한다. projector 순수 증명과 별개라 transport/
  persistence 정렬 누락도 잡는다.
- ADR 번호 중복을 바로잡아 STEP 6 종단 ADR-61·62를 보존하고 M-4′ 집계/lifecycle을 ADR-63·64로 확정했다.
- 첫 전체 E2E가 D-39 연동 사각지대 2건을 잡았다. 추천 무게가 gate로 null이 되자 웹이 외부 부하 운동을
  자체중량으로 오인해 무게 입력을 없앴고, 서버의 `partial` 종료 상태를 웹이 미수행으로 그렸다. 운동 종류는
  카탈로그 `step_kg`로 판정하고 partial은 수행 기록 카드+`부분 완료`로 표시하도록 각각 전용 단언 뒤 수정했다.
- **Sprint 2 최종 게이트**: contract **31/31**, typecheck·lint·format:check·build green,
  verify:no-test-seed **150파일**, contrast **30/30**, font **92 faces / 2,957,724B**, test shared **87/87** ·
  web **277/277** · api **277/277**. E2E 직렬 **68/68**, `06-mobile` Chromium **7/7** + WebKit **7/7**,
  axe **20화면 위반 0**으로 Sprint 1 기준선이 감소하지 않았다.
- **Sprint 0~2 통합 완료**: Sprint 0·1에서 의도적으로 유지했던 API **41 intentional red는 Sprint 2 서버
  계약 구현과 함께 41→0으로 해소**됐다. `m4-sprint01`의 두 체크포인트를 `master`에 fast-forward 병합했으며,
  다음 범위는 Sprint 3의 user-scoped analytics/history mirror와 offline read-through다.
- **첫 master CI fix-now**: 로컬 68/68 뒤 첫 Linux CI에서 마지막 WebKit offline-sync만 500으로 실패했다.
  dashboard full rebuild와 다른 projector 갱신이 같은 사용자의 파생 행을 동시에 교체해 UNIQUE가 충돌한
  실제 경합이었다. full/targeted 경로가 source facts를 읽기 전에 같은 사용자별 PostgreSQL transaction
  advisory lock을 잡도록 통일했다. 동시 rebuild 지연 주입 테스트는 수정 전 P2002 red, 수정 후 green이며,
  lock 제거 뮤턴트도 SHA-256 주입·원복 절차에서 같은 red를 재현했다.

### M-UIb 진입 조건

| # | 티켓 | 상태 |
| --- | --- | --- |
| **T-UI-1** | `cn` → tailwind-merge (횡단 변경이라 UIb 와 단독 커밋으로 분리) | **✅ 완료 (2026-08-15)** |
| **T-UI-2** | 폰트 페이로드 — **성능 100 → 92 실측 회귀**. Pretendard 4웨이트 1,051KB → 공식 Variable Dynamic Subset | **✅ 완료 (2026-08-15, ①-V 오너 결정)** |
| **F14** | 한글 키커 대체 어법 — 프로토타입 키커 139회 vs 구현 3곳. 9.5px 모노를 한글에 못 쓴다 | **⏭ 비차단 별도 티켓** (D-18, design 협업). **M-UIb 선행 조건 아님** |

### ✅ Sprint 0 계약 잠금 — D-13~D-18 (2026-08-15)

- RIR: **0~6/`null` 직접 입력 + 셰브론 바텀시트 유지**. 0~5/default 2·길게 누르기·화면 RIR ± 스테퍼·undo 제외(기존 키보드 ↑/↓ 유지).
- 운동 카드: 카드 앵커 `role="menu"`, **교체/통증 기록/삭제 3항목만**. 방향키·Esc·외부 클릭·트리거 포커스 복귀. 건너뛰기 제외.
- 포커스 충돌 AC: 메뉴가 열린 채 완료 체크/타이머 진입 불가. 메뉴 닫힘은 트리거, 타이머 닫힘은 다음 세트 입력으로 복귀하며 두 복귀가 서로 덮지 않는다.
- 완료행 1줄, 완료 체크 48×48px, 온보딩 하단 24px.
- 기록이 있으면 교체·삭제는 포커스 가능한 `aria-disabled`, 통증 기록은 활성. 잠긴 액션은 요청 0회 + 사유 낭독.
- ADR-30·31·40은 폐기 유지, ADR-39는 폐기 취소·재확정, 대체 계약은 ADR-55.

---

### ✅ T-UI-1 — `cn` → tailwind-merge (2026-08-15)

- `tailwind-merge` **3.6.0**을 web 런타임 의존성으로 고정하고 공용 `cn`이 마지막 Tailwind 충돌 클래스를 남기게 했다(ADR-53).
- Tailwind v4 `@theme`의 프로젝트 고유 radius·spacing·text·shadow 값을 `extendTailwindMerge`에 등록했다. 기본 설정만으로는 `rounded-card`를 radius 그룹으로 인식하지 못해 `rounded-full rounded-card`를 둘 다 남기는 것을 테스트 먼저 red로 확인했다.
- 온보딩의 `!important` 우회 4곳(선택 소프트 색 1곳, 목표·경력 카드 반경 2곳, 오류 카드 배경 1곳)을 제거했다.
- 회귀 계약: `cn("rounded-full", "rounded-card") === "rounded-card"`. web 테스트 **224 → 225**.
- 런타임 병합 비용으로 Next 빌드의 페이지별 First Load JS가 약 **8~9kB 증가**했다(`/` 127→135kB, onboarding 117→125kB, program 122→131kB, session 139→148kB). T-UI-2 Lighthouse 재측정은 이 커밋 이후 기준선으로 한다.
- 게이트: typecheck·lint·format:check·build·test green(shared 79 / web 225 / api 237), `verify:no-test-seed`, `verify:contrast` 30/30, E2E **55/55**, `06-mobile` Chromium+WebKit 12/12, axe 19화면 위반 0.
- 기준선 재현 중 테스트 하네스의 기존 시계 의존을 발견했다: `04-errors.spec.ts` 한 곳이 고정 브라우저 시계 대신 호스트 `Date.now() - 1일`을 써서 호스트 날짜 2026-08-15에 기본 `TEST_TODAY=2026-08-14`와 충돌했다. T-UI-1과 섞지 않고 `AFC_TEST_TODAY=2026-08-21`로 동일 금요일 계약을 재검증했다.

---

### ✅ T-UI-2 — Pretendard Variable Dynamic Subset (2026-08-15)

- 오너 결정 **①-V**에 따라 Pretendard **1.3.9 공식 Variable Dynamic Subset 92 WOFF2**를 셀프호스팅했다(공급 압축본 SHA-512 검증). 기존 정적 4웨이트 1,074,956B는 제거했고, 92개 전체 자산은 2,957,724B지만 `unicode-range`에 따라 대시보드가 실제 받는 Pretendard는 **11요청·303,896B 전송(300,596B 리소스)**이다. CDN 요청은 0이다.
- `next/font/local` 대신 공급자의 `@font-face` CSS를 직접 사용하고, Next가 종전에 생성하던 폴백 보정을 동일 수치로 수동 고정했다: Arial local fallback, `ascent-override: 93.76%`, `descent-override: 23.75%`, `line-gap-override: 0%`, `size-adjust: 101.55%`(ADR-54).
- 폰트 응답만 소유하는 Serwist `CacheFirst` runtime cache(`afc-fonts-v1`)를 연결했다. 앱 셸·API·동기화 캐시는 앞당기지 않아 STEP 6의 D-2 expected-fail 계약은 유지한다. HTTP cache를 비운 뒤 네트워크를 끊고 `FontFace.load()`가 실제 `response.fromServiceWorker() === true`인 것을 E2E로 고정했다.
- 브라우저 실측: Chromium·WebKit에서 400/500/600/700 가변 웨이트를 모두 로드·렌더했다. 폰트 로딩을 500ms 지연한 전/후 캡처는 글리프 픽셀은 바뀌되 h1/h2 폭·높이와 main 높이 차이 **0**, 관측 CLS **0**이었다.
- Lighthouse **13.4.1**, 동일 empty-dashboard fixture, 프로덕션 빌드, cold cache, desktop 3회: 성능 **100 / 100 / 99**, 중앙값 **100**(92→100 회복). 중앙값 FCP **496.5ms**, LCP **795.1ms**, TBT **0ms**, CLS **0**, 전체 전송 **512,983B**. 3회 폰트 전송량은 모두 동일했고 3회차 99는 LCP 833.1ms의 단발 변동이다.
- 재측정 절차: 동일 run-scoped empty-dashboard 사용자를 준비해 `/v1/dashboard` 200을 확인하고, `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/v1`로 production build/start한다. 매 회 새 Chrome profile(HTTP·CacheStorage가 비어 있는 cold cache)로 `pnpm --filter web exec lighthouse http://localhost:3000 --preset=desktop --only-categories=performance --output=json`을 **3번 별도 실행**한 뒤 중앙값을 취한다. JSON의 FCP/LCP/TBT/CLS, `network-requests`의 Font 수·transfer/resource bytes, 전체 bytes와 dashboard 200 응답을 함께 기록한다.
- 회귀 게이트 `verify:font-payload`: 정확히 92 faces/URLs와 자산 합계 **2,957,724B**, CSS ≤60,000B, 로컬 URL·가변축·`font-display: swap`·unicode-range·수동 폴백 수치·구 정적 4파일 부재를 CI에서 검사한다.
- 게이트: typecheck·lint·format:check·build·test green(shared 79 / web 225 / api 237), `verify:no-test-seed`, `verify:contrast` 30/30, `verify:font-payload`, E2E **58/58**, axe 19화면 위반 0.

---

### ✅ M-UIb — **완료** (2026-08-15) · Sprint 0→1→2→3→4 직렬 · evaluator 95/100 PASS

#### Sprint 산출물

| Sprint | 산출물 | 검증 |
| --- | --- | --- |
| **0 계약 잠금** | D-13~D-18, ADR-39 재확정, ADR-30·31·40 폐기 유지, 대체 ADR-55. 메뉴-타이머 포커스 소유권과 F14 비차단 분리 | 문서 상호 대조 + typecheck/lint/test |
| **1 세트 행·RIR** | 미완료·펼친 완료 5열 grid(`16px minmax(0,1fr) minmax(0,1fr) 46px 48px`, gap 6), 맨몸·시간 span, 48×48 체크, RIR 0~6/`null`, 숫자 조각만 mono | shared 79 / web 230 / api 237 |
| **2 운동 메뉴** | 48×48 `⋯`, 정확히 교체/통증 기록/삭제 3항목 `role="menu"`, 키보드·외부 닫기·잠금 요청 0·D-14 포커스 인계 | shared 79 / web 237 / api 237 |
| **3 QA 계약** | 기존 E2E 블록 안에 메뉴·잠금·D-14·실측 단언을 접고 metrics/axe/세션 raster 갱신, 테스트 총수 58 유지, 뮤턴트 3종 사살 | 전체 E2E 58/58, `06-mobile` 14/14, axe 20/0 |
| **4 통합 평가** | `git diff 97765a4` 전수 감사, 구 폭 예산·파생 문서 드리프트 fix-now, 펼친 행 접기 타깃 충돌을 별도 defer로 격리 | 금지 범위·D-1·D-2 유입 0, diff/hygiene 재검증 |

#### evaluator 스코어카드 (기준 HEAD `97765a4`, 독립 diff 감사)

| 축 | 배점 | 획득 | 근거 |
| --- | --- | --- | --- |
| 게이트·회귀 방어 | 25 | **25** | 최종 unit 553건, E2E 58/58, `06-mobile` 14/14, axe 20/0. 계약 뮤턴트 3종 모두 의도한 red→원복 green |
| 범위·직렬 순서 | 12 | **12** | Sprint 0→4 직렬, security/payment/privacy/API/shared·package/lock 변경 0, staging/commit 0 |
| 디자인 충실도 | 18 | **17** | grid/간격/48px 체크·메뉴·완료행 밀도와 Chromium/WebKit metrics 일치. 펼친 접기 타깃 1건은 별도 defer |
| UI 구현 품질 | 12 | **11** | 기존 callbacks·도메인 동작 유지, weighted/bodyweight/time 명시 배치, 한글 혼합 숫자만 mono. 첫 열/접기 타깃의 구조 충돌 감점 |
| UX·접근성 | 14 | **11** | 정확한 menu/menuitem, roving focus, Esc·외부닫힘·focus return, 잠금 사유 낭독·요청 0, D-14 배타성. 16×44 접기 타깃 감점 |
| 문서·프로세스 | 9 | **9** | D-13~D-18·ADR-55, 최종 metrics·baseline 편차·뮤턴트 SHA·fix-now/defer·raster 범위를 추적 가능하게 기록 |
| 성능·자산 | 10 | **10** | 신규 패키지·폰트·비트맵 자산 0, 세트 행 90→82px·15세트 스크롤 2673→2563px |
| **합계** | **100** | **95** | **PASS** — M-UIb 완료, STEP 6이 다음 |

#### fix-now / defer 판정

| 판정 | 항목 | 근거와 조치 |
| --- | --- | --- |
| **fix-now 완료** | `UX_STATES §2.4.1` 구 20/76/48/80·행 90px·구 390px 문구 | 실제 5열 계약과 최종 metrics로 교체: Chromium 332×82, 열 16/90/90/46/48; WebKit 335×82, 반올림 열 16/92/92/46/48; gap 6 |
| **fix-now 완료** | AC-RIR-4의 구 76+48+80+72 예산 및 “입력 오른쪽 목표” 잔재 | 46px RIR 열 + 2줄차 `RIR 목표 n` + `aria-describedby`로 정정 |
| **fix-now 완료** | `DESIGN_TOKENS`의 “완료 체크 44px” 잔재 | D-16의 별도 48×48px 계약으로 정정 |
| **fix-now 완료** | `REDESIGN_IMPACT`의 ADR-30 “폐기 후보”·M-UIa 4탭 셸 잔재 | ADR-30 폐기 유지, 4탭은 D-2에 따라 M-4′ 직전 별도 티켓으로 정정 |
| **defer (비차단)** | 펼친 완료행 세트번호/접기 버튼 **16×44px** | 실제 DOM `w-4 min-h-tap`과 캡처에서 확인. §7.6의 44×44와 충돌하지만 첫 열을 44px로 바꾸면 승인된 5열 계약과 입력 폭이 바뀌고, 숨은 hit-area는 인접 입력을 침범한다. **세트 행 그리드를 다시 만지는 다음 작업**(디자인 접근성 티켓 또는 grid 계약 개정) 착수 시 최우선 처리한다. M-4′가 그리드를 건드리지 않으면 defer를 유지한 채 넘어가도 된다 |
| **defer 유지 (D-18)** | F14 한글 키커 대체 어법 | M-UIb 비차단 별도 design 티켓. 이번 구현에 섞지 않음 |

#### Sprint 3 기준선·뮤턴트·최종 게이트 증거

- **초기 `06-mobile` 기준선**: 승인 예측은 “2 source blocks, 4/14 project executions 실패”였으나 실제는 구 직접 액션 selector가 있는 **1 source block만 Chromium/WebKit에서 실패해 2/14 실패(12/14 통과)**했다. 두 번째 예상 실패는 재현되지 않았고 **unexpected 실패 0**이었다. QA 계약 갱신 후 **14/14 통과**.
- **axe 19→20 화면**은 회귀가 아니라 `S4-exercise-menu-open`을 새로 스캔한 의도적 커버리지 증가다. 최종 **20화면 / violation 0**.

| 뮤턴트 | 원본 SHA-256 | 변이 SHA-256 | 의도한 실패 | 원복 증거 |
| --- | --- | --- | --- | --- |
| SetRow grid/48px | `334FAD8BBADD4014899AB6A5DFDE9E46BA399BE09E92A62B11757BCB7415BEFB` | `A4D533F4A156E725D94F2D3C6A636FED97BA5529C3056E2510AF330EA545FF4F` | 2/23 실패 | restore+verify 후 원 SHA 일치, 23/23 통과, clear |
| RirField `aria-describedby` | `576795E885F8DCA7224132BCA0CFBC0FC3498B3DBC0511269A5F6619D650A565` | `C1BA47BCDA7C9AE0BB50A6E3991CAC65F543FCFEB674E15AFF9D12B587B6BC6C` | 2/30 실패 | restore+verify 후 원 SHA 일치, 30/30 통과, clear |
| ExerciseMenu locked guard | `96F80E337C7EED20616AF2F02C394FB6D4B70F8207BC9985F5252431EFEABB43` | `0A33E5E4DE233B02B61C0A81820536E50ED7F163E31BFB78148C7897C163938F` | 1/7 실패 | restore+verify 후 원 SHA 일치, 7/7 통과, clear |

- **최종 전체 실행(Sprint 3)**: typecheck·lint·format:check·build green, `verify:no-test-seed` 130파일, `verify:contrast` 30/30, `verify:font-payload` 92 faces / 2,957,724B, test **shared 79 / web 237 / api 237**, E2E **58/58**, `06-mobile` **14/14**, axe **20/0**.
- **Sprint 4 문서 fix-now 후 재검증**: 제품·테스트 소스는 바꾸지 않았으므로 full E2E/빌드는 위 최종 실행을 유지했고, typecheck·lint·format:check와 test **shared 79 / web 237 / api 237**를 다시 통과했다.
- **커밋 전 최종 재실행(2026-08-15)**: typecheck·lint·format:check·build green, `verify:no-test-seed` 130파일, `verify:contrast` 30/30, `verify:font-payload` 92 faces / 2,957,724B, test **shared 79 / web 237 / api 237**, E2E **58/58**, `06-mobile` **14/14**, axe **20/0**로 직전 보고와 일치했다.
- **raster 경로 전수 감사**: 변경 36개는 모두 세션 grid/menu가 보이는 `apps/web/e2e/screenshots/10-*`~`16-*`, `19-*`~`25-*`, `33-*`~`35-*`, `50-*`~`52-*`, `70-*`, `70a-*`, `71-*`, `73-*`, `73a-*`, `80-*`, `81-*`, `84-*`, `86-*`, `88-*`다. `01-onboarding-pain-step.png`를 포함한 온보딩·대시보드·프로그램·요약 raster 변경은 **0개**다.
- **범위 역검사**: `git diff 97765a4`에 D-1 “프로그램 없이 한 종목 기록” 진입 라우트/CTA와 D-2 하단 4탭 네비 구현은 **0건**이다. 문서의 과거 분석 언급만 남고 제품·E2E에 유입되지 않았다.
- **워크트리 위생**: `.mutation-snapshot/` 부재, 최종 게이트 전 index/staging 비어 있음, `git diff --check 97765a4` 통과. 승인된 M-UIb 경로만 명시적으로 stage해 단일 커밋한다.

#### 이번 마일스톤의 교훈

- 계획 단계에서 58개 E2E를 스펙 단위로 훑고 치수·셀렉터·문구의 예상 파손을 분리한 덕분에, 개발 중 실패를 제품 회귀와 테스트 계약 갱신으로 즉시 분류할 수 있었다.
- `06-mobile`의 보수적 예상은 2개 source block·4/14 실패였지만 실제는 1개 block·2/14 실패였고 unexpected 실패는 0이었다. **정밀한 사전 산출이 범위를 넓힌 것이 아니라, 실제 결과가 예측보다 낫다는 사실을 증거로 확인하게 한 사례**다.
- 계약 잠금→구현→QA 계약→독립 평가를 직렬화하고 뮤턴트 SHA를 전후 대조해, 공유 렌더 트리·기준 이미지에서 원인 혼합과 stash 사고 없이 마일스톤을 닫았다.

---

## STEP 6 오프라인 동기화 — Sprint 0 착수 실측 (2026-08-15)

### 🔴 핵심 루프 공백: `/sync`는 계획과 달리 실제 미구현

- M3 D-5 승인 당시 `/sync`는 **`performed_set` upsert + `client_id` 멱등만 먼저 구현**하는 것으로 계획됐다. 그러나 STEP 6 착수 시 실제 트리를 다시 측정한 결과, `apps/api/src/sync/`에는 DTO·module과 **항상 501을 반환하는 controller stub만 있고 `sync.service.ts` 자체가 없다**. `performed_set` upsert, 멱등 적용, LWW, pull은 모두 미구현이다.
- 현재 UI의 세트 완료는 `session-store.ts`의 Zustand 메모리만 갱신한다. 이 기록을 `performed_sets` 또는 `/sync`로 서버에 보내는 경로가 없으므로, `POST /sessions/{id}/complete`가 추천을 재계산할 때 사용자의 실제 세트 기록은 입력에 포함되지 않는다.
- 기존 E2E·API 테스트가 추천 재계산을 통과한 것은 테스트 setup/fixture가 `performed_sets`를 DB에 직접 심었기 때문이다. 따라서 **제품의 핵심 루프(기록 → 추천)는 실사용 경로에서 끊겨 있었다.** STEP 6은 이 공백을 테스트 우선으로 닫는다.
- 이 발견은 M3·M-UIa·M-UIb 완료 판정을 번복하지 않는다. 각 완료 판정은 당시 승인된 마일스톤 범위 안에서는 유효하지만, 세 판정 모두 이 `/sync` 공백을 포함한 상태에서 내려졌다는 사실을 명시적으로 남긴다.

### 계약·스키마 불일치 3건

1. `performed_sets.planned_set_id`는 인덱스만 있고 UNIQUE가 아니어서, 서로 다른 `client_id`로 같은 계획 세트가 중복 생성될 수 있다.
2. DB `sync_mutations`는 `entity_id`·`client_updated_at`을 최상위 컬럼으로 요구하지만 OpenAPI `Mutation`은 두 필드를 정의하지 않고 자유 형식 `payload`에 숨긴다.
3. OpenAPI `/sync`는 `Idempotency-Key` 헤더를 노출하지만 API CORS 허용 헤더는 `Content-Type`·`X-CSRF-Token`뿐이라 브라우저 교차 출처 요청에서 사용할 수 없다.

### 승인된 Sprint 0 원칙

- D-19~D-30 권장안을 전부 승인했다. 유실·중복·LWW·cursor 단언을 구현보다 먼저 red로 고정하고, 각 테스트가 같은 stub 501이 아니라 **서로 다른 계약 위반 이유로 실패**하는지 확인한 뒤 구현 Sprint로 넘긴다.
- `planned_set_id` UNIQUE는 빈 스키마에서만 확인하지 않는다. 중복 행이 존재하는 데이터 DB의 실패와 명시적 정리 절차를 재현한 뒤 migration 성공·재적용 안전성을 검증한다.
- Sprint 1A(server)와 1B(PWA shell)만 병렬 허용한다. 로컬 mirror/outbox와 서버 sync는 같은 논리 상태를 변경하므로 직렬화한다.

### ✅ Sprint 0 — 계약 잠금·red proof 완료

| 계약 | 구현 전 red가 실제로 관찰한 값 | Sprint 0 종료 상태 |
| --- | --- | --- |
| 유실 0 | `/sync` push 뒤 `performed_sets` 조회가 `null` — HTTP 501 상태를 단언하지 않고 DB 행을 직접 관찰 | `it.failing`으로 보존. Sprint 1A가 저장하면 failing test가 역으로 red가 되므로 일반 `it` 전환 필수 |
| 중복 0 | migration 전 같은 `planned_set_id` 두 번째 INSERT가 성공해 `Received promise resolved instead of rejected` | `ux_performed_planned` UNIQUE 후 PostgreSQL/P2002 거절, count 1 green |
| LWW | 기존 50kg에 더 최신 60kg mutation을 보내도 최종값 **50** | 기대 60 단언을 `it.failing`으로 보존 |
| cursor | applied change를 시드해도 pull 응답에 `changes` 배열이 없음 | change + `server_seq` 단언을 `it.failing`으로 보존 |

- red modifier 원본 SHA-256 `7BF474B71458068F4B9A72D5C1267C1B8A9956F632536A06FF10065B546F2337`. modifier 제거 시 유실 `24495AF9...`, LWW `DBF73595...`, cursor `B7F82E51...`로 각각 변했고, 각 고유 red 확인 뒤 `scripts/mutate.mjs` 원복·verify로 원 SHA 일치, snapshot clear를 확인했다.
- 중복 데이터 scratch DB에는 의도적으로 두 duplicate group(4행)을 만들었다. migration은 `P0001`과 runbook 힌트로 먼저 중단했고 자동 삭제는 0건이었다. runbook transaction이 최신 2행을 남기고 2행을 제거한 뒤 migration 재실행 성공, UNIQUE·`server_seq bigint`·`ix_sync_user_seq`를 확인했다.
- 기존 데이터 DB `afc`·`afc_test`·`afc_e2e`는 migration 전 중복 group 0을 확인하고 적용했다. 세 DB 모두 완료 migration 1건, `ux_performed_planned` 1개, `server_seq` 1컬럼을 확인했다. 일회성 scratch DB는 검증 후 삭제했다.
- OpenAPI: mutation 최상위 `entity_id`·`updated_at`, `session_routine`, `(updated_at, client_id)` LWW 설명, string opaque cursor와 change `server_seq`, tombstone `op`를 고정했다. 중복 transport 키 `Idempotency-Key`는 제거했다. `pnpm codegen` 재생성과 `pnpm contract:check` 통과.
- ADR-56~59에 D-19~D-30을 기록했다. C-8(uncomplete tombstone), C-12(batch 후 추천 재계산)를 해소하고 ADR-33 profile 로컬 전용을 유지했다. C-4는 Sprint 2 실측에서 재개방됐고 D-31/ADR-60에서 최종 해소됐다.

#### Sprint 0 게이트

- typecheck · lint · format:check · build green
- `verify:no-test-seed` 130파일 · `verify:contrast` 30/30 · `verify:font-payload` 92 faces / 2,957,724B
- test **shared 79 유지 / web 237→238 / api 237→244** — 기존 통과 수 감소 0
- E2E 직렬 **58/58**, `06-mobile` Chromium+WebKit **14/14**, axe **20화면 / violation 0** — 기존 기준선 유지
- 앱 셸 offline reload의 기존 expected-failure는 Sprint 1B 소유로 그대로 남겼다. 제품 UI·시각 기준선 변경은 0건이다.

### ✅ Sprint 1A·1B — 서버 sync + PWA 앱 셸 완료

- **Sprint 1A(server)**: `/v1/sync`를 실제 서비스에 연결하고 tenant/entity LWW, 전역 mutation `client_id` 멱등, `performed_set` upsert/delete tombstone, `session_routine` ordered snapshot, 세트→세션 완료 순서, 권위 추천 재계산, `server_seq` opaque cursor pull을 구현했다.
- 1차 구현 검토에서 서로 다른 entity가 같은 `client_id`를 동시에 쓰면 `performed_sets.client_id` UNIQUE로 **500**이 나는 것을 PostgreSQL 통합 테스트로 red 재현했다. client-id와 tenant/entity advisory lock을 고정 순서로 함께 잡아 교착 없이 한 mutation만 적용하고 500이 없음을 8회 동시 반복으로 고정했다.
- 한 mutation의 metric/domain 검증 실패가 배치 전체를 **400**으로 중단하는 것도 red 재현했다. 해당 mutation만 `validation_failed` conflict/audit로 남기고 무관 mutation은 계속 적용하도록 고쳤다. 동일 client-id 내용 불일치, 역순·동시 LWW, 손상/replay cursor, tombstone, routine snapshot, 세트 후 완료와 권위 추천까지 sync PostgreSQL 통합 테스트 **13/13** green이다.
- **Sprint 1B(PWA shell)**: Next 해시 build 자산을 precache하고 same-origin GET navigation만 `afc-pages-v1` NetworkFirst로 캐시한다. `/v1/**`·`/api/v1/**`는 CacheStorage에서 제외하며, 최초 worker 활성화 때 generic `/` 문서를 warm해 첫 온라인 방문 뒤 오프라인 reload가 실제 브라우저에서 통과한다.
- 첫 통합 E2E에서 `exclude: []`가 Pretendard를 precache가 선점해 기존 `afc-fonts-v1` 계약이 1건 깨지는 것을 발견했다(앱 셸 test는 통과). `.woff2`만 manifest에서 제외해 기존 폰트 CacheFirst 소유권을 복원했고, 폰트 오프라인+앱 셸 오프라인 focused **2/2**, 최종 전체 **58/58**을 통과했다.

#### Sprint 1A·1B 통합 게이트

- codegen · contract:check · typecheck · lint · format:check · build green
- `verify:no-test-seed` 130파일 · `verify:contrast` 30/30 · `verify:font-payload` 92 faces / 2,957,724B
- test **shared 79 유지 / web 239 / api 253** — Sprint 0 및 원 기준선 대비 통과 수 감소 0
- E2E 직렬 **58/58**, `06-mobile` Chromium+WebKit **14/14**, axe **20화면 / violation 0**. 제품 UI 변경이 없으므로 실행 중 다시 쓰인 PNG 기준선은 HEAD 원본과 정확히 교체해 diff 0으로 정리했다.

### ✅ Sprint 2 — Dexie 로컬 mirror + atomic outbox 완료

- `dexie@4.4.5`를 런타임, `fake-indexeddb@6.2.5`를 테스트 전용으로 정확히 고정했다. `afc-session-v1` DB version 1에 user/session-scoped draft·session/routine mirror, outbox, opaque cursor meta, conflict audit, lease-ready store를 두고 CacheStorage/localStorage에는 건강 데이터를 넣지 않는다.
- 세트 완료·수정은 새 UUID `performed_set upsert`, 완료 해제는 더 최신 `delete` tombstone이다. local draft와 outbox는 한 Dexie transaction으로 먼저 commit하고 성공 뒤에만 Zustand·완료 문구·휴식 타이머가 바뀐다. disk-full 강제 실패에서 draft/outbox/Zustand가 모두 0변경임을 관찰했다.
- 운동 단위 통증 기록은 여러 세트를 **한 transaction**으로 묶었다. 미완료 세트 통증은 local draft에만 남아 후속 완료 upsert에 실리고, 이미 완료된 세트만 새 outbox upsert를 만든다. 중간 outbox 실패 시 모든 세트와 Zustand가 rollback되는 테스트를 추가했다.
- reload hydrate, user/session 격리, 세션 전환 late-hydrate race, persistent-storage best effort, session mirror offline fallback을 고정했다. online fetch 성공 후 mirror 쓰기만 실패해도 성공 응답은 유지한다. routine snapshot과 session completion도 local entity+outbox 원자 primitive 및 관찰 테스트를 갖췄다.
- 현재 브라우저에는 실제 인증 user id 계약이 없으므로 STEP 4의 고정 dev-user 범위를 명시적으로 사용한다. OAuth 전환 때 scope 주입으로 교체해야 하며 서로 다른 user/session row 격리는 이미 테스트한다.
- **발견된 계약 공백**: offline add/swap으로 새 운동을 만들면 서버 `PlannedSetFactory`가 부여할 `planned_set.id`를 클라이언트가 알 수 없다. 승인된 `session_routine.exercise_ids` snapshot만으로는 그 운동을 즉시 세트 로깅한 local ID를 서버 ID로 무손실 매핑할 수 없으므로, 임의 ID/추정 매핑은 하지 않고 UI 배선을 Sprint 3 계약 판단 지점으로 남겼다. 기존 서버 planned-set의 기록·수정·해제는 영향 없다.

#### Sprint 2 게이트

- focused IndexedDB/store **28/28**, typecheck · lint · format:check · build green
- `verify:no-test-seed` 133파일 · `verify:contrast` 30/30 · `verify:font-payload` 92 faces / 2,957,724B
- test **shared 79 유지 / web 254 / api 253** — 기존 통과 수 감소 0
- E2E 직렬 **58/58**, `06-mobile` Chromium+WebKit **14/14**, axe **20화면 / violation 0**. 실행이 다시 쓴 PNG는 UI 변경 범위가 아니므로 HEAD 원본으로 복원해 기준선 diff 0.

### ✅ Sprint 3 — foreground sync coordinator + 로컬 우선 세션 완료

- 앱 시작·`online`·focus·visibility 복귀와 outbox enqueue가 한 coordinator를 깨우며, burst trigger는 한 실행으로 합친다. user-scoped IndexedDB lease가 동시 탭의 전송을 직렬화하고 만료 takeover를 허용한다. 15초를 넘는 요청에는 heartbeat를 두고, 응답 commit transaction에서 owner·만료를 다시 확인하는 fencing으로 lease를 잃은 탭의 늦은 ack를 금지했다.
- IndexedDB outbox의 `user_id`·`attempts`를 그대로 JSON 직렬화하던 감사 결함을 red로 잡았다. OpenAPI mutation 6개 필드만 명시적으로 투영해 `/sync` `additionalProperties: false`와 일치시켰다. 응답을 받기 전에는 outbox를 지우지 않고, applied/conflict 삭제·conflict 원본 보존·pull mirror·opaque cursor를 한 transaction으로 commit한다. transaction 실패와 응답 유실은 같은 mutation ID로 재시도한다.
- 세트 완료/수정/해제·운동 단위 통증은 local commit 성공 뒤에만 화면 성공 상태를 바꾸고 coordinator를 호출한다. 운동 종료도 session mirror+outbox를 먼저 commit해 오프라인에서 즉시 로컬 요약을 보여주며, 온라인 응답의 서버 권위 추천으로 교체한다.
- RIR 미입력이 wire에 `actual_rir:null`로 실려 “미입력”과 값 0을 혼동할 여지를 E2E가 발견했다. null 키 자체를 생략하고 실제 0만 전송하는 단위 단언을 추가했다.
- 첫 전체 E2E는 **55/58**이었다. (1) 위 RIR 직렬화 1건은 제품 수정, (2) 대시보드의 “기기 전용 기록” 기대 1건은 이제 서버 권위 `980kg · 2세트` 계약으로 갱신, (3) 앞선 스펙의 실제 sync가 추천 이력을 만든 뒤 “무게 미정” 전제를 깨뜨린 1건은 단언을 지우지 않고 이력 축이 다른 명시적 하체 종목으로 격리했다. 재실행은 예상 밖 실패 0으로 **58/58**이다.
- **계속 열린 계약 공백**: offline add/swap 직후 서버가 아직 만들지 않은 `planned_set.id`와 로컬 세트 기록을 매핑할 방법은 `exercise_ids` snapshot만으로는 없다. 임의 ID나 순서 추정은 유실 위험이므로 routine UI의 직접 서버 호출은 아직 바꾸지 않았다. Sprint 4 통합 전에 응답 매핑 계약을 확정해야 한다.

#### Sprint 3 게이트

- codegen · contract:check · typecheck · lint · format:check · build green
- focused IndexedDB/coordinator/store **37/37**, 전체 test **shared 79 유지 / web 263 / api 253** — 기준선 감소 0
- `verify:no-test-seed` 135파일 · `verify:contrast` 30/30 · `verify:font-payload` 92 faces / 2,957,724B
- E2E 직렬 **58/58**, `06-mobile` Chromium+WebKit **14/14**, axe **20화면 / violation 0**. UI 변경 범위가 아니므로 실행이 쓴 PNG·mobile metrics는 HEAD 원본으로 복원해 기준선 diff 0.

### ✅ Sprint 4 — 전체 무결성 통합 + D-31 routine ID mapping 완료

- 실브라우저·실 API·실 IndexedDB로 Chromium fault matrix를 고정했다. (1) 오프라인 세트 3개 기록 → reload → 탭 종료/새 탭 → 복구 → 서버 권위 요약 **정확히 3세트/1,500kg**, (2) 서버 적용 뒤 응답 유실 → 같은 mutation ID 재전송 → **정확히 1세트/480kg**, (3) sync 중 재오프라인 → outbox 보존 → **정확히 1세트/495kg**, (4) 두 탭에서 같은 세트를 50→70kg으로 수정 → real-clock LWW → **정확히 1세트/700kg**, (5) 외부 upsert pull이 draft 없는 탭에 65kg×8회를 만들고 최신 tombstone이 완료를 해제한다. `performed_sets` 직접 seed 없이 공개 API와 최종 UI/dashboard를 관찰한다.
- WebKit-iOS 프로젝트에서는 실제 context offline 상태에서 add/swap/즉시 기록까지 수행한다. 다만 Playwright WebKit이 offline navigation을 service worker로 넘기지 않고 내부 오류로 중단하므로, worker를 해제하고 페이지가 없는 동안 문서 transport만 복구한 뒤 API를 차단해 새 탭 IndexedDB/session/catalog 복구를 검증했다. 실제 iOS HTTPS PWA 종료/재실행 walkthrough는 TEST_SCOPE의 별도 실기기 게이트로 유지한다.
- red proof가 추가로 드러낸 공백을 fix-now 처리했다. 운동 카탈로그는 network-only라 오프라인 새 탭에서 이름을 복구하지 못해 Dexie v2 user-scoped read-through mirror를 붙였다. 전송 실패는 owner만 lease를 즉시 해제하고, 탭 crash는 15초 만료 뒤 예약 재시도한다. 기본 transport는 10초 abort timeout을 가지며, 진행 중 요청이 끝나기 전에 들어온 더 최신 trigger는 첫 요청 실패 뒤 반드시 한 번 더 실행된다.
- 전용 뮤턴트 3종을 `scripts/mutate.mjs`로 원본 SHA-256 `42603DBD…5679`에서 각각 변조했다. 응답 전 ack(`2D50E82F…`, **5/10 red**), 재시도마다 새 client_id(`0D60D66E…`, **3/10 red**), 유효 lease 무시(`4AEBD5C2…`, **1/10 red**)가 서로 다른 단언에 잡혔다. 매번 변조 SHA 확인 → 판정 → 원복 → 원본 SHA 일치 → coordinator **10/10** 재통과를 확인했고 `.mutation-snapshot`은 비웠다.
- **D-31/C-4 해소**: provisional 세트별 correlation UUID를 routine snapshot에 넣고, DB `client_correlation_id` nullable UNIQUE와 `/sync.planned_set_mappings`로 authoritative ID를 돌려준다. 재전송은 저장된 correlation으로 같은 mapping을 반환한다. performed mutation은 mapping 전 처리되지 않고 서버의 고정 routine→performed→completion 순서에서 임시 ID를 권위 ID로 정규화한다.
- shared `routine-plan`이 서버와 클라이언트의 3/5세트·목표·휴식·초기 추천을 한 규칙으로 만든다. 오프라인 화면은 이 provisional mirror를 즉시 쓰고, mapping의 전체 `PlannedSet`으로 교체한다.
- mapping 응답 commit은 drafts·pending outbox·session mirror·routine mirror를 한 Dexie transaction에서 치환한 뒤 ack한다. transaction 중간 강제 실패는 네 테이블 모두 임시 ID 상태로 롤백한다. 오프라인 add→swap→mapping 전 즉시 기록→reload→탭 종료/새 탭→온라인 복귀가 서버에 **정확히 4세트/1,900kg**으로 반영되고 임시 ID 서버 유출은 0이다.
- 전체 E2E 감사에서 outbox 전환 후 409 UI 전달 두 건을 발견해 온라인 conflict를 기존 편집 문구/권위 세션 재조회에 연결했다. 이어 pull 사각지대를 별도로 찾아, 로컬 draft가 없는 performed-set upsert 생성과 delete tombstone 해제까지 브라우저 E2E로 고정했다.
- 최종 64개 재실행은 기존 Chromium 경로의 숨은 격리·경합을 추가로 red로 만들었다. 타이머·모바일·a11y 요약은 같은 세션을 공유하던 스펙이 앞 테스트의 서버 기록을 다음 테스트에서 pull한 **STEP 6 이후의 격리 결함**이라 각 케이스에 새 세션을 배정했다. 재개 세션은 완료 해제 ack와 다음 입력이 겹칠 때 최신 outbox는 지켰지만 UI만 낡은 draft로 되감던 경합이었다. 실제 IDB draft가 바뀐 pull에만 refresh event를 내고, 사용자가 포커스한 입력은 pull/ack로 덮지 않도록 고정했다.

#### Sprint 4 최종 게이트

- codegen · contract:check **31/31** · typecheck · lint · format:check · build green
- `verify:no-test-seed` 135파일 · `verify:contrast` 30/30 · `verify:font-payload` 92 faces / 2,957,724B
- 전체 test **shared 81 / web 270 / api 256** — 기존 기준선 대비 감소 0
- E2E 직렬 **64/64**: Chromium loss/duplicate/LWW/pull/multitab/kill/reoffline + WebKit 종료 복구를 포함한다. `06-mobile` **14/14**, axe **20화면 / violation 0**, 예상 밖 실패 0. S1 온보딩 전체 흐름 **20/20 soak**다.

#### D-31 전용 뮤턴트

| 변이 | 원본 SHA-256 | 변이 SHA-256 | 발화 |
| --- | --- | --- | --- |
| mapping을 IDB transaction 밖으로 분리 | `33981E68…89872` | `2AA7DD6A…D590` | rollback 테스트에서 임시 draft가 사라져 **1/1 red** |
| correlation 재전송 시 새 planned set 생성 | `520CA490…338A8` | `C3C994A3…DD47` | 재시도 응답이 409가 되어 멱등/중복 0 테스트 **1/1 red** |
| mapping 전 performed-set 처리 허용 | `520CA490…338A8` | `DAD74DB7…6ED1` | applied 목록에서 performed mutation이 빠져 순서 테스트 **1/1 red** |

매번 `scripts/mutate.mjs` snapshot → 변이 SHA 확인 → red 판정 → 대상 파일만 restore → 원 SHA 일치 → 동일 테스트 green 순서로 실행했고 snapshot은 clear했다.

### ✅ Sprint 5 — evaluator 98/100 PASS · STEP 6 완료

| 평가축 | 배점 | 점수 | 근거 |
| --- | ---: | ---: | --- |
| 계약 잠금·red proof | 20 | 20 | 501 공통 실패를 배제한 loss/duplicate/LWW/cursor red, 데이터 있는 DB migration, OpenAPI/codegen |
| 서버 무결성 | 25 | 25 | tenant LWW, mutation/correlation 멱등, planned-set 1:1, routine→set→completion, opaque pull cursor |
| 클라이언트 원자성 | 25 | 25 | entity+outbox 및 D-31 4-store mapping transaction, rollback, lease heartbeat/fencing, 응답 전 ack 금지 |
| 실브라우저 fault matrix | 20 | 18 | Chromium 전체 행렬·WebKit process 경계·64/64. 실제 iOS HTTPS PWA 강제종료 walkthrough는 도구 밖 별도 게이트 유지 |
| 회귀·운영 증거 | 10 | 10 | 전체 게이트, 06-mobile 14/14, axe 20/0, S1 soak 20/20, 뮤턴트 3/3 사살 |
| **합계** | **100** | **98** | **PASS — STEP 6 완료, 프로젝트 총점 70 상한 해제** |

핵심 루프 `기록 → 서버 performed_set → 세션 완료 추천 재계산`은 더 이상 fixture 직접 seed에 의존하지 않는다. 완료 판정의 유일한 비차단 잔여는 실제 iOS HTTPS 설치 PWA의 OS 수준 강제종료 walkthrough이며, 자동화된 WebKit 행렬을 통과 대신 대체 증거로 과장하지 않는다.

### ✅ 세션 종료 체크포인트 (2026-08-16 01:59 KST)

- STEP 6 기술 커밋 `b3148e5`를 `origin/master`로 push했고 [GitHub Actions CI 31896676785](https://github.com/Gwonchankim/aifitcoach/actions/runs/31896676785)가 pnpm 설치부터 Chromium/WebKit 전체 E2E까지 **SUCCESS**로 끝났다.
- 커밋 직전 최종 재실행은 contract **31/31**, shared **81**, web **270**, api **256**, E2E **64/64**, `06-mobile` Chromium **7/7** + WebKit **7/7**, axe **20/0**, S1 soak **20/20**으로 위 완료 수치와 일치했다.
- Docker PostgreSQL 16(healthy)·Redis 7(running), `afc`·`afc_test`·`afc_e2e` 모두 9개 migration 적용 완료를 확인했다.
- 상세 인계와 내일 순서형 체크리스트는 `docs/SESSION_CHECKPOINT_2026-08-10.md`에 기록했다. 내일 최우선 권고는 **실기기 설치 PWA의 기록→강제종료→오프라인 재개→재동기화→추천 종단 워크스루 재실행**이다.
- 세션 종료 시점 roadmap: `[STEP 6 ✅] → 실기기 워크스루 또는 M-4′ → M-7′`.

---

### ✅ Resolved — E2E 고정 날짜와 호스트 시계 혼용 제거 (2026-08-15)

- 첫 원격 CI에서 기본 `TEST_TODAY=2026-08-14`와 실행 호스트의 `Date.now() - 1일`이 같아지며 “다른 날짜 종료 세션” 계약이 실제로 재발했다.
- `04-errors.spec.ts`가 `e2e/test-today.ts`의 `TEST_TODAY`에서 UTC 기준 전날을 계산하도록 고쳤다. 호스트 날짜와 다른 고정 날짜인 기본값으로 해당 스펙 11/11이 통과해 단일 시계 기준을 재검증했다.

### ⏭ Deferred — CI 프로젝트 런타임 Node 22+ 전환

- 현재 CI 명령은 `actions/setup-node`의 Node 20에서 실행한다. 로컬 Node 24 전체 게이트는 green이어서 명백한 Node 20 전용 의존은 없지만, CI의 Ubuntu/PostgreSQL 환경에서 Node 22+ 전체 게이트는 아직 별도로 실증하지 않았다.
- GitHub의 경고는 checkout/setup-node/upload-artifact/pnpm 액션 자체의 Node 20 런타임이 Node 24로 강제 전환된다는 알림이므로, `node-version`만 22로 바꿔서는 사라지지 않는다. 후속 CI 런타임 티켓에서 액션 major 호환성 검토와 Node 22+ 게이트 실행을 함께 처리한다.

---

## STEP 5 현재 상태 (2026-08-08 종료 시점 기록)

> **STEP 0~4는 완료**(0: 82 / 1: 88 / 2: 84 / 3: 78→뮤턴트 14/14 사살 / 4: 77→81). STEP 5만 진행 중이다.
> 게이트: typecheck / lint / format:check / build / test(**shared 79 · web 205 · api 226**) green.
> **E2E 53개는 월·수·금에만 전량 통과한다** — 아래 "남은 것" 3번(요일 의존). 다른 요일의 대량 실패는 회귀가 아니다.
>
> ### 🟢 실기기 워크스루 완료 — STEP 5의 사람 차례는 끝났다 (제품 오너, 2026-08-08)
> 제품 오너가 실기기에서 **동작을 직접 확인**했다. STEP 5 착수를 막던 blocker(함정 1: `crypto.randomUUID`
> 부재로 세트 완료 전부 실패)는 **재발하지 않았다.**
>
> ### ⏭ 다음 작업은 코드가 아니라 **UI/UX 재기획 반영을 기다리는 것**이다
> 제품 오너가 **현재 UI/UX를 새로 기획·디자인하는 중**이다(2026-08-08 시점 진행 중).
> **다음 세션의 일감은 그 산출물을 받아 반영하는 것**이며, 그것이 오기 전에는 화면을 손대지 마라.
>
> **중요 — 아래 항목들은 새 디자인에 흡수될 수 있으니 먼저 고치지 마라:**
> D-7(온보딩 죽은 공간), D-8~D-10 중 UI 관련(카드 크롬 196px/장, 360px 뷰포트),
> 세트 행 2줄 배치·RIR 셰브론+바텀시트(ADR-39/41/42)의 시각 결정.
> **새 기획이 이것들을 덮어쓰면 지금 고친 노력은 버려진다.** 기획을 먼저 받고, 무엇이 살아남는지 대조한 뒤 착수한다.
>
> **반면 아래 2건은 디자인과 무관하니 기획을 기다릴 필요가 없다** — 기획 대기 중 할 일이 필요하면 여기서 고른다:
> "남은 것" **2번(테스트 격리)** 과 **3번(E2E 요일 의존)**. 둘 다 **STEP 6 착수 전 필수**다.

### 끝난 것
- **F0~F8 전 화면 구현**: 온보딩 7스텝(통증 칩·운동 경력 포함) / 프로그램 확인(제외 운동·사유) / 대시보드 / 데일리 루틴(세트 로깅·휴식 타이머·루틴 편집·통증 기록·운동 종료·요약).
- **백엔드**: `GET /exercises`, `GET /dashboard`, `POST /sessions/ad-hoc`(즉석 세션), 당일 수정 허용, CORS(`WEB_ORIGIN`), dotenv 로드.
- **UI 재설계(오늘)**: 온보딩 하단 버튼 배치(ADR-42), 세트 행 4줄 → **2줄**(15세트 3,178 → **2,698px**), RIR 통합, 운동 카드 휴지통(ADR-40), 완료 행 대비 위반 해소(ADR-41).
- **blocker 수정(오늘)**: `crypto.randomUUID`가 실기기(비보안 출처)에서 없어 **세트 완료가 전부 실패**하던 문제(ADR-35). 실기기 조건을 `addInitScript`로 재현하는 회귀 테스트 추가.
- **검증 인프라**: Playwright E2E 50개, axe 17화면 위반 0, Lighthouse(프로덕션 빌드) 성능 98~100 / 접근성 100 / BP 100.

### 오늘 마지막에 처리한 5건 (전부 완료, 커밋됨)
| # | 결함 | 조치 |
|---|---|---|
| D-4 | RIR 목록 선택이 **iOS에서 불가능**(스펙이 탈락시킨 `datalist` 채택) | 입력칸 + 칸 안쪽 셰브론 → **바텀 시트**(모름/0~6). 셰브론은 `tabindex="-1"`(Tab 정거장 불변), `↑/↓` ±1, `Alt+↓` 시트. **webkit-ios에서 실제 tap 경로를 E2E로 고정**(ADR-39) |
| D-5 | 완료 행 디스클로저 미구현(AC-SET-6/7/8) | 요약 텍스트가 디스클로저 버튼(접근 이름에 무게·횟수·RIR·"완료" 포함), 탭하면 펼쳐 수정하되 **완료 유지 + 휴식 타이머 미오픈**, 동시 펼침 1개 |
| D-3 | 요약 "980kg" ↔ 대시보드 "기록한 세트는 없어요" | 서버 0 + 로컬 기록 있음일 때만 "이 기기에만 있는 기록이라 연결되면 요약에 반영돼요". STEP 6에서 조건이 자연히 죽는다 |
| D-1 | 즉석 세션 방치가 스트릭을 4→2로 파괴 | `workout_sessions.origin: planned\|ad_hoc` 추가. 스트릭의 "계획된 날"은 `planned`만, `weekly_completion_rate`는 **계획 준수율**로 정의 고정(즉석 세션을 분모·분자 양쪽에서 제외) |
| D-2 | `wrist` 사용자의 즉석 세션에서 머신/케이블 배려 소실 | `excluded_exercises`에 **제외 0건 부위도 마커 항목을 저장**(응답에서는 필터링 → 계약 변경 0, 기존 테스트 무변경) |

### 남은 것 (우선순위 순 — 다음 세션의 작업 목록)
- ~~**D-6 스펙-구현 divergence 기록**~~ → **완료(2026-08-06)**. `UX_STATES.md` §2.4.1 폭 예산(실측·단위 접미사 제거)·§2.4.2·§2.4.4·§7.1·§7.2 M-3(폐지)·AC-DEL-6·AC-RIR-4를 구현에 맞춰 갱신. **원천 대조에서 `FEATURES_UX.md` 쪽 모순 2건도 발견해 함께 수정**(F5의 "[편집] = 추가·교체" 문구, F1-1의 "입력 옆에").
- ~~**문서 드리프트 2건**~~ → **완료**. `DATA_MODEL.md`에 `workout_sessions.origin`과 `excluded_exercises` 마커 규약 반영.
- ~~**AC-RIR-4**~~ → **완료(제품 오너 결정 2026-08-06)**. **2줄차 배치 + `aria-describedby` 연결을 정식 채택**. 목표가 화면에 보이고 스크린리더에 연결되면 의도는 충족되며, 좁은 화면에 한 줄로 욱여넣으면 오히려 가독성이 나빠진다.
- ~~**CLAUDE.md 실행 명령 stale**~~ → **완료**. 실제 스크립트·`.env` 필수 항목·포트 3000 고정·E2E·실기기 HTTPS까지 반영해, **새 세션이 CLAUDE.md만 읽고도 앱을 띄울 수 있다.**
- ~~**실기기 워크스루 준비**~~ → **완료(2026-08-08)**. `docs/DEVICE_WALKTHROUGH.md` + `pnpm --filter web dev:lan`. 절차를 글로만 쓰지 않고 **실제로 실행해 검증**했다(인증서 체인 `Verify return code: 0 (ok)`, LAN HTTPS 에서 `/api/v1/dashboard` 200, WebKit 390×844 콘솔 에러 0, 대시보드 실데이터 렌더). **막힐 문제 3개를 미리 사살**했다 — ADR-44/45/46 참조: ① 자동 생성 인증서 SAN 에 LAN IP 없음(+기동 시 덮어씀) ② HTTPS→`http://:3001` 혼합 콘텐츠 ③ Git Bash 가 `/api/v1` 을 `C:/Program Files/Git/api/v1` 로 경로 변환. **CORS·`WEB_ORIGIN` 은 손대지 않았다**(프록시가 same-origin 이라 불필요, 바꾸면 `00-api-cors` 회귀 스펙이 깨진다).

### 2026-08-08 세션에서 한 일 (커밋 3개)
| 커밋 | 내용 |
|---|---|
| `b24aab9` | CLAUDE.md 실행 명령 갱신, D-6 스펙-구현 divergence 정리, DATA_MODEL 드리프트 2건, AC-RIR-4 확정 |
| `43ee46d` | 실기기 HTTPS 워크스루 준비 — `pnpm --filter web dev:lan` + `docs/DEVICE_WALKTHROUGH.md` (ADR-44/45/46) |
| `9c4a3b5` | IP 변경 시 인증서 재발급 절차(§2.1), 현재 IP `192.168.0.174` 반영 |

**절차서를 글로만 쓰지 않고 실행해서 검증했더니 폰에서 확실히 막힐 문제가 3건 나왔다**(→ CLAUDE.md 함정 7·8):
① `--experimental-https` 자동 생성 인증서 SAN 에 LAN IP 없음 + **기동할 때마다 덮어씀** → `lan.pem` 분리(ADR-44)
② HTTPS 페이지 → `http://:3001` 혼합 콘텐츠 차단 → Next `rewrites` same-origin 프록시(ADR-45)
③ Git Bash 가 `NEXT_PUBLIC_API_BASE_URL=/api/v1` 를 `C:/Program Files/Git/api/v1` 로 경로 변환.
   next.config 의 `process.argv` 우회도 **Next 15 가 설정을 자식 프로세스에서 로드해 실패** → `scripts/dev-lan.mjs`(ADR-46)

**보안**: 생성된 개인 키(`apps/web/certificates/`)가 gitignore 되지 않은 상태였다 → 추가.

**검증 명령의 함정 2개도 문서에 박았다**: IP SAN 에는 `-verify_hostname` 이 아니라 **`-verify_ip`**(전자는 DNS 이름만 대조해 mismatch),
`curl --cacert` 는 Windows schannel 이 사설 CA 의 폐기 상태를 확인 못 해 체인이 멀쩡해도 `curl: (60)` 이 난다.

### ✅ M-UIa — **완료** (2026-08-09) · evaluator 71/100 CONDITIONAL PASS → fix-now 7건 처리 후 종료

커밋: `d3b16ff`(Sprint1 토큰·폰트) · `48390c1`(Phase B 공용UI+대비CI) · `c347b06`(Phase C 화면3종+빈 상태) · `<fix>`(Step 4 fix-now).

#### 사람 결정 승인 트레일 (2026-08-09)
D-1 진입로 **아예 뺀다** / D-2 4탭 네비 **별도 티켓, M-4′ 직전** / D-3 치수 **UIb** /
D-4 통증 칩 **새 색 없이** / D-5 홈 빈 상태 카피 **UIa 포함** — **전부 권장안대로 승인**.
추가 지시: `success-bg` 변경 금지를 ADR 로(→ ADR-51), 토큰 대비 재계산을 CI 로(→ `verify:contrast`).
> **D-4 는 승인 후 구현 중 세 번째 안이 나와 자체 채택했다**: `--afc-warn-fg` 를 흰색이 아니라 `#151A21` 로 두면
> 기존 `bg-warn text-warn-fg`(Badge)가 그대로 6.09:1 이 된다 — 새 색도 컴포넌트 수정도 없다.
> 승인안 (b)(소프트 배지)는 Sprint 2 에서 Badge 에 적용했고 (c)는 토큰 기본값 안전망으로 남겼다. DESIGN_TOKENS §3.1.1 기록.

#### evaluator 스코어카드 (독립 재현 기반)

| 축 | 배점 | 획득 | 근거 |
| --- | --- | --- | --- |
| 게이트·회귀 방어 | 25 | 18 | 전 게이트 재현. 뮤테이션 3종 재현 + 자체 설계 5종 중 3종 추가 사살(6/8) |
| 범위 준수·예측 정확도 | 12 | **12** | `git diff` 로 **0 / 0 / 1** 확인 — 주장과 정확히 일치. 금지 항목 유입 0건 |
| 디자인 충실도 | 18 | 12 | 색 ~75% / 타이포 ~80% / 형태 ~60%. 주 CTA 파랑, 칩·배지 알약 |
| UI 구현 품질 | 12 | 9 | ADR-41 준수(`opacity-` 0건), 접근 이름 불변 |
| UX·접근성 | 14 | 10 | axe 18화면 0, 대비 29/29, 빈 상태 3요소 충족·자물쇠 0 |
| 문서·프로세스 | 9 | 5 | ADR-51 **실패 방향이 반대로 기술됨**(실측 반증), 승인 트레일 부재 |
| 성능·자산 | 10 | 5 | 셀프호스팅 판단은 타당하나 **측정 0건**(Lighthouse 미실행), 폰트 1.16MB |
| **합계** | **100** | **71** | **CONDITIONAL PASS** — 하드 게이트 전부 PASS |

**(A) 홈 빈 상태**: 3요소 충족, 자물쇠 0건, `②는 "세 세션"`(ADR-47 문자 단위 일치). 프로토타입 대비 톤 차이와
"만들고 나면" 위계 인플레(9.5px 키커 → 16px h3)는 남음.
**(B) 테스트 3건 수정**: 약화 아님. 6/8 사살, 목표 테스트는 오히려 강해짐. 생존한 M6·M7 은 **이번 수정이 만든 빈틈이 아니다**
(옛 정규식도 모노를 단언한 적 없다) — 다만 "숫자는 모노"를 지키는 테스트가 레포에 0건이라는 사실은 남는다.
**(C) 지켜볼 값 2건**: 둘 다 주입 실험으로 **발화 확인**. AC-S1-6 은 `min-h-[52dvh]` 한 상수가 결정하고, CI 에 E2E 가 없다.

#### Step 4 fix-now 처리 결과

| # | 이슈 | 조치 |
| --- | --- | --- |
| F4 | **`.mutation-snapshot/` 스테일 → 인자 없는 `restore` 가 대비 표를 29→27 로 조용히 롤백** | `mutate.mjs` 에 **인자 없는 restore 차단**(`--all` 필요) + `clear` 추가. 스냅샷 정리 |
| F5 | ADR-51·DESIGN_TOKENS 의 **실패 방향이 반대** | 실측으로 정정: 깨지는 방향은 **어둡게**(#EEF7F1 4.499 / #EDF6F0 4.459), 밝게는 오히려 상승(#F0F9F3 4.578) |
| F6 | `verify:contrast` 가 **반올림 후 비교** → 4.495~4.4999 통과 | 원값 비교로 수정. 재현: `#EEF7F1` → **4.4989:1 실패**. 부족분 0.01 미만이면 4자리로 출력 |
| F3 | **신설 빈 상태에 회귀 그물 0** + axe 미스캔(함정 5 재발) | 3단 안내·`세 세션`·자물쇠 부재·"한 종목만" 부재를 단언. **`S3-dashboard-empty` axe 스캔 신설**. 뮤테이션(`세 세션`→`세 세트`)으로 발화 확인 |
| F2 | 칩·배지가 `rounded-full`(§5 는 2px) | `rounded-control` 로. 진행 바·시트 손잡이는 막대라 유지 |
| **F1** | **주 CTA 가 ink 가 아니라 파랑** | **해결(사람 결정 (a) → ADR-52)** — 아래 |

> **정정**: evaluator 는 F1·F2 를 UIa 산출물로 보았으나, `git show 24790cf` 로 확인하니 `bg-primary`·`rounded-full` 은
> **UIa 이전부터 있었다.** UIa 가 만든 회귀가 아니라 **닫지 않은 divergence** 다. F2 는 §5 가 명확해 지금 닫았고,
> F1 은 문서가 서로 다르게 말해(§2.1 "ink = 기본 버튼 배경" vs §7 "primary = #1B4FC4") 임의로 정할 수 없다.

#### F1 해결 — "파랑 = 상태/정보, ink = 액션" (사람 결정 2026-08-09, **ADR-52**)

역할 토큰 `--afc-action #151A21` / `--afc-action-fg #FFFFFF` 를 신설해 `fg`(글자색)와 **역할로 구분**했다.

| 바뀐 것(→ ink) | 그대로 파랑(상태·정보) |
| --- | --- |
| 주 버튼(Button primary) · 대시보드/프로그램/요약 CTA · 건너뛰기 링크 | 라디오 점 · 체크박스 · 눈금 채움 · 진행 바 |
| **선택된 분절 칩**(성별·일수·시간·장비·통증부위) | **라디오 카드 선택**(목표·경력) = 소프트 `primary-bg` |
| **선택된 탭** | 링크 · 추천값 · 소프트 상태 배지(`Badge primary`) |

프로토타입 실측 근거: `chipStyle(on)` = `#151A21`, 탭 선택 = `#151A21`, `radio(on)` = `#1B4FC4`+`#EFF3FC`, `chip('live')` = 소프트.
온보딩의 `SELECTED_SOFT` 오버라이드 6곳을 제거했다(분절 칩은 이제 Chip 기본값이 ink 반전이다). 라디오 카드 2곳만 남는다.

**회귀 방어**: `test/action-color.test.ts` 14건 신설. 뮤테이션으로 발화 확인 —
CTA 를 파랑으로 되돌리면 **2건 실패**, 배지를 솔리드로 되돌리면 **1건 실패**.
**같은 뮤턴트를 `verify:contrast` 는 통과시킨다**(ink 17.48 / 파랑 7.09 로 둘 다 AA) — 사각지대가 실증됐다.

#### F2 판단 — 프로토타입 원칙에 맞추는 게 맞다 (이미 조치)

F1 과 같은 성격이다(UIa 이전부터 있던 divergence). 다만 **F1 과 달리 문서가 모호하지 않다** —
`DESIGN_TOKENS §5` 가 "radius 1px(게이지·바) / 2px(칩·버튼·입력) / 3px(카드·시트)"로 못 박았고 프로토타입도 그대로다.
해석 여지가 없어 Step 4 에서 바로 닫았다: `Chip`·`Badge`·`ScaleOption` → `rounded-control`(2px).
**진행 바 채움과 시트 손잡이는 `rounded-full` 로 남겼다** — 얇은 막대라 프로토타입의 radius 1px 과 시각적으로 같고,
2px 를 주면 오히려 각져 보인다. 이건 예외가 아니라 §5 의 "1px = 게이지·바" 항목에 해당한다.

#### 성능·자산 — **UIa 에서 측정했다. 회귀를 찾았다.**

"UIb 이후로 묶을지" 판단하려고 먼저 쟀는데, **재기로 한 판단이 맞았다** — 회귀가 실재한다.

| | 2026-08-05(UIa 이전) | 2026-08-09(UIa 이후) |
| --- | --- | --- |
| desktop-dashboard performance | **100** | **92** |
| accessibility | 100 | 100 |

원인은 명확하다: **Pretendard 4웨이트 × 262KB = 1,051KB** 가 대시보드에서 전부 내려온다(페이지 총 1,200KiB).
`preload: false` 는 이미 걸려 있지만 화면이 4웨이트를 **실제로 쓴다**(semibold 28 · bold 14 · medium 10 · normal 4)
→ preload 문제가 아니라 **서브셋 크기 문제**다. KS X 1001(2,350자) 서브셋이 웨이트당 262KB 다.

→ **`T-UI-2 폰트 페이로드`, UIb 착수 전 필수.** UIb 가 이 위에 쌓이면 이후 성능 변화가 폰트 탓인지 UIb 탓인지 못 가린다.
해법 후보: ① `unicode-range` 동적 서브셋(Pretendard 가 공식 제공, 통상 30~80KB로 떨어진다) ② 웨이트 4→2 축소(약 524KB 절감,
단 `font-medium`/`font-semibold` 가 인접 웨이트로 스냅돼 **디자인 충실도와 상충** — F1 직후라 임의로 정하지 않는다).
**①이 정공법이다.** 지금 바로 못 한 이유: 패키지를 안 쓰고 woff2 를 직접 받아 둔 구조라 서브셋 파일 100여 개를 새로 조달해야 한다.

#### (C) 회귀 방어 보강 — **CI 에 E2E 를 넣었다**

evaluator 지적대로 AC-S1-6·axe·실렌더 대비는 **CI 에 없어서 사람이 로컬에서 돌 때만** 발화했다.
대안(상수 변경 시 실패하는 단위 테스트)은 **더 약하다** — AC-S1-6 은 `min-h-[52dvh]` 하나가 아니라
타이포·여백의 합으로 결정되는 **렌더 값**이라, 상수만 지키는 테스트는 타이포를 줄여 깨지는 경로를 못 잡는다.
그래서 진짜로 재는 쪽을 CI 에 넣었다.

- `npx playwright install --with-deps chromium webkit` + `pnpm --filter web test:e2e`
- Playwright 가 API(:3101, `<db>_e2e`)·웹(:3000)을 스스로 띄운다. DB 는 `migrate deploy` 가 만든다(실측 확인).
- 실패 시 `.artifacts`/`.report` 를 아티팩트로 올린다.
- **로컬에서 확인한 것**: YAML 파싱(16스텝), `FIELD_ENCRYPTION_KEY` 플레이스홀더가 정확히 **32바이트**
  (처음 넣은 값은 34바이트라 API 가 부팅에 실패했을 것이다), env 만으로 `afc_test → afc_test_e2e` 파생.
- **확인 못 한 것**: GitHub Actions 실행 자체. 첫 PR 에서 확인해야 한다. 예상 추가 시간 4~6분.

#### 후속 티켓 배치 (evaluator 제안 채택 + T-UI-2 추가)

| 티켓 | 배치 | 근거 |
| --- | --- | --- |
| `cn` → tailwind-merge (지금 `!` 4곳 우회) | **별도 `T-UI-1`, UIb 착수 직전 선행** | 앱 전체 className 해소 순서를 바꾸는 **횡단 변경**. UIb 와 섞으면 시각 회귀 원인을 못 가린다(a/b 분리 논리와 동일). 동시에 UIb 의 새 variant 가 같은 충돌을 다시 밟으므로 **선행**이기도 하다 |
| 한글 혼합 문자열 모노화(순수 함수 → ReactNode) | **UIb** | D-15의 완료행 1줄 축약을 반영하며 세트 행·요약 행 DOM을 함께 다룬다. **이 티켓에서 "숫자는 모노" 단언을 신설**해 F7 빈틈까지 닫는다 |
| Chip 소프트 어법 통일 | **UIa 잔여(small)** | F2 와 같은 파일·같은 결함 계열. 지금 안 고치면 UIb 의 새 칩이 잘못된 base 를 상속한다. 소프트 선택은 **새 조합을 만드니 `verify-contrast` 표에 추가 필수** |

#### defer (UIb 또는 별도)
F7 모노 보호 테스트 0건(위 티켓 2와 함께) · F8 E2E 산출물 churn(별도 위생) · F9 "만들고 나면" 위계 ·
F10 폐루프 가치 문장 소실 · F11 톤 전환(오너 판단) · **F12 CI 에 E2E/axe 없음(별도 CI 티켓, UIb 선행 권장)** ·
**T-UI-2 폰트 페이로드(UIb 착수 전 필수, 완료)** · F14 **한글 키커 대체 어법 미설계** — 프로토타입의 지배적 모티프(139회)를 구현은 3곳만 쓴다. **D-18에 따라 UIb를 막지 않는 별도 디자인 티켓**으로 처리한다.

**골든/보안·PIPA/데이터 손실 defer: 0건.**

---

### 완료된 착수 계획 (참고용 기록) — M-UIa (2026-08-09 수립)

#### 결론 먼저 — 범위를 제가 제안드린 것보다 **더 좁혀야** 합니다

"UIa 는 인터랙션 불변이라 기존 E2E 가 그물이 된다"는 전제를 실제 스펙과 대조해 보니, **치수(터치 타깃·밀도)를
UIa 에 넣으면 그 전제가 깨집니다.** `06-mobile.spec.ts` 가 픽셀을 직접 재기 때문입니다.

| 스펙 | 단언 | 확정안 값 | 결과 |
| --- | --- | --- | --- |
| `06-mobile:69` | 완료 체크 `min(w,h) ≥ 48px` | **48×48px**(D-16) | **유지** |
| `06-mobile:166` | 세트당 평균 높이 `< 190px` | 타이포가 작아져 값이 내려감 | 통과 예상(값은 바뀜) |
| `06-mobile:169-170` | 미완료 행 `≤96` / 완료 행 `≤64` | 행 구조는 UIb | UIa 에선 불변 |
| `06-mobile:256` | 버튼 아래 여백 `≥24px`(AC-S1-8) | 프로토타입 패딩 **18px** | **따라가면 깨진다** |

→ **UIa = 색 · 타이포 · 형태(radius/테두리/그림자 제거)만.** 치수는 UIb 로 넘긴다.
이렇게 하면 E2E 54개 중 **문구·역할 기반 47개가 그대로 그물로 남고**, 위험은 axe(대비)와 밀도 수치 2곳으로 좁혀진다.

#### 1) 범위 분류

| 항목 | 배치 | 근거 |
| --- | --- | --- |
| 토큰 교체(색·타이포·radius·테두리) + 기존 4화면 리스킨 | **UIa** | 의미 토큰이라 이름은 유지되고 값만 바뀐다. 역할·문구·DOM 구조 불변 → E2E 무손상 |
| **치수**(완료 체크 72→48×48, 밀도 예산) | **UIb** | D-16으로 계약 잠금. 행 구조 반영과 함께 재측정한다 |
| 빈 상태 **신설**(홈 "만들고 나면" 3단, "세 세션이 쌓이면", 기록 "시작하는 법") | **UIa(홈만) / M-4′(기록)** | 홈 빈 상태는 **새 카피지만 신규 인터랙션·API 가 없다**. 기록 탭은 탭 자체가 M-4′ 라 그때 같이. 단 `01-...:108`("운동 계획을 먼저 만들어 주세요.") 단언 1건은 갱신해야 한다 |
| **4탭 하단 네비**(오늘/기록/프로그램/내 정보) | **별도 티켓 `UIa-nav` 또는 M-4′** | 리스킨이 아니라 **신규 네비게이션**이다: 라우트 2개 신설·활성 상태·랜드마크·전 화면 하단 높이 변화 → 밀도 예산과 AC-S1-6/8 을 전부 다시 재야 한다. 게다가 지금 붙이면 **탭 2개가 빈 화면으로 열린다** — 없는 것보다 나쁘다 |
| **"프로그램 없이 오늘 한 종목만 기록" 진입로** | **UIa 아님** | R-04. `workout_sessions.program_id` 가 NOT NULL FK 라 **백엔드 변경이 선행**된다. 표시 방식은 **D-1** |
| 완료행 1줄 · 3항목 `⋯` 앵커 메뉴 · 기존 RIR 입력 유지 | **UIb** | D-13~D-17 계약에 따라 세션 E2E와 접근성 AC를 갱신 |
| 프로토타입 화면의 엔진 수치 표기(−15%/−10% 등) | **UIa 에서 제거하거나 "예시" 표기** | ADR-49(M-ENGINE′ 보류) 이행 |

#### 2) E2E 영향 사전 산출 (54개 기준)

| 분류 | 개수 | 스펙 | 예상 |
| --- | --- | --- | --- |
| 영향 없음(역할·문구 기반) | **47** | 00-api-cors 4, 00-clock 1, 02 3, 03 6, 04 10, 07 2, 08 7, 01 중 2, 06 중 나머지 | 그대로 통과 |
| **대비 재검증 필요** | **6** | `05-a11y` 전부 | §3 사전계산으로 20/21 통과 확인. **D-4 결정 후 재측정** |
| **문구 단언 갱신 1건** | **1** | `01-…:108` 빈 상태 문구 | 홈 빈 상태를 새로 쓰면 갱신(약화 아님 — 새 문구로 교체) |
| **밀도 수치 변동** | (06 중 2개 테스트) | `06-mobile` perSet·rowHeight | 임계 유지, 기록값(`mobile-metrics.*.json`) 갱신 |

> 즉 **UIa 에서 손대야 할 테스트는 최대 1건(문구)** 이고, 나머지는 값 재측정이다.
> 치수를 UIa 에 포함하면 여기에 **최소 1건이 더 깨진다**(완료 체크 48px).

#### 3) 대비 사전 검증 — 완료

D-1 승인 보정을 넣고 **실사용 21조합** 전수 계산(계산기 자가검증 통과). → `docs/DESIGN_TOKENS.md` §3.1.1
- **20/21 통과.** 미달 1건: **흰 글자 on `warn` 면 `#D08A00` = 2.87:1**(통증 4~6 선택 칩) → **D-4**
- 여유 없는 조합: `success #198146` on `success-bg` = **4.54:1**. `success-bg` 는 건드리지 말 것.

#### 4) 승인 대기 — D 항목

| # | 결정 | 선택지 |
| --- | --- | --- |
| **D-1** | "프로그램 없이 오늘 한 종목만 기록" 진입로 | (a) **아예 뺀다**(권장) — 비활성 CTA 는 "이 앱은 이걸 못 한다"를 가르치고, 안내 문구를 만들었다 버리게 된다 / (b) 비활성으로 표시 |
| **D-2** | 4탭 네비 배치 | (a) **별도 티켓 `UIa-nav`, M-4′ 직전**(권장) — 탭이 열 화면이 생긴 뒤에 붙인다 / (b) UIa 에 셸만 + 빈 탭 / (c) M-4′ 안에 포함 |
| **D-3** | 치수(터치 타깃·밀도)를 UIb 로 미루는 것 | (a) **UIb**(권장, 위 표) / (b) UIa 에 포함하고 `06-mobile` 임계를 함께 갱신 |
| **D-4** | 통증 4~6 선택 칩의 대비 미달 | (a) **면 `warn-bg` + 글자 `warn-ink`**(권장) — 새 색 불필요, 5.14:1 / (b) 면을 `#A16B00` 으로 어둡게(4.55:1), 새 색 1개 |
| **D-5** | 홈 빈 상태 새 카피를 UIa 에 넣을지 | (a) **넣는다**(권장) — 지금 화면이 한 줄뿐이라 리스킨해도 프로토타입과 안 닮는다 / (b) M-4′ 로 미룬다 |

D-3·D-4 는 착수를 막는다(범위와 색이 정해져야 시작). D-1·D-2·D-5 는 UIa 안에서 순서만 바꾸면 되므로 착수 후 결정해도 된다.

---

### ✅ 마일스톤 [테스트 격리 + E2E 요일] — **완료 (2026-08-09)**

커밋: `6ef05d3`(T-1) · `1601c31`(T-2) · `0e32594`(T-3·T-4).

| | 기준 | 전(실측) | 후(실측) |
| --- | --- | --- | --- |
| **G1** | 같은 스위트 동시 2회 | A **33 failed** / B **29 failed** | **둘 다 235/235, exit 0** |
| **G2** | 개발 DB 무오염 | E2E 가 `afc` 에 programs 818행 누적 | 실행 전후 **885/5,297 동일**(데이터는 `afc_e2e` 로) |
| **G3** | 사람이 아무것도 안 띄워도 됨 | API 를 미리 안 띄우면 프록시 500 | 포트 전부 비운 상태에서 **명령 하나로 54/54** |
| **G4** | 요일 독립 | 일요일 **17 failed / 22 미실행** | 일요일에 **54/54** |
| **G5** | 뮤테이션으로 실효성 증명 | — | **6종 전부 사살**, sha256 원복 대조 |

**뮤테이션 6종**: ①`utcToday()` 오버라이드 무시 → 6건 실패 ②프로덕션 가드 제거 → 3건 ③고정 dev-user 로 되돌림 → 1건
④개발 DB 분리 제거 → 2건 ⑤앱 소스에 테스트 시드 주입 → `verify:no-test-seed` 실패(lib·components 양쪽)
⑥브라우저 시계 제거 → `00-clock` 실패.

**새로 넣은 가드 3개**(없던 자리): `e2e/00-clock.spec.ts`(서버·브라우저·상수가 같은 날짜인지),
`test/e2e-db-url.test.ts`(E2E 가 개발 DB 를 쓰지 않는지), `test-overrides.spec`(스위트가 실제로 핀이 걸린 채 도는지).

#### 격리가 드러낸 결함 2건 (원래 있던 문제, 이번에 보였다)

1. **`programs.spec` 의 단언이 DB 전체를 대상으로 하고 있었다.**
   `program.count({ userId: { not: USER_ID } })` 로 "다른 사용자 소유 데이터 0" 을 검사 —
   다른 실행의 데이터가 있으면 **원리적으로 통과할 수 없다**. 검증 대상인 "이 요청이 만든 것"으로 좁혔다.
   사용자 간 격리 자체는 `tenancy.spec` 이 두 사용자를 세워 따로 검증한다(약화 아님).
2. **포트를 바꿔 띄우면 CORS 가 전부 막혔다.**
   E2E API 가 루트 `.env` 의 고정 `WEB_ORIGIN`(`localhost:3000`)에 기대고 있었다.
   `E2E_WEB_PORT=3200` 으로 띄우니 브라우저 fetch 가 통째로 실패(37건). 실행마다 `WEB_ORIGIN` 을 API 에 넘겨 해결.

#### Defer — 동시 E2E 실행 (별도 티켓)

**데이터 격리는 됐다**(전용 DB `afc_e2e` + 실행 단위 `DEV_USER_ID`). 남은 것은 **프로세스 수준**이다:
두 실행이 `apps/api/dist` 를 함께 써서 동시에 `nest start` 가 돌면 `Cannot find module './programs.service'` 로 죽는다.

> **성격이 중요하다 — 이건 조용한 데이터 오염이 아니라 시끄러운 실패다.**
> 기본 포트에서는 포트 충돌로 즉시 멈추고, 포트를 바꿔도 빌드 에러로 즉시 멈춘다.
> 잘못된 결과가 green 으로 나오는 경우가 없으므로 **STEP 6 의 "중복·유실 0" 단언을 위협하지 않는다.**

푸는 법: 러너별 outDir 분리가 필요한데 `tsc` outDir 은 환경변수로 못 바꾼다(생성 tsconfig 가 필요).
비용 대비 효용이 낮아 미룬다. 필요해지면 착수한다.

---

### 완료된 착수 계획 (참고용 기록) — [테스트 격리 + E2E 요일] (2026-08-09 수립)

#### 진단 정정 — 기존 기록이 틀렸다

아래 2·3번에 "api 테스트·E2E가 **같은 `afc_test`**" 라고 적혀 있었으나 **실측 결과 다르다.**

| | 실제 |
| --- | --- |
| api 테스트 | `afc_test`(파생 DB), globalSetup 이 migrate+seed, **`maxWorkers: 1`(직렬)** |
| E2E | 사람이 띄운 API(:3001) → 루트 `.env` 의 **개발 DB `afc`** |
| spec 간 격리 | `resetUserData(prisma, userId)` 를 DB 쓰는 spec 8개가 전부 호출(읽기 전용 2개는 불필요) → **한 번의 실행 안에서는 이미 격리돼 있다** |

**진짜 결함 4가지**
1. **같은 스위트를 동시에 2회 돌리면 서로를 지운다.** `resetUserData` 가 **고정 `DEV_USER_ID`** 를 지우므로 A 의 리셋이 B 의 데이터를 날린다(함정 6 실측: 15초에 프로그램 6개).
2. **E2E 가 개발 DB 를 오염시킨다.** 실측 `afc`: programs 818행 / sessions 4,897행. 실기기 워크스루 중에 E2E 를 돌리면 서로의 "오늘 세션"을 갈아치운다.
3. **E2E 가 API 를 스스로 띄우지 않는다.** 사람이 3001 을 미리 띄워야 하고, 안 띄우면 프록시가 500 을 준다(2026-08-08 실제로 겪음). 재현성이 사람 손에 달려 있다.
4. **요일 의존.** `DEFAULT_PROGRAM.days_per_week = 3` → MON/WED/FRI.

#### 요일 배정의 구조적 공백 (실측)

| 요일 | 운동일로 만들 수 있는 `days_per_week` | 휴식일로 만들 수 있는 값 |
| --- | --- | --- |
| MON | 2,3,4,5,6 | **없음** ← |
| TUE | 4,5,6 | 2,3 |
| **WED** | **3,5,6** | **2,4** |
| THU | 2,4,6 | 3,5 |
| FRI | 3,4,5,6 | 2 |
| SAT | 5,6 | 2,3,4 |
| SUN | **없음** ← | 2,3,4,5,6 |

→ "요일에 맞춰 `days_per_week` 를 고르기"로는 **7일 중 2일을 못 덮는다**. 그래서 날짜를 고정한다(**ADR-50**).
**고정 날짜 = `2026-08-12`(수)** — 수요일은 운동일(3/5/6)과 휴식일(2/4)을 **한 날짜로 둘 다** 만들 수 있다(F8-1 이 휴식일을 요구한다).

#### 성공 기준 (이걸로 완료를 판정한다)

| | 기준 | 검증 방법 |
| --- | --- | --- |
| G1 | 같은 스위트를 **동시에 2회** 돌려도 둘 다 통과 | 두 프로세스 동시 실행. **착수 전에 먼저 실패를 확인**한다(전/후 비교) |
| G2 | E2E 를 돌려도 **개발 DB `afc` 행 수가 변하지 않는다** | E2E 전/후 `programs`·`workout_sessions` count 비교 |
| G3 | 사람이 아무것도 안 띄워도 **`pnpm --filter web test:e2e` 하나로 끝난다** | 포트 전부 정리 후 단독 실행 |
| G4 | **요일 7개 전부**에서 전량 통과 | 고정 날짜를 월~일 7개 값으로 바꿔가며 스위트 실행 |
| G5 | 위 4개가 회귀로 고정된다 | **뮤테이션**(고의 주입 → 실패 확인 → 원복) |

#### 티켓 (순서대로)

**T-1 요일 고정** ✅ **완료(2026-08-09, 6ef05d3)** — 먼저 해야 나머지 실패가 요일 탓인지 격리 탓인지 갈린다
- `utcToday()` **한 곳**에 오버라이드를 넣는다. "오늘" 계산은 이미 여기 하나로 모여 있다(실측: api 전체에서 `new Date()` 3곳뿐, 그중 "오늘"은 이 함수 하나).
- `programs.service.ts:117` 의 `mondayOfWeek(new Date())` → `mondayOfWeek(utcToday())`.
- 주입: jest `globalSetup`, playwright `webServer.env`. 브라우저 쪽 `apps/web/lib/utc-day.ts` 는 Playwright `context.clock.setFixedTime()` 으로 같은 날짜를 보게 한다(ADR-38 당일 판정이 서버·클라 양쪽에 있다).
- `sessions.service.ts:102` 의 `completedAt: new Date()` 는 "오늘"이 아니라 타임스탬프라 **건드리지 않는다**(대시보드는 `scheduled_date` 로 판정).
- **verify(G4)**: 고정 날짜를 7요일로 바꿔 7회 실행 → 전량 통과.

**T-2 E2E 자체 기동 + 개발 DB 분리** ✅ **완료(2026-08-09)** (T-3 보다 먼저 — 자체 API 가 있어야 거기에 run-scoped 신원을 주입할 수 있다)
- playwright `webServer` 를 **배열**로: `[api(:3101), web(:3000)]`. `helpers.API` 기본값을 3101 로.
- E2E 전용 DB `afc_e2e` + migrate/seed 1회.
- **`WEB_ORIGIN` 은 건드리지 않는다** — 웹 포트가 3000 그대로라 `00-api-cors` 회귀 스펙이 살아 있다(스펙의 3001 은 주석뿐, 코드는 `E2E_API_TARGET` 을 읽는다).
- **verify(G2·G3)**: 포트 전부 정리 → 단독 실행 성공 + `afc` 행 수 불변.

**T-3 실행 단위 격리(run-scoped user)** ✅ **완료(2026-08-09)**
- api: `globalSetup` 이 실행마다 UUID 를 만들어 `DEV_USER_ID` 로 쓰고, `globalTeardown` 이 그 사용자 데이터+행을 지운다.
- E2E: 자체 기동 API 에 run-scoped `DEV_USER_ID` 주입.
- **verify(G1)**: 동시 2회 실행 → 둘 다 통과.

**T-4 회귀 고정 + 뮤테이션** ✅ **완료(2026-08-09, 뮤턴트 6종 전부 사살)**
- 뮤턴트 ①: `utcToday()` 오버라이드 무시 → 요일 가드가 실패해야 한다
- 뮤턴트 ②: run-scoped user 대신 고정 user → 동시 실행 가드가 실패해야 한다
- 뮤턴트 ③: E2E `DATABASE_URL` 을 `afc` 로 → 개발 DB 무오염 가드가 실패해야 한다
- 셋 다 실패 확인 후 원복(sha256 으로 원복 증명).

#### 알려진 경계 (2026-08-09 실측)

- **동시 E2E 는 여전히 안 된다** — 데이터는 격리됐지만(전용 DB + 실행 단위 사용자) 두 실행이
  `apps/api/dist` 를 함께 쓴다. 동시에 `nest start` 가 돌면 `Cannot find module './programs.service'` 로 죽는다.
  기본 포트에서는 **포트 충돌로 시끄럽게 실패**하므로 조용한 데이터 오염은 아니다.
  풀려면 러너별 outDir 분리가 필요하다(tsc outDir 은 env 로 못 바꾼다) — 별도 티켓.
- **비기본 포트 단독 실행은 된다**(`E2E_WEB_PORT=3200 E2E_API_PORT=3201` → 53/53). CORS 는 실행마다
  `WEB_ORIGIN` 을 API 에 넘겨 해결했다 — 안 넘기면 브라우저 fetch 가 통째로 막힌다(실측 37건 실패).

#### 리스크 — 사람 리뷰가 필요한 지점

- `utcToday()` 오버라이드와 run-scoped `DEV_USER_ID` 는 **신원·시간 경계**라 보안 인접이다.
  둘 다 **ADR-23 의 dev-user 이음새 안**에 두고 dev-user 가 꺼지면 함께 죽게 한다.
  CLAUDE.md 절대 규칙(보안 코드 임의 변경 금지)에 걸리므로 **이 두 지점만 사람 리뷰를 요청**한다.
- `afc_e2e` 신설로 CI 에 migrate+seed 1회가 늘어난다.

### 남은 것 (워크스루 이후 판단 — 제품 오너 보류 지시)
> 1·4번은 **UI라서 새 기획에 흡수될 수 있다. 기획을 받기 전에 손대지 마라.** 2·3번은 디자인과 무관하니 지금 해도 된다.

1. **D-7 온보딩 죽은 공간** ⏸ *새 기획 대기*: AC는 통과하지만(위 399px + 아래 201px = 화면 71%) 실사용 문제는 남았다. `min-h-[52dvh]`가 원인.
2. **🔴 테스트 격리 — 다음 마일스톤으로 착수(위 계획 참조)**: ~~api 테스트·E2E가 같은 `afc_test`~~ → **진단 정정됨**(api=`afc_test`, E2E=개발 DB `afc`). 실제 결함은 **고정 `DEV_USER_ID`** 라 동시 실행 시 서로의 데이터를 지운다(간헐 실패 실제 관측: `ad-hoc-session.spec`가 `PrismaClientKnownRequestError`와 "통증 제외 미적용"으로 랜덤 실패). **STEP 6은 오프라인 동기화라 중복·유실 0을 단언해야 하는데, 테스트끼리 데이터를 지우면 그 단언 자체를 믿을 수 없다.** 워커별 DB 또는 워커별 user_id 격리를 STEP 6 첫 작업으로 처리한다.
3. **🔴 E2E 요일 의존 — 위 2번과 같은 급, STEP 6 착수 전 필수 (2026-08-08 발견)**: E2E 헬퍼의 `DEFAULT_PROGRAM` 이 `days_per_week: 3` → 생성 스케줄이 **MON/WED/FRI 고정**이라(`programs.service.ts` `mondayOfWeek` + `WEEKDAYS.indexOf(day)`), 그 외 요일에 돌리면 `todaySession()` 이 "오늘(rest)에 세션이 없다"로 죽는다. **실측(토요일 2026-08-08): 53개 중 17 failed / 22 did not run.** 즉 **이 스위트는 주 3일만 돌아간다.** 헬퍼가 스스로 실패시키는 설계(조용한 skip 금지)라 위장은 아니지만, "green 이라 안전하다"는 판단은 요일에 좌우된다(함정 5).
   - **내 변경 때문이 아님을 확인함**: 워킹트리를 `git stash` 하고 `b24aab9` 상태에서 `03-rest-timer.spec.ts` 를 돌려 **동일하게 실패** 재현. `00-api-cors` 4/4 는 양쪽 모두 통과(교차 출처 경로 무손상).
   - 고칠 방향(별도 티켓): `seedProgram` 이 **오늘 요일이 반드시 운동일이 되도록** 스케줄을 잡거나, 요일을 주입 가능하게 한다. 단 F8-1(휴식일 즉석 세션) 스펙은 **휴식일이 필요**하므로 "전부 운동일"로 밀면 안 된다 — 두 요구를 같이 만족시켜야 한다.
4. **D-8~D-10 minor** ⏸ *UI 항목은 새 기획 대기*: 완료 행 가드를 문자열 매칭 → 실제 대비 측정, 360px 뷰포트 회귀 테스트, `ActionBar` sticky 분기 미실행, 카드 크롬 196px/장(같은 안내 3중 표기), before/after 스크린샷 생성 스크립트 미커밋, RIR 시트가 배경 `inert` 미적용(포털 도입 시 해소).
5. **`weekly_completion_rate` 정의 확정**: "계획 준수율"로 못 박았다. "이번 주에 한 운동량"을 원하면 별도 지표·계약이 필요 — 제품 판단.

### ✅ 실기기 워크스루 — 완료 (제품 오너, 2026-08-08)
**"직접 실기기로 작동은 확인했다"**(제품 오너). STEP 5를 막던 사람 차례는 여기서 끝났다.

- **함정 1 회귀 없음**: 비보안 출처에서 `crypto.randomUUID` 가 없어 세트 완료가 전부 실패하던 blocker(ADR-35)는 재발하지 않았다.
- 확인 대상이던 4항목(RIR 바텀시트 / 세트 행 가독성 / 휴지통 역할 / 온보딩 버튼 위치)의 **개별 합격·불합격 판정은 별도로 보고되지 않았다.**
  대신 제품 오너가 **UI/UX 전체를 새로 기획·디자인하는 방향**으로 갔다 — 즉 이 4항목의 시각적 결론은 새 기획이 대체할 가능성이 크다.
  **"4항목 전부 통과"로 기록하지 마라.** 확인된 것은 "동작한다"까지다.

절차서는 그대로 유효하다(다음 검증 때 재사용) → `docs/DEVICE_WALKTHROUGH.md`
```
pnpm db:up                     # Docker Desktop 실행 후
pnpm --filter api start        # 터미널 1
pnpm --filter web dev:lan      # 터미널 2 — HTTPS + 0.0.0.0 + /api/v1 프록시
```
폰에서 `https://192.168.0.174:3000` (2026-08-08 기준 이더넷. **`Status = Up` 인 어댑터의 IP** 를 쓴다 —
끊긴 어댑터에 주소가 남아 있어 `ipconfig` 만 보면 안 닿는 IP 를 고르게 된다. 실제로 그렇게 헤맸다).
최초 1회 `%LOCALAPPDATA%\mkcert\rootCA.pem` 을 폰에 신뢰 설치
— **iOS 는 프로파일 설치 + "인증서 신뢰 설정" 스위치 2단계**, Android 는 Chrome 에서만 유효.
스크린샷은 `C:\Users\amole\Desktop\AFC-화면확인\실기기-2026-08-08\` (상위 폴더의 데스크톱 스크린샷과 번호 충돌 방지).
**IP 가 바뀌면 인증서를 다시 만들어야 한다**(SAN 에 IP 가 박혀 있다) → `DEVICE_WALKTHROUGH.md` §2.1 재발급 4단계.

---

## 백로그 (지금 구현하지 않음)
- **근력 운동 전/후 유산소 루틴 추가** — 기록만(2026-08-05, 제품 오너 지시). 착수 조건: **테스트 우선 목표(STEP 6 오프라인) 완료 후 판단**.
  필요한 선행 작업:
  1. **운동 DB에 유산소 종목 필요** — 현재 시드 30종이 전부 웨이트다.
  2. **데이터 모델에 시간·거리·심박 지표 필요** — 현재 `performed_sets`는 무게/반복/시간(초)까지만 있다.
  3. **추천 엔진은 유산소를 오토레귤레이션 대상에서 제외**한다(별도 규칙). 더블 프로그레션·RIR 축이 성립하지 않는다.
  4. **세션에 워밍업/쿨다운 슬롯 개념 필요** — 현재 `planned_sets`는 본 운동만 전제한다.

## 사람 결정(확정 — 2026-08-05, 2차)
1. `/sync` `client_id`는 **uuid 유지**, openapi 예시를 UUID 형식으로 정정 → 반영 완료.
2. openapi `Exercise`에 `metric`·`default_time_low_sec/high_sec` 추가 → 반영 완료(`metric`은 DB가 non-null이라 non-nullable required, 시간 범위만 nullable).
3. `/webhooks/pg`의 `signature` **required** → 반영 완료(구현은 스텁 유지).
4. 감량 방향은 **현재 동작(대칭, 61→60) 유지** → 테스트 미수정.
5. `pain_areas` 관절→패턴 제외 매핑 도입, 맨몸·시간 진행 모델 도입, 상태코드 계약 반영, 세션 내 중복 종목 금지 → 전부 반영 완료(STEP 4 섹션 참조).

## 열린 질문 (남은 것)
- **프로그램 생성 규칙**(분할·운동 수·세트 수·`target_rir`)이 문서 근거 없는 해석 — 제품 리뷰 필요.
- **`pain_areas` enum 부재** — 오타가 안전 필터를 조용히 무력화한다. enum 고정 여부.
- **시간 종목의 goal별 목표 시간 표**가 스펙에 없다(현재는 카탈로그 기본값).
- **시간 목표의 "범위 폭 유지" 규칙이 없다** — GC-32처럼 12~15초를 못 하면 목표가 `10~10초`로 폭이 붕괴한다. 규칙(`max(10, x - step)`을 상·하단 독립 적용)에서 그대로 도출된 값이라 구현 오류는 아니지만 UX 검토 대상.
- 아직 골든이 고정하지 못한 진행 상수: `CONFIDENCE.full`(절대값), `BODYWEIGHT_REPS_CAP` 하향 방향, `TIME_DOWN_RATIO` 상향 방향. **안전 관련 상수는 전부 고정 완료**.
- SECURITY_PIPA가 요구하는 **건강데이터 접근 감사 로깅 테이블**이 DATA_MODEL에 없다(스펙 공백).

## 실행 방법 (재현 가능 — 이대로만 하면 뜬다)
```
pnpm db:up                     # postgres:16 / redis:7 (Docker Desktop 실행 필요)
pnpm --filter api start:dev    # :3001, /v1 prefix. 루트 .env를 자동 로드한다(ADR-36)
pnpm --filter web dev          # :3000  ← 반드시 3000. API CORS 허용 origin 기본값이다(ADR-34)
```
- **`.env` 필수 항목**(루트 1개 파일): `DATABASE_URL`, `FIELD_ENCRYPTION_KEY`(= `openssl rand -base64 32`), `DEV_USER_ID`(UUID), `WEB_ORIGIN`(기본 `http://localhost:3000`). `.env.example` 복사 후 키만 채우면 된다.
- **포트 3000 고정**: 다른 포트로 띄우면 CORS에서 막힌다(`WEB_ORIGIN`을 함께 바꾸면 가능).
- 목서버로 보려면 `pnpm mock`(:4010) + `NEXT_PUBLIC_API_BASE_URL=http://localhost:4010`, 브라우저에서 `document.cookie="sid=dev"` 1회.
- **E2E**: `cd apps/web && npx playwright test` — **반드시 단독 실행**(동시 실행 시 서로의 오늘 세션을 갈아치운다).
  **월·수·금에만 전부 통과한다**(위 "남은 것" 3번). 다른 요일에는 `오늘(rest)에 세션이 없다`로 대량 실패하며, 이는 코드 회귀가 아니다.
- **Windows 주의**: API가 떠 있으면 `pnpm install`·`prisma generate`가 EPERM(파일 락)으로 실패한다. 포트 3000/3001/3100/4010 프로세스를 정리하고 재시도.

### 실기기(폰) 확인
**절차서 = `docs/DEVICE_WALKTHROUGH.md`** (2026-08-08 작성·실행 검증 완료). 명령은 **`pnpm --filter web dev:lan`** 한 줄이다.
`http://사설IP`로 접속하면 secure context가 아니라 서비스워커가 등록되지 않고 `crypto.*` 일부가 없다 —
그 blocker가 정확히 그 사례였다(터널 금지, ADR-43). 폰에 `%LOCALAPPDATA%\mkcert\rootCA.pem` 신뢰 설치가 필요하다.

**확인 순서**: `/onboarding`(7스텝, 통증 칩 8종+"해당 없음") → 계획 만들기 → `/program`(왜 이 루틴 + 제외된 운동·사유) → `/`(대시보드, [운동 시작]) → `/session/{id}`(세트 입력 → 완료 체크 → **휴식 타이머 팝업**에서 +30초 연타·휴식 종료 → [편집]으로 추가/교체/삭제 → 운동 종료) → 요약.
확인 포인트: 플랭크는 시간 1칸·RIR 없음, 풀업은 "자체중량"(무게칸 없음), 첫 세션은 "무게 미정"(0kg 아님), 운동 카드 [통증 기록]에서 4 이상 선택 시 안전 안내.

## 다음 액션

### 다음 세션 첫 명령 — **`/goal` 을 바로 돌리지 마라**

제품 오너가 **UI/UX 재기획 중**이다(2026-08-08~). 다음 세션의 시작은 **그 산출물을 받는 것**이다.

**① 기획·디자인 산출물이 있으면** → 먼저 원천 스펙과 대조한다.
```
새 기획을 docs/FEATURES_UX.md·docs/UX_STATES.md 와 대조해서
(1) 무엇이 바뀌는지 (2) 어떤 AC/ADR 이 폐기·수정되는지 (3) 계약(openapi) 영향이 있는지
를 먼저 정리해줘. 코드는 아직 만들지 마.
```
**대조를 건너뛰지 마라.** 예전에 파생 문서(`UX_STATES.md`)가 원천과 갈라져 evaluator 가 하드 게이트를 오판했고,
스펙이 이미 탈락시킨 `datalist` 를 그대로 채택해 iOS 에서 기능이 소멸한 적이 있다(함정 2).
**폐기되는 ADR 은 표에서 지우지 말고 "폐기(사유·대체 ADR)" 로 남긴다.**

**② 기획이 아직이면** → 디자인과 무관한 것만 한다.
```
/goal step 5
```
"남은 것" **2번(테스트 격리)·3번(E2E 요일 의존)** 만 처리한다. 둘 다 **STEP 6 착수 전 필수**이고 UI 를 건드리지 않는다.
**1·4번(UI)은 손대지 마라** — 새 기획에 덮여 버려질 작업이다.

STEP 6(오프라인 동기화)은 위 2·3번이 끝난 뒤 `/goal until 6`.

### STEP 6 착수 전 이미 결정된 사항
- **실기기 검증은 `next dev --experimental-https`**(터널 금지) — 서비스워커는 **secure context 필수**다(ADR-43).
- **E2E 테스트 격리가 필요하다** — 지금은 여러 실행이 같은 DB를 써서 `GET /dashboard`가 보는 "최신 프로그램"을 서로 갈아치운다. 사용자별 분리 또는 실행별 DB가 필요하다.
- Dexie 배선 지점은 이미 준비돼 있다: `session-store.ts`의 **`write()` 단일 관문** + `PerformedSet`과 1:1인 드래프트(9키, `pain_score` 포함). 완료 후 **"세트 3개 체크 → reload → 유지"** E2E로 고정할 것.
- `@serwist/next`는 설치만 돼 있고 미배선이다. 회귀 감지용 `test.fail()` 마커가 `04-errors.spec.ts`에 있어, 배선되면 "예상치 못한 통과"로 뒤집힌다.
- `/sync`의 `Mutation.entity`는 `performed_set|session|profile`뿐이라 **루틴 편집을 오프라인 큐에 태우려면 계약 확장이 필요**하다(제안만 하고 임의 생성 금지).
