# AIFITCOACH (AFC) 개발 진행 기록

> `/goal` 명령이 이 파일을 읽어 마지막 완료 STEP 다음부터 이어서 진행하고, STEP마다 이 파일을 갱신한다.

## 상태 요약
| STEP | 내용 | 상태 | 점수 |
|---|---|---|---|
| 0 | 스캐폴딩 & CI | ✅ 완료 (2026-08-04) | 82 → fix 후 재검증 green |
| 1 | DB 스키마 + 시드 | ⬜ 예정 | |
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

## Deferred(이월) 항목
- **→ STEP 3**: `packages/shared` 소비 방식 결정(I-8). 후보: (a) shared에 빌드 산출물+exports, (b) web `transpilePackages`+api `tsconfig paths`, (c) 각 앱이 소스 직접 참조. STEP 3 종료 전 결정하고 api/web 각각에서 `recommendNextSet` import 스모크 추가.
- **→ STEP 5**: `@next/eslint-plugin-next` + `eslint-plugin-react-hooks` 도입(I-7).
- **→ STEP 6**: `@serwist/next` 실제 배선(Service Worker·앱셸 캐시).

## 열린 질문(사람 결정 필요)
- **골든 테스트 케이스 수**: `docs/specs/golden_tests.json`은 **18개**(GC-01~04, 06~10, 13, 15~22 — GC-05/11/12/14 결번)인데 CLAUDE.md·PROMPTS.md는 "골든 25개 green"을 STEP 3 성공 기준으로 기술. ① 게이트 문구를 "전 케이스(18개)"로 정정할지, ② 결번 포함 25개로 케이스를 보강할지 결정 필요. STEP 3 채점 기준에 직접 영향.

## 다음 액션
- **STEP 1**: `apps/api/prisma/schema.prisma`에 DATA_MODEL.md 엔티티/관계/인덱스/enum 이전 → `prisma migrate dev` → `scripts/seed-exercises.ts`로 exercises 30종 upsert → 통합 테스트 1개.
- 선행 조건: Docker Desktop 실행 후 `pnpm db:up`, `.env` 생성(`cp .env.example .env`).
