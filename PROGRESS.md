# AIFITCOACH (AFC) 개발 진행 기록

> `/goal` 명령이 이 파일을 읽어 마지막 완료 STEP 다음부터 이어서 진행하고, STEP마다 이 파일을 갱신한다.
> **새로 시작하는 저장소다.** 아직 아무 STEP도 완료되지 않았다. STEP 0(스캐폴딩)부터 시작한다.

## 상태 요약
| STEP | 내용 | 상태 | 점수 |
|---|---|---|---|
| 0 | 스캐폴딩 & CI | ⬜ 예정 | |
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

## 참고: 알려진 기술 결정 (이전 시도에서 확인된 힌트 — 참고용, 강제 아님)
- pnpm은 정확한 버전 고정 권장(예: `pnpm@9.15.9`). corepack이 `pnpm@9` 같은 비-semver를 거부할 수 있음. package.json의 packageManager 키는 **한 줄만**.
- Prisma: 모델이 0개인 STEP 0에서는 `@prisma/client` postinstall generate가 실패 → STEP 0은 prisma CLI만, client는 모델이 생기는 STEP 1에서 추가. `url = env("DATABASE_URL")` 유지하려면 v6 계열 고정(v7은 datasource url을 별도 config로 이동).
- Next: `jsx: "preserve"` 유지 필요 시 Next 15 계열 고정(Next 16이 jsx를 react-jsx로 강제할 수 있음).
- Tailwind v4: `@tailwindcss/postcss`와 네이티브 oxide 바이너리 **버전 일치** 필요.
- apps/web·apps/api는 tsconfig.base(NodeNext) 미상속 — 각 프레임워크 기본 tsconfig 사용(web=bundler+jsx preserve, api=commonjs+데코레이터).
- ESLint flat config + Prettier 사용 시 `eslint-config-prettier` 포함(규칙 충돌 방지). NestJS jest 스펙/스텁 미사용 인자(`_` prefix) 처리 위해 `no-undef: off`·`argsIgnorePattern: '^_'` 권장.

## Deferred(이월) 항목
- (없음)

## 다음 액션
- STEP 0: pnpm 모노레포 스캐폴딩(apps/web=Next.js+Tailwind, apps/api=NestJS+Prisma datasource, packages/shared=recommendNextSet 스텁+타입), docker-compose 확인, 공통 tsconfig.base/ESLint/Prettier, CI green.
- 시작 프롬프트는 PROMPTS.md STEP 0 참조. 완료 후 커밋: `chore: scaffold web/api/shared workspace (STEP 0)`.
