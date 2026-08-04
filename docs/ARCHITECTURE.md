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
| ADR-15 | 삭제는 FK CASCADE 대신 RESTRICT + 애플리케이션 퍼지 잡 | SECURITY_PIPA.md의 "소프트 삭제 후 퍼지" 설계와 정합, 실수 삭제 방지 | 잠정(STEP 4에서 사람 리뷰) |
