# CLAUDE.md — 프로젝트 작업 지침 (에이전트 필독)

## 프로젝트
**AIFITCOACH (줄여서 AFC)** — 기록 기반 폐루프 오토레귤레이션 운동 코칭 **웹앱**. 사용자의 세트별 실측(무게·반복·RIR)으로
다음 유사부위 운동의 무게·반복·세트수를 자동 추천한다. 목표 3종(다이어트/근비대/스트렝스). 한국 시장.
핵심 IP = **추천 엔진**(설명가능·근거 기반). 자세한 배경은 `docs/PRODUCT.md`, 핵심 기능·UX는 `docs/FEATURES_UX.md`.

## 진실의 원천(Source of Truth)
- `docs/` 의 스펙을 **권위 있게** 취급한다. 기억/추측으로 만들지 말고 문서를 따른다.
- `docs/specs/openapi.yaml` = **API 계약**. `docs/specs/golden_tests.json` = **추천 엔진 계약**.
- 스펙과 코드가 충돌하거나 스펙이 모호하면 **임의로 결정하지 말고 먼저 질문**한다.

## 확정 스택(웹 우선)
- 프론트: **Next.js(App Router) + TypeScript + PWA(Service Worker/Workbox) + Tailwind**
- 상태/오프라인: **TanStack Query + Zustand + IndexedDB(Dexie) + Outbox**
- 백엔드: **NestJS(TypeScript) + PostgreSQL + Redis** (ORM: Prisma)
- 인증: 소셜 OAuth 웹 + **httpOnly 세션 쿠키 + CSRF**
- 결제: **국내 PG 정기결제(PortOne 등) 빌링키 + 웹훅**
- 배포: Vercel/클라우드(서울 리전), 프리뷰 URL
자세한 내용·근거는 `docs/ARCHITECTURE.md`.

## 레포 구조
```
apps/web        # Next.js PWA (프론트)
apps/api        # NestJS (백엔드)
packages/shared # 공유 TS 타입(도메인·openapi 파생), 추천 엔진 순수 로직(양쪽 공유)
docs/           # 스펙(진실의 원천) + specs/*.yaml,*.json
scripts/        # 시드 적재 등 유틸
```
> `packages/shared`에 추천 엔진 순수 함수(`recommendNextSet`)를 두어 백엔드(권위)와 프론트(오프라인 미러)가 **같은 코드**를 쓰게 한다.

## 개발/실행 명령 (스캐폴딩 후 최신화)
```
pnpm install
pnpm --filter web dev          # 프론트
pnpm --filter api start:dev    # 백엔드
docker compose up -d           # postgres, redis (scripts/로 제공 예정)
pnpm test                      # 전체 테스트 (골든 테스트 포함)
pnpm typecheck && pnpm lint
```

## 작업 방식(중요)
1. **한 번에 티켓 1개**만. "전체 앱"을 한 번에 만들지 않는다. 백로그의 US/TK 단위로.
2. **테스트를 계약으로**: 추천 엔진·동기화는 **테스트 먼저**(golden_tests.json / 시나리오) → 통과할 때까지 구현.
3. 매 변경 후 **`pnpm typecheck && pnpm lint && pnpm test`** 를 실행하고 결과를 보고한다.
4. **작은 diff**: 관련 없는 파일을 건드리지 않는다. 리팩터링은 별도 티켓.
5. 새 라이브러리는 버전을 고정하고, API가 불확실하면 최신 공식 문서를 확인한다(환각 금지).
6. 결정이 생기면 `docs/ARCHITECTURE.md`의 ADR 표에 한 줄 남긴다.

## 코딩 행동 원칙 (Andrej Karpathy 기반)
> 출처: andrej-karpathy-skills(LLM 코딩 실수를 줄이는 지침). 아래 4원칙을 위 규칙과 **함께 항상** 적용한다.
> 절충: 이 원칙은 속도보다 신중함에 무게를 둔다. 사소한 작업(오타·명백한 한 줄)은 판단껏.

**1. 코딩 전에 생각하라 (Think Before Coding)** — 추측 금지, 혼란을 숨기지 말고, 트레이드오프를 드러내라.
- 가정을 명시한다. 불확실하면 질문한다.
- 해석이 여럿이면 조용히 하나를 고르지 말고 제시한다.
- 더 단순한 방법이 있으면 말한다. 필요하면 반대 의견을 낸다.
- 불명확하면 멈추고, 무엇이 혼란스러운지 지목하고 질문한다.

**2. 단순함 우선 (Simplicity First)** — 문제를 푸는 최소 코드. 투기적 코드 금지.
- 요청하지 않은 기능·추상화·"유연성/설정성"·불가능한 시나리오용 에러 처리 금지.
- 200줄이 50줄로 가능하면 다시 쓴다. 판단 기준: "시니어 엔지니어가 과하다고 할까?" → 그렇다면 단순화.

**3. 외과적 변경 (Surgical Changes)** — 꼭 필요한 것만 건드리고, 내가 만든 흔적만 정리한다.
- 인접 코드·주석·포맷을 임의로 '개선'하지 않는다. 안 깨진 것을 리팩터하지 않는다. 기존 스타일을 따른다.
- 무관한 데드코드는 삭제하지 말고 **언급만** 한다. 변경으로 생긴 미사용(임포트/변수/함수)만 제거한다.
- 변경된 모든 줄은 요청에 직접 대응되어야 한다.

**4. 목표 주도 실행 (Goal-Driven Execution)** — 성공 기준을 정의하고 검증될 때까지 반복한다.
- "검증 추가" → "잘못된 입력 테스트를 쓰고 통과시켜라". "버그 수정" → "재현 테스트를 쓰고 통과시켜라".
- 다단계 작업은 간단한 계획 + 각 단계 `verify:`를 명시한다. 약한 기준("동작하게")은 피한다.
- (이 프로젝트에선 추천 엔진·동기화에 특히 적용: 골든 테스트/시나리오를 먼저 두고 통과시킨다.)

## 절대 규칙(하면 안 되는 것)
- **테스트를 우회·삭제·약화**시켜 통과시키지 않는다. 로직을 고쳐 통과시킨다.
- **시크릿을 커밋하지 않는다**(.env는 커밋 금지, `.env.example`만).
- **보안/결제/개인정보(PIPA) 코드를 임의로 바꾸지 않는다** → `docs/SECURITY_PIPA.md` 준수, 변경 시 사람 리뷰 요청.
- 추천 부하/RIR/안전 가드레일 수식을 스펙 없이 바꾸지 않는다(`docs/RECOMMENDATION_ENGINE.md`).
- `openapi.yaml`에 없는 엔드포인트/스키마를 임의 생성하지 않는다(필요하면 먼저 제안).

## 현재 우선순위(구현 순서)
0. 스캐폴딩 + CI  →  1. DB 스키마 + 시드  →  2. OpenAPI 코드젠·목서버  →
3. **추천 엔진 TDD(골든 25개 green)**  →  4. 백엔드 엔드포인트  →  5. 프론트 핵심 플로우  →
6. 오프라인 동기화  →  7. 결제(PG)·계측·RIR 튜토리얼  →  8. QA·안전·배포
(각 단계 상세·프롬프트는 팀의 "AI 개발 플레이북" 및 루트 `PROMPTS.md` 참조)

> 자동 진행: `/goal` 명령(.claude/commands/goal.md 또는 루트 GOAL.md)으로 STEP 0~8을 자율 수행하고, STEP마다 검증·트리아지, 최종 99점 이상까지 다듬는다. 진행 기록은 PROGRESS.md.
>
> 팀(서브에이전트): 메인 세션이 기술총괄로서 `.claude/agents`의 frontend/backend/ui-ux/design/recommendation/qa에 병렬 위임하고 evaluator로 게이트를 채점한다. 상세는 `docs/AGENTS_TEAM.md`.
>
> 테스트 단계 스코프: 로그인·결제·법무는 보류하고 고정 dev-user로 진행(STEP 4 auth 생략, STEP 6까지가 테스트 목표). 데이터는 항상 user_id에 매단다. 상세는 `docs/TEST_SCOPE.md`.
>
> 작업 방식: Milestone(기획→피드백→개발→평가·수정) 단위로 진행하고, 개발 Step의 독립 Sprint는 Orca `/orchestration`으로 병렬화한다. 규약·로드맵은 `docs/WORKFLOW.md`.
