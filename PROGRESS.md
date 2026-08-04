# AIFITCOACH (AFC) 개발 진행 기록

> `/goal` 명령이 이 파일을 읽어 마지막 완료 STEP 다음부터 이어서 진행하고, STEP마다 이 파일을 갱신한다.

## 상태 요약
| STEP | 내용 | 상태 | 점수 |
|---|---|---|---|
| 0 | 스캐폴딩 & CI | ✅ 완료 (2026-08-04) | 82 → fix 후 재검증 green |
| 1 | DB 스키마 + 시드 | ✅ 완료 (2026-08-05) | 88 → fix 후 재검증 green |
| 2 | OpenAPI 코드젠 & 목서버 | ⬜ 예정 | |
| 3 | 추천 엔진 TDD (핵심 IP) | ⬜ 예정 | |
| 4 | 백엔드 엔드포인트 (테스트 스코프: 로그인 보류·dev-user) | ⬜ 예정 | |
| 5 | 프론트 핵심 플로우 (FEATURES_UX F1~F8) | ⬜ 예정 | |
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
| I-9 | 골든 케이스 실제 18개인데 지침은 "25개" | info | **사람 결정 대기** — 아래 "열린 질문" |

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

### 열린 질문 (STEP 4 착수 전 결정 필요)
- **`DEV_USER_ID=dev-user`가 `users.id uuid`에 저장 불가**(.env.example 기본값). ① 고정 UUID 상수로 바꾸기 ② `users.id`를 text로 변경 — 둘 중 택1 필요. 지금 결정하지 않으면 STEP 4에서 막힌다.
- `performed_sets.planned_set_id`를 1:1(UNIQUE)로 볼지 1:N으로 둘지(현재 1:N). 부분 수행·재시도 의미론과 연결(STEP 6).
- openapi `Exercise`(`rep_range_low/high`, `media_url`) ↔ DB(`default_reps_*`, `media` jsonb, time 범위) 매핑 계층 위치(STEP 2/4).

### 사람 검토 필요(보안/PIPA — 임의 변경하지 않음)
- FK 14개 전량 `ON DELETE RESTRICT`. SECURITY_PIPA.md의 "소프트 삭제 후 퍼지 잡" 설계와는 정합하나, `DELETE /me` 구현 시 삭제 순서 정책을 사람이 확정해야 한다(ADR-15는 잠정).
- `body_fat_pct`(Decimal) `pain_score`(Int) `session_feedback.pain`(JSONB)은 **평문 컬럼**이며 암호문을 담을 수 없는 타입이다. `.env.example`에 `FIELD_ENCRYPTION_KEY`가 이미 있으므로 앱 레벨 암호화 도입 시 **컬럼 타입 변경 마이그레이션이 필요**하다. 데이터 0건인 지금은 비용 0, STEP 7/8에는 크다 → 암호화 스킴 결정은 사람 몫(에이전트가 임의 결정 금지).
- SECURITY_PIPA.md가 요구하는 **건강데이터 접근 감사 로깅용 테이블이 DATA_MODEL.md에 없다**(스펙 공백).

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

## Deferred(이월) 항목
- **→ STEP 3**: `packages/shared` 소비 방식 결정(I-8). 후보: (a) shared에 빌드 산출물+exports, (b) web `transpilePackages`+api `tsconfig paths`, (c) 각 앱이 소스 직접 참조. STEP 3 종료 전 결정하고 api/web 각각에서 `recommendNextSet` import 스모크 추가.
- **→ STEP 5**: `@next/eslint-plugin-next` + `eslint-plugin-react-hooks` 도입(STEP 0 I-7).
- **→ STEP 6**: `@serwist/next` 실제 배선(Service Worker·앱셸 캐시).
- **→ STEP 4**: DB 통합 테스트 부트스트랩을 jest `globalSetup`으로 이관(STEP 1 I-2). DB spec이 2개 이상이 되면 worker별 `migrate deploy` 경합.
- **→ STEP 6**: 동기화 입력 방어선(Decimal 범위·`pain_score` 0~10 CHECK 또는 DTO 검증) 결정(STEP 1 I-6).
- **→ STEP 7**: openapi에만 있는 필드(`Subscription.product_id`, 캘리브레이션 `method`·`perceived_difficulty`) 스펙 정합 질의(STEP 1 I-7).
- **→ STEP 8**: 파생 테스트 DB의 localhost/CI 가드(STEP 1 I-8).

## 열린 질문(사람 결정 필요)
- **골든 테스트 케이스 수**: `docs/specs/golden_tests.json`은 **18개**(GC-01~04, 06~10, 13, 15~22 — GC-05/11/12/14 결번)인데 CLAUDE.md·PROMPTS.md는 "골든 25개 green"을 STEP 3 성공 기준으로 기술. ① 게이트 문구를 "전 케이스(18개)"로 정정할지, ② 결번 포함 25개로 케이스를 보강할지 결정 필요. STEP 3 채점 기준에 직접 영향.

## 다음 액션
- **STEP 2**: openapi-typescript로 클라이언트 타입 생성(생성물 커밋) → apps/api에 openapi paths 대응 컨트롤러/DTO 스텁(501) → `pnpm mock`(prism) 목서버.
- 선행 조건: Docker Desktop 실행 후 `pnpm db:up`, 루트 `.env`(`cp .env.example .env`).
- STEP 2 착수 시 함께 처리할 것: openapi `Exercise` ↔ DB 매핑 계층 위치 결정(위 "열린 질문").
- `/goal until 1` 지시로 **STEP 1에서 정지**했다. 이어서 하려면 `/goal until 6`(테스트 목표 범위) 또는 `/goal step 2`.
