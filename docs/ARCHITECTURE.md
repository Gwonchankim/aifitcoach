# 아키텍처 (웹 우선)

## 스택
- 프론트: Next.js(App Router) + TypeScript + PWA(Service Worker/Workbox) + Tailwind
- 상태/오프라인: TanStack Query + Zustand + IndexedDB(Dexie) + Outbox
- 백엔드: NestJS(TypeScript) + PostgreSQL + Redis, ORM Prisma. 모듈러 모놀리스.
- 인증: 소셜 OAuth 웹 + httpOnly 세션 쿠키 + CSRF
- 결제: 국내 PG 정기결제(PortOne 등) 빌링키 + 웹훅
- 관측: Sentry + OpenTelemetry
- 배포: Vercel/클라우드(서울), 프리뷰 URL

## 레포 구조
```
apps/web        # Next.js PWA
apps/api        # NestJS (모듈: auth,users,programs,exercises,sessions,sync,recommendation,subscriptions,analytics)
packages/shared # 공유 타입 + 추천 엔진 순수 로직(recommendNextSet) — 백엔드/프론트 공유
docs/           # 스펙(진실의 원천)
scripts/        # 시드 적재, docker-compose 등
```

## 오프라인 우선 & 동기화 (핵심 난제)
- Local-first: 모든 쓰기는 IndexedDB에 먼저 커밋, UI 즉시 반영. 진행 중 세션의 소스 오브 트루스는 로컬.
- Outbox 패턴: 변경을 `sync_mutations`(client_id UUID, entity, op, payload, updated_at, status)에 기록.
- 동기화 `POST /v1/sync`: (1) client_id 멱등 검사 → 신규만 적용, (2) `updated_at` 기준 **Last-Write-Wins**, (3) 세션 완료 mutation이면 추천 재계산 → 다음 planned_set.recommended_*.
- Pull: `since` 커서 이후 변경만 반환.
- 추천값의 오프라인 가용성: 현재 세션 추천은 서버가 미리 계산해 내려줌(프리필). 연속 오프라인 세션은 `packages/shared`의 추천 미러가 프리필 → 동기화 시 서버가 권위 있게 재계산·조정.
- 주의: iOS Safari는 Background Sync 제약 → 포그라운드 동기화 폴백. 브라우저 저장소 축출 대비 조기 동기화·persistent storage.

## 인증
- 소셜 OAuth 웹 리다이렉트 → 백엔드가 httpOnly 세션 쿠키(Secure·SameSite) 발급. 변경 요청은 `X-CSRF-Token`.
- JWT를 localStorage에 저장하지 않음(XSS). 세션 만료·회전, 로그아웃 시 무효화.

## 결제
- `/billing/checkout`(PG 결제창/빌링키 등록 세션) → `/billing/confirm`(빌링키 확정·첫 결제) → `/webhooks/pg`(갱신·해지·환불 동기화, 서명 검증).
- 엔타이틀먼트 미들웨어로 Pro 기능 게이팅. 상태: trial→active→(renew|grace|expired|cancelled).
- 전자상거래법: 정기결제 사전 고지·청약철회·환불, 통신판매업 신고.

## 결정 로그(ADR) — 새 결정은 여기 한 줄씩 추가
| # | 결정 | 근거 | 상태 |
|---|---|---|---|
| ADR-01 | 클라이언트 Next.js PWA(웹 우선) | SEO·즉시배포·스토어 수수료 회피·설치형 | 확정 |
| ADR-02 | 백엔드 모듈러 모놀리스 | 경계 명확·운영 단순 | 확정 |
| ADR-03 | 오프라인 우선 + LWW 동기화 | 헬스장 네트워크 불안정 | 확정 |
| ADR-04 | 추천 서버 권위 + 클라 미러(shared) | 오프라인 프리필 + 재현성 | 확정 |
| ADR-05 | PostgreSQL 단일 주 저장소 | 관계 무결성 + JSONB | 확정 |
| ADR-06 | 국내 PG 정기결제(웹) | 수수료 없음·전환 경제성 | 확정 |
| ADR-07 | rules_version 도입 | 추천 재현·A/B | 확정 |
| ADR-08 | PWA는 next-pwa 대신 `@serwist/next`(Workbox 계열) | next-pwa는 2022-08(v5.6.0) 이후 방치·App Router 미지원 | 확정(STEP 0, 설치만) |
| ADR-09 | 버전 고정: Next 15.5.22 / Prisma CLI 6.19.3 / TS 5.9.3 / ESLint 9 / Tailwind 4.3.3 | Next 16=jsx 강제, Prisma 7=datasource url 이동, TS 7=typescript-eslint peer(<6.1.0) 밖 | 확정(STEP 0) |
| ADR-10 | 테스트 러너 이원화: api=jest+ts-jest, web·shared=vitest | vitest(esbuild)는 emitDecoratorMetadata 미지원 → Nest DI 파손 | 확정(STEP 0) |
| ADR-11 | lint는 루트 단일 패스(`eslint .`), 패키지별 lint 스크립트 없음 | flat config 표준 방식·패키지별 eslint 중복 설치 회피 | 확정(STEP 0) |
| ADR-12 | Prettier는 `docs/`·`*.md` 제외(.prettierignore) + CI `format:check` 게이트 | 진실의 원천(openapi.yaml·golden_tests.json) 자동 재작성 방지 | 확정(STEP 0) |
| ADR-13 | exercises에 `cues`·`default_time_low_sec/high_sec` 추가, `default_reps_low/high`는 nullable | 시드(`exercises_seed.json`)의 실제 필드·`e_plank`(metric=time). 시드는 불변, 스키마가 수용 | 확정(STEP 1) |
| ADR-14 | 통합 테스트는 `<DB>_test` 파생 DB에 `migrate deploy`+seed 후 검증 | 참조 데이터 시드는 커밋된 상태를 봐야 검증 가능(롤백 불가). 개발 DB 무오염·CI DSN(afc_test) 그대로 사용 | 확정(STEP 1) |
| ADR-15 | 삭제는 소프트 삭제 + 퍼지 잡, FK는 RESTRICT 유지(퍼지는 자식→부모 순서 명시) | SECURITY_PIPA.md의 "소프트 삭제 후 퍼지" 설계와 정합, 실수·연쇄 삭제 방지 | **확정**(사람 결정 2026-08-05, 순서는 SECURITY_PIPA.md) |
| ADR-16 | 민감 건강필드 앱 레벨 암호화: AES-256-GCM, `FIELD_ENCRYPTION_KEY`(32바이트 base64), 저장 형식 `v1:iv:tag:ciphertext`(text 컬럼) | PIPA 민감정보 보호. 데이터 0건인 지금 도입해 컬럼 타입 변경 비용 회피 | **확정**(사람 결정 2026-08-05) |
| ADR-17 | 테스트 단계 dev-user는 고정 UUID `00000000-0000-4000-8000-000000000001`(users.id는 uuid 유지) | 문자열 `dev-user`는 uuid 컬럼에 저장 불가. 인증 도입 시 가드 한 곳만 교체 | **확정**(사람 결정 2026-08-05) |
| ADR-18 | 증량은 1스텝 상한 보장: 오프스텝 무게는 step 그리드로 정규화 후 한 칸 이동(증량=위, 감량/통증=아래, 유지=내림) | 안전 가드레일 3 "증량 상한 캡"의 구체화. 최근접 반올림은 62.5kg(step 5)에서 +7.5kg 과증량 | **확정**(사람 결정 2026-08-05) |
| ADR-19 | `packages/shared`는 dist(CJS+d.ts) 빌드 산출물로 소비, api/web은 `workspace:*` 의존 + 루트 `postinstall`이 shared 빌드 | 소스 TS 직접 참조는 api의 `nest build` dist 레이아웃을 깨뜨림(rootDir 상승). dist CJS는 Nest·Next 양쪽에서 transpilePackages 없이 해석 | 확정(STEP 3) |
| ADR-20 | openapi 클라이언트 타입 생성물은 `apps/web/lib/api-types.ts`, CI가 `pnpm codegen` 후 diff로 드리프트 차단 | 생성물을 커밋해 리뷰 가능하게 하고, 계약만 바뀌고 타입이 stale 해지는 것을 게이트로 방지 | 확정(STEP 2) |
| ADR-21 | api는 전역 `ValidationPipe(whitelist,transform)` + `ErrorEnvelopeFilter`로 `{error:{code,message}}` 단일 생성 지점 | CONVENTIONS.md 에러 엔벨로프를 한 곳에서 강제. 인증 가드도 `configureApp` 이음새 한 곳에 붙인다 | 확정(STEP 2) |
| ADR-22 | 응답 스키마 `required`는 "서버가 항상 내리는 필드"만, 해당 없으면 `null`을 명시적으로 내린다 | 클라이언트 상태를 `undefined\|null\|값` 3상태에서 2상태로 축소(F8 대시보드 분기) | 확정(STEP 2, 사람 승인) |
| ADR-23 | dev-user 주입은 `app.setup.ts`의 `app.use(devUserMiddleware)` **한 줄**. 프로덕션에서는 명시적 opt-in 없이 켜지면 **부팅 거부** | 인증 도입 시 이 지점만 OAuth+쿠키+CSRF로 교체. 인증 미배선 상태의 프로덕션 배포 사고 방지 | 확정(STEP 4) |
| ADR-24 | 세션 편집(F5)은 **세션 스코프**. 프로그램 템플릿은 `programs.template`(JSONB)에 생성 시점 스냅샷으로 고정 | 편집이 템플릿으로 역류해 `GET /programs/current`가 오염되던 문제. 세션은 템플릿의 인스턴스다 | 확정(STEP 4) |
| ADR-25 | `POST /sessions/{id}/complete`는 **멱등 + 피드백 키 단위 병합**(409 아님), `completed_at`은 최초 값 보존 | STEP 6 아웃박스 재시도가 정상 경로다. 409로 막으면 재시도가 영구 실패로 남고, 전체 교체는 암호화된 `pain`을 파괴한다 | 확정(STEP 4) |
| ADR-26 | 세션 내 운동 **중복 미지원**(`plannedExerciseId` = `exercise_id`), 중복 추가·교체는 409. DB `ux_planned_session_exercise_set(session_id, exercise_id, set_no)` 유니크로 동시성까지 차단 | 중복 허용 시 하나를 지우면 둘 다 지워진다. 향후 중복이 필요하면 슬롯 고유 id 도입(openapi·DB·프론트 동시 변경) | **확정**(사람 결정 2026-08-05) |
| ADR-27 | 맨몸(`step_kg = null`)은 반복으로, 시간 종목(`metric = time`)은 유지 시간으로 진행. `weight = null`은 자체중량, `step_kg = 0`은 `INVALID_INPUT`(서로 다른 의미) | 홈트 사용자가 프로그램을 만들 수 없던 문제. 0/null 혼동은 실제 버그였다(`?? 0` → 맨몸이 INVALID_INPUT) | **확정**(사람 결정 2026-08-05) |
| ADR-28 | 온보딩 `pain_areas`는 `docs/SAFETY_PAIN_MAPPING.md` 표로 movement_pattern을 제외하고, 부족분은 같은 근육군 머신/케이블로 대체. 제외 근거를 응답(`Program.excluded_exercises`)에 포함 | "받고 조용히 버리기"는 안전 결함. 제외로 성립 불가해도 에러 대신 축소 프로그램 | **확정**(사람 결정 2026-08-05) |
| ADR-29 | `rules_version` 2026.07.1 → **2026.08.1**(맨몸·시간 가산 규칙). 기존 입력의 출력은 불변(골든 18건 무변경) | api가 맨몸·시간 추천을 실제로 내보내기 시작한 시점에 상수·골든·스펙·openapi 예시를 함께 올림 | 확정(STEP 4) |
| ADR-30 | 디자인은 **다크 기본**(`:root`) + `theme-light` opt-in, 의미 토큰만 사용, 탭 토큰 44/56/**72px** | 로깅 화면 다크 요구를 기본값으로 충족하고 `layout.tsx` 수정을 없앤다. 대비는 전 조합 계산 검증(AA 미달 0) | **폐기**(UI/UX v2 — 라이트 전용·72px 소멸 · 대체 docs/DESIGN_TOKENS.md) |
| ADR-31 | 값 눈금(RIR 0~6, 통증 0~10)은 **줄바꿈 금지·가로 스크롤 1줄**(`ScaleGroup`), 탭 타깃 44px 유지 | D-13의 단일 입력 + 셰브론 바텀시트가 값 눈금을 대체해 가로 스크롤이 필요 없다 | **폐기 유지**(UI/UX v2, 대체 ADR-55) |
| ADR-32 | 세트 완료 기록은 **STEP 5에서 메모리 상태**, IndexedDB(Dexie)·서비스워커·`/sync`는 **STEP 6** | 원천 문서(`PROMPTS.md` STEP 6, `FEATURES_UX.md` F1·오프라인 절)가 STEP 6으로 규정. 파생 문서(UX_STATES)의 상반된 기술은 원천에 맞춰 정정 | 확정(STEP 5) |
| ADR-33 | 온보딩 로컬 저장은 **프로필(`afc.profile.v1`)과 진행 초안(`afc.onboarding.draft.v1`) 분리**, `pain_areas`는 **어디에도 저장하지 않음** | 프로필은 F0대로 로컬 보관(인증 도입 시 서버 이전). 통증 부위는 건강 민감정보라 브라우저에 무기한 잔존시키지 않는다(SECURITY_PIPA) | 확정(STEP 5) |
| ADR-34 | API CORS는 `WEB_ORIGIN` **명시적 허용목록**(`*` 금지, 빈 값·와일드카드면 부팅 거부), 허용 헤더에 `X-CSRF-Token` | 쿠키 세션과 `*`는 양립 불가. reflect 방식은 "개발에선 되고 배포하면 깨지는" 함정을 만든다 | 확정(STEP 5) |
| ADR-35 | `client_id`는 `crypto.getRandomValues` 기반 v4 UUID(**분기 없는 단일 경로**). `crypto.randomUUID` 금지 | `randomUUID`는 secure context 전용이라 실기기(`http://사설IP`)에서 존재하지 않아 세트 완료가 전부 실패했다. 분기를 두면 실기기 전용 경로가 생겨 테스트가 영원히 못 잡는다 | 확정(STEP 5) |
| ADR-36 | `apps/api/main.ts`가 **레포 루트 `.env`를 로드**(`override:false`, `__dirname` 기준 `../../../.env` — `dist/` 배치 전제) | 로드가 없으면 `pnpm --filter api start:dev`가 부팅 중 죽어 실행 지침이 그대로 실패한다. 실제 환경변수(배포·CI)가 항상 우선 | 확정(STEP 5) |
| ADR-37 | 즉석 세션 `POST /v1/sessions/ad-hoc`(부위 선택). 오늘 세션이 이미 있으면 409 → 클라이언트는 기존 세션으로 이동 | 휴식일에도 운동할 수 있어야 한다(F8-1). "다음 예정 세션 당겨오기"는 이후 일정 재배치 문제가 생겨 배제 | **확정**(사람 결정 2026-08-05) |
| ADR-38 | 종료 후 **당일에 한해** 세션 편집·수정 허용. 다른 날짜는 읽기 전용(409). 판정 기준은 서버·클라 공용 **UTC** 모듈 | 실사용에서 추가 운동·오기입 수정이 흔하다. 과거 기록 소급 변경은 이미 나간 추천의 근거를 바꾸므로 금지. 기준이 갈리면 자정 근처에 "오늘인데 409"가 난다 | **확정**(사람 결정 2026-08-05) |
| ADR-39 | RIR은 **단일 필드 + 셰브론 → 바텀 시트**(모름/0~6). `<input list>`+`datalist` 금지 | iOS Safari의 datalist는 키보드 위 제안 줄이라 **탭으로 목록을 여는 경로가 없다** → "고르기"가 소멸한다. 직접 입력과 확실한 선택 경로를 함께 유지한다 | **폐기 취소·재확정**(D-13, 대체 결정 ADR-55와 정합) |
| ADR-40 | 운동 카드에서 **[교체]=추가·교체 / 휴지통=삭제**로 역할 분리, 중간 [편집] 시트 제거 | 헤더에 액션을 직접 펼치는 방식은 앵커 메뉴로 대체한다. 대체 범위는 **교체/통증 기록/삭제 3항목**이며, 별도 상태·API가 필요한 **건너뛰기는 이번 범위에서 제외**한다 | **폐기 유지**(대체 ADR-55) |
| ADR-41 | 완료 세트 행은 `opacity`로 흐리지 않고 **완료 전용 토큰**(`bg-done`/`done-fg`/`done-border`)으로 구분. 기록값 본문은 `text-fg` 유지 | `opacity`는 글자와 배경을 함께 섞어 대비를 **상승 불가능하게** 깎는다(실측 6.43→4.01:1 AA 미달). 기록은 흐릴 대상이 아니다 | 확정(STEP 5) |
| ADR-42 | 온보딩·세션 하단 액션 바는 **콘텐츠 흐름 + `sticky bottom-0`**(JS 분기 없음). 컨테이너에 `min-h-dvh`+`flex-1` 금지 | "가운데가 비는" 원인은 sticky가 아니라 `flex-1`이 버튼을 화면 끝으로 **밀어내는** 것이었다. 하단 여백 하한 24px(safe-area 포함) | 확정(STEP 5) |
| ADR-43 | 실기기 검증은 **`next dev --experimental-https`** 로 한다(터널 금지) | 서비스워커·`crypto.randomUUID` 등 **secure context 전용 API**가 `http://사설IP`에서 죽는다. 터널은 개발 서버를 외부에 노출한다 | **확정**(사람 결정 2026-08-06, STEP 6 착수 전) |
| ADR-44 | 실기기 HTTPS 는 **mkcert 로 LAN IP 를 SAN 에 넣은 `certificates/lan.pem`** 을 `--experimental-https-key/-cert` 로 지정한다. 기본 경로(`localhost.pem`)에 두지 않는다 | `--experimental-https` 가 자동 생성하는 인증서 SAN 은 `localhost,127.0.0.1,::1,0.0.0.0` 뿐이라 폰이 쓸 `192.168.x.x` 가 없어 **CA 를 신뢰시켜도 경고가 남는다**(실측). 게다가 기본 경로에 두면 기동할 때마다 Next 가 덮어쓴다 | 확정(워크스루 준비) |
| ADR-45 | 실기기 모드에서 브라우저는 **같은 출처 `/api/v1/*` 만** 부르고 Next `rewrites` 가 `:3001` 로 넘긴다. `WEB_ORIGIN`·CORS 는 **건드리지 않는다** | HTTPS 페이지의 `http://:3001` 직통은 혼합 콘텐츠로 차단되고, 폰의 `localhost` 는 폰 자신이다. 프록시는 same-origin 이라 CORS 자체가 사라진다 — API 설정을 폰 IP 로 바꾸면 로컬 CORS 회귀 스펙(00-api-cors)이 깨진다. 평소 `next dev` 는 종전대로 교차 출처 직통 | 확정(워크스루 준비) |
| ADR-46 | `NEXT_PUBLIC_API_BASE_URL=/api/v1` 은 **셸이 아니라 `scripts/dev-lan.mjs`(Node) 안에서** 주입한다 | Git Bash(MSYS)가 선행 슬래시를 `C:/Program Files/Git/api/v1` 로 경로 변환해 조용히 깨진다(실측). next.config 의 `process.argv` 로 `--experimental-https` 를 보는 대안은 **Next 15 가 설정을 자식 프로세스에서 로드해 실패**한다(실측) | 확정(워크스루 준비) |
| ADR-47 | **추천 노출 게이트 = 해당 종목의 완료 "세션" 3회 미만이면 추천값을 노출하지 않는다.** 판정은 `packages/shared/display-gate.ts`(엔진 `recommend.ts` 를 import 하지 않는 별도 파일), 임계값은 그 파일의 상수 1곳 | 세션 단위인 이유: 정확도는 **서로 다른 날의 반복 관측**에서 나온다. 한 세션 안의 3세트는 같은 날·같은 컨디션이라 정보량이 적고, 엔진 자체가 세션 단위로 동작한다(`last_sets` = 최근 완료 세션 1개). 종목별인 이유: 페이월도 종목 단위 게이팅이라 계정 단위면 두 정책이 어긋난다. 표시 계층인 이유 → ADR-49 | **확정**(사람 결정 2026-08-09, D-1) |
| ADR-48 | 온보딩 통증 문진을 **없애지 않고 1문항으로 축소**한다("불편한 부위가 있나요?" + 어깨/허리/무릎/손목 다중선택, 기본 "없음"). 세션 중 사후 통증 기록은 **함께** 도입한다 | 사전 예방을 없애면 무릎이 안 좋은 사용자의 **첫 프로그램에 스쿼트·런지가 그대로 들어간다**. 사후 대응은 이미 아픈 동작을 한 뒤에야 작동한다 — 둘은 배타적이지 않다. ADR-28·SAFETY_PAIN_MAPPING 은 이 목적으로 설계됐다. 탭 1회라 "1분" 목표를 해치지 않는다 | **확정**(사람 결정 2026-08-09, D-2) |
| ADR-49 | 추천 **수식** 변경은 UI 마일스톤에서 분리해 **M-ENGINE′** 별도 티켓으로만 한다. 각 수식의 **근거(논문·합의)와 골든 케이스를 먼저 정의**한 뒤 TDD. 그 전까지 프로토타입 화면의 해당 수치는 **빼거나 "예시"로 표기** | 리스킨과 수식 변경을 섞으면 추천이 바뀐 이유가 UI 인지 엔진인지 못 가린다. 보류 대상: 통증 4+ 교체 −15%, 공백 복귀 −10%, 디로드 목표 RIR 2→4, 체지방·나이·성별 반영. 특히 디로드는 스펙이 "볼륨 감소형·**강도 유지**"인데 목표 RIR 을 올리면 강도까지 떨어져 **스펙과 충돌**한다. %기반 증감은 `step_kg`(상체 2.5/하체 5) 그리드 증량과 **규칙이 이원화**되므로 출처·정합성을 밝혀야 한다 | **보류 확정**(사람 결정 2026-08-09, D-3) |
| ADR-50 | 테스트의 "오늘"은 **`utcToday()` 한 곳의 오버라이드로 고정**한다(dev-user 모드에서만 유효). 요일별로 `days_per_week` 를 바꿔 맞추는 방식은 쓰지 않는다 | 요일 배정표에 **구조적 공백**이 있다 — 일요일은 어떤 분할에서도 운동일이 될 수 없고(SUN 전부 휴식), 월요일은 어떤 분할에서도 휴식일이 될 수 없다(MON 전부 운동). 그래서 "요일에 맞는 분할 고르기"로는 7일 중 2일을 못 덮는다. 날짜를 고정하면 한 번에 해결되고, 자정 경계·동기화(STEP 6)까지 결정적이 된다 | 확정(테스트 격리 착수) |
| ADR-51 | **`--afc-success-bg #EFF8F2` 는 변경 금지.** `success #198146` 과의 대비가 **4.54:1**(기준 4.5)로 여유가 0.04 뿐이다. **깨지는 방향은 `어둡게`다** — 배경을 어둡게 하면 어두운 글자와의 대비가 줄어 무너진다(실측: #EEF7F1 → 4.499, #EDF6F0 → 4.459). 밝게 하면 오히려 올라간다(#F0F9F3 → 4.578). 토큰 값을 바꾸면 `pnpm --filter web verify:contrast` 가 CI 에서 막는다 | 완료 행 `opacity-70` 이 4.01:1 이었던 사건은 **사후에야** 발견됐다(스캔 대상이 아니었다). 이번엔 사전 차단이 목표다 — 사람이 "괜찮아 보인다"고 판단하지 않고 토큰 값에서 전 조합을 계산한다 | **확정**(사람 지시 2026-08-09, M-UIa) |
| ADR-52 | **"파랑 = 상태/정보, ink = 액션".** 주 CTA·선택된 분절 칩/탭은 **ink 반전**(`--afc-action #151A21` + 흰 글자), 파랑은 상태 표시에만 남긴다(라디오 점·체크·게이지 채움·진행 바·소프트 배지·링크·추천값). 역할 토큰 `action`/`action-fg` 를 따로 두어 `fg`(글자색)와 구분한다 | `§2.3` 이 "파랑 = 지금·추천·계획과 다름"으로 의미를 정해 뒀는데 CTA 까지 파랑이면 **같은 화면에서 추천값과 액션을 색으로 구분할 수 없다**(세션 화면은 둘이 공존한다). 프로토타입 실측도 온보딩 ink 면 6 / 파랑 면 1(진행바), `chipStyle(on)` = `#151A21`, 탭 선택 = `#151A21` 로 일관된다. **대비는 양쪽 다 통과라(ink 17.48 / 파랑 7.09) 자동 게이트가 못 잡는다** → `test/action-color.test.ts` 로 별도 고정하고 뮤테이션으로 발화를 확인했다(CTA 를 파랑으로 되돌리면 2건 실패, 같은 뮤턴트를 `verify:contrast` 는 통과시킨다) | **확정**(사람 결정 2026-08-09, F1) |
| ADR-53 | 공용 `cn`은 **`tailwind-merge` 3.6.0**으로 Tailwind 클래스 충돌을 해소한다. Tailwind v4 `@theme`의 프로젝트 고유 radius·spacing·text·shadow 값은 `extendTailwindMerge`에 등록한다 | 단순 문자열 연결은 호출부 클래스가 기본 variant를 덮는다는 보장이 없어 목표·경력 카드 반경이 CSS 생성 순서에 따라 달라졌고 `!important` 우회 4곳이 생겼다. 기본 설정만 쓰면 커스텀 `rounded-card`를 같은 radius 그룹으로 인식하지 못함을 회귀 테스트가 실증했다 | 확정(T-UI-1, 2026-08-15) |
| ADR-54 | Pretendard는 **1.3.9 공식 Variable Dynamic Subset 92 WOFF2**를 CDN 없이 셀프호스팅한다. 공급자 `@font-face` CSS와 Next의 종전 fallback metric(Arial, ascent 93.76%, descent 23.75%, line-gap 0%, size-adjust 101.55%)을 수동 적용하고, 폰트 응답만 Serwist `CacheFirst` runtime cache에 둔다 | `next/font/local`은 이 92개 `unicode-range` 구성을 표현하지 못한다. 기존 정적 4웨이트는 첫 화면에서 1,051KB를 전송해 Lighthouse 100→92를 만들었다. 동적 서브셋은 실제 한글 대시보드를 11요청·303,896B로 줄여 중앙값 100을 회복했고, 수동 metric은 지연 로딩 전후 CLS 0·요소 치수 변화 0이었다. 오프라인 `FontFace.load()`도 SW 응답을 실측했다. 앱 셸·API 캐시는 STEP 6 소유로 남긴다 | **확정**(사람 결정 ①-V, T-UI-2, 2026-08-15) |
| ADR-55 | **M-UIb Sprint 0 계약 잠금**: RIR 0~6/`null` 단일필드 + 직접 입력 + 셰브론 바텀시트, 완료행 1줄, 체크 48×48, 온보딩 하단 24px. 운동 카드 `⋯`는 교체/통증 기록/삭제의 3항목 앵커형 `role="menu"`이며 방향키·Esc·외부 클릭·트리거 포커스 복귀를 지원한다. 기록이 있으면 교체·삭제는 포커스 가능한 `aria-disabled`, 통증 기록은 활성, 잠긴 액션은 요청 0회 + 사유 낭독이다. 건너뛰기·RIR 0~5/default2·길게 누르기·화면 ± 스테퍼·undo는 제외하고 기존 키보드 ↑/↓는 유지 | 기존 검증된 RIR 결측 경로와 iOS 선택 경로를 보존하면서 프로토타입의 메뉴 구조만 수용한다. 메뉴와 완료체크→타이머 시트는 동시에 열리지 않게 하고, 메뉴 닫힘의 트리거 복귀와 타이머 닫힘의 다음 세트 입력 복귀가 서로 덮어쓰지 않게 모달 소유권을 분리한다. F14 한글 키커는 비차단 별도 티켓이다 | **확정**(D-13~D-18, 2026-08-15) |
