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
| 5 | 프론트 핵심 플로우 (FEATURES_UX F0~F8) | 🟡 **진행 중** (2026-08-06) | 69.5 → 73.0 → **70.0** (아래 "STEP 5 현재 상태") |
| 6 | 오프라인 동기화 | ⬜ 예정 | |
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

## ▶ 다음 세션은 여기부터 읽어라 — STEP 5 현재 상태 (2026-08-06 종료 시점)

> **STEP 0~4는 완료**(0: 82 / 1: 88 / 2: 84 / 3: 78→뮤턴트 14/14 사살 / 4: 77→81). STEP 5만 진행 중이다.
> **게이트는 전부 green**이다: typecheck / lint / format:check / build / test(**shared 79 · web 205 · api 226**) + Playwright E2E 53 + axe 18화면 0위반.
> STEP 5를 닫으려면 **코드 작업이 아니라 제품 오너의 실기기 워크스루**가 남았다(아래 "사람이 해야 하는 것").

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
1. **D-6 스펙-구현 divergence 기록**(미완, 내가 하려다 못 함): [편집] 시트 제거, 통증 버튼 위치(카드 최하단 → 헤더), RIR 방식 변경, 무게·횟수 입력의 단위 접미사 제거 — `docs/UX_STATES.md` §2.4.2/§2.4.4/§7.1/§7.2 M-3/AC-DEL-6이 아직 옛 전제다. **코드에 맞춰 문서를 고칠 것**(구현이 더 낫다고 판단된 변경들이다).
2. **문서 드리프트 2건**: `docs/DATA_MODEL.md`에 `workout_sessions.origin`이 없다. `excluded_exercises`의 마커 항목(저장 전용, 응답 제외) 규약도 미기재.
3. **AC-RIR-4 미충족**: "목표 2"를 입력 **오른쪽**에 두라는 스펙을 폭 예산상 못 지켜 2줄차에 두고 `aria-describedby`로만 연결했다. 배치를 살리려면 무게 칸 축소나 완료 체크 56px 하향이 필요 — 스펙 소유자 판단.
4. **D-7 온보딩 죽은 공간**: AC는 통과하지만(위 399px + 아래 201px = 화면 71%) 실사용 문제는 남았다. `min-h-[52dvh]`가 원인.
5. **테스트 격리(중요)**: api 테스트·E2E가 **같은 `afc_test` DB + 같은 고정 `DEV_USER_ID`** 를 써서 동시 실행 시 서로의 데이터를 지운다(간헐 실패 실제 관측). 워커별 DB 또는 워커별 user_id 격리가 필요하다. CI 병렬화 전 필수.
6. **D-8~D-10 minor**: 완료 행 가드를 문자열 매칭 → 실제 대비 측정, 360px 뷰포트 회귀 테스트, `ActionBar` sticky 분기 미실행, 카드 크롬 196px/장(같은 안내 3중 표기), before/after 스크린샷 생성 스크립트 미커밋, RIR 시트가 배경 `inert` 미적용(포털 도입 시 해소).
7. **`weekly_completion_rate` 정의 확정**: "계획 준수율"로 못 박았다. "이번 주에 한 운동량"을 원하면 별도 지표·계약이 필요 — 제품 판단.

### 사람(제품 오너)이 해야 STEP 5를 닫을 수 있는 것
**실기기 워크스루로 아래 4가지를 직접 확인해야 한다.** 자동 검증으로는 대체되지 않는다(오늘 blocker가 정확히 그런 사례였다).
1. **RIR 바텀 시트** — 셰브론을 탭해 목록이 실제로 열리고 값이 선택되는가(특히 iOS).
2. **세트 행 가독성** — 2줄로 줄인 뒤 운동 중에 한눈에 들어오는가.
3. **휴지통** — 편집 진입 없이 삭제되는가, 기록 있는 운동에서 사유가 보이는가.
4. **온보딩 버튼 위치** — 7스텝 내내 엄지로 편한가(특히 3/7·4/7).

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
- **Windows 주의**: API가 떠 있으면 `pnpm install`·`prisma generate`가 EPERM(파일 락)으로 실패한다. 포트 3000/3001/3100/4010 프로세스를 정리하고 재시도.

### 실기기(폰) 확인
**`next dev --experimental-https`로 한다(터널 금지, ADR-43).** `http://사설IP`로 접속하면 secure context가 아니라
서비스워커가 등록되지 않고 `crypto.*` 일부가 없다 — 오늘 blocker가 정확히 그 사례였다. 폰에 인증서 신뢰 설치가 필요하다.

**확인 순서**: `/onboarding`(7스텝, 통증 칩 8종+"해당 없음") → 계획 만들기 → `/program`(왜 이 루틴 + 제외된 운동·사유) → `/`(대시보드, [운동 시작]) → `/session/{id}`(세트 입력 → 완료 체크 → **휴식 타이머 팝업**에서 +30초 연타·휴식 종료 → [편집]으로 추가/교체/삭제 → 운동 종료) → 요약.
확인 포인트: 플랭크는 시간 1칸·RIR 없음, 풀업은 "자체중량"(무게칸 없음), 첫 세션은 "무게 미정"(0kg 아님), 운동 카드 [통증 기록]에서 4 이상 선택 시 안전 안내.

## 다음 액션

### 다음 세션 첫 명령
```
/goal step 5
```
STEP 5의 남은 항목(위 "남은 것" 1~3번)을 마저 끝내는 것이 먼저다. 그 뒤 제품 오너의 실기기 워크스루로 STEP 5를 닫고 STEP 6으로 간다.
남은 항목까지 끝났다고 판단되면 `/goal until 6`으로 STEP 6(오프라인 동기화)까지 진행한다.

### STEP 6 착수 전 이미 결정된 사항
- **실기기 검증은 `next dev --experimental-https`**(터널 금지) — 서비스워커는 **secure context 필수**다(ADR-43).
- **E2E 테스트 격리가 필요하다** — 지금은 여러 실행이 같은 DB를 써서 `GET /dashboard`가 보는 "최신 프로그램"을 서로 갈아치운다. 사용자별 분리 또는 실행별 DB가 필요하다.
- Dexie 배선 지점은 이미 준비돼 있다: `session-store.ts`의 **`write()` 단일 관문** + `PerformedSet`과 1:1인 드래프트(9키, `pain_score` 포함). 완료 후 **"세트 3개 체크 → reload → 유지"** E2E로 고정할 것.
- `@serwist/next`는 설치만 돼 있고 미배선이다. 회귀 감지용 `test.fail()` 마커가 `04-errors.spec.ts`에 있어, 배선되면 "예상치 못한 통과"로 뒤집힌다.
- `/sync`의 `Mutation.entity`는 `performed_set|session|profile`뿐이라 **루틴 편집을 오프라인 큐에 태우려면 계약 확장이 필요**하다(제안만 하고 임의 생성 금지).
