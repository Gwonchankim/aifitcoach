# 작업 워크플로 — Milestone / Step / Sprint (AFC)

> 이 저장소의 작업은 **Milestone 단위**로 수행한다. 프롬프트와 에이전트는 이 규약을 따른다.

## 범주
- **Milestone (최상위)** — 하나의 완결된 기능 묶음(예: "프로젝트 기반", "추천 엔진", "데일리 루틴 UX").
- **Step (중간)** — 모든 Milestone은 아래 **4개 Step**으로 구성되며, 순서대로(순차) 진행한다.
  1. **기획** — 기술총괄이 범위를 설계하고 Sprint로 분할(산출물·수용 기준·담당·병렬 여부). 코드 없음.
  2. **피드백** — 사람이 기획을 검토·수정·승인. 승인 후에만 개발 진입.
  3. **개발** — 승인된 계획을 여러 **Sprint**로 구현. Sprint는 병렬/직렬 혼합.
  4. **평가·수정** — qa 통합 게이트 + evaluator 스코어카드(증거 기반), 이슈 fix-now/defer, PROGRESS/ADR 갱신·커밋, 완료 판정.
- **Sprint (최하위)** — 개발 Step 안의 작은 작업 단위(담당 서브에이전트 1개, 명확한 산출물·수용 기준).

## Step은 순차, Sprint는 조건부 병렬
- Step 1→2→3→4는 **항상 순차**(이전 Step에 의존).
- 개발 Step 내부의 Sprint는 **서로 겹치지 않고 의존이 없으면 병렬**, 앞 산출물이 필요하면 **순차**.
- 병렬 판단 기준: 서로 다른 파일/영역을 건드리고, 계약(openapi.yaml/golden_tests.json/DATA_MODEL.md)이 이미 고정돼 의존이 없을 때만. 같은 파일을 만지면 직렬화.

## Orca /orchestration 패턴 (개발 Step에서 명시)
- **순차(phase 의존)**: `Use /orchestration to run in phases: A, then B, then tests. Start each child agent after the previous phase is done.`
- **병렬(비겹침 작업)**: `Use /orchestration to split across parallel child agents: <API 계약>, <backend>, <frontend UI>, <tests> — non-overlapping.`
- **작은 PR(각 child worktree)**: `Use /orchestration to split into smaller PRs, each in its own child worktree: <A>, <B>, <C>.`
> 개발 Step에서 독립 Sprint가 2개 이상이면 **반드시** 병렬 `/orchestration`을 프롬프트에 명시한다. 각 child는 자체 worktree로 리뷰 가능하게.

## 서브에이전트 매핑 (docs/AGENTS_TEAM.md)
- 기획/통합/결정 = **tech-lead**(메인 세션). Sprint 담당 = frontend / backend / ui-ux / design / recommendation. 게이트 = **qa**. 채점 = **evaluator**(코드 수정 X).

## 공통 규칙
- 스펙(docs/)이 진실의 원천. Karpathy 4원칙(가정 명시·최소 코드·외과적 변경·성공 기준 검증).
- 테스트 약화·시크릿 커밋·스펙 외 임의 생성 금지. 골든/보안/데이터손실은 절대 defer 금지.
- 테스트 단계 스코프(docs/TEST_SCOPE.md): production은 세션 인증, non-production 회귀 테스트만 dev-user 사용. 결제·법무 검토는 별도 범위다.

## 로드맵 (Milestone)
| # | Milestone | 포함(구 STEP) | 개발 Step 병렬 포인트 |
|---|---|---|---|
| M0 | 프로젝트 기반 (스캐폴딩+DB+계약) | 0,1,2 | 스캐폴딩 후 DB·OpenAPI 병렬 |
| M1 | 추천 엔진 (골든 TDD, 핵심 IP) | 3 | 대체로 단일(테스트 먼저) |
| M2 | 백엔드 핵심 (dev-user + programs/sessions + 루틴 편집 API) | 4 | 엔드포인트 그룹별 병렬 |
| M3 | 데일리 루틴 UX (FEATURES_UX F1~F8) | 5 | **frontend+ui-ux+design 병렬(최대)** |
| M4 | 대시보드 | 5(F8) | frontend+backend(대시보드 API) 병렬 |
| M5 | 오프라인 동기화 | 6 | backend+frontend+qa |
| 이후 | 엔타이틀먼트·계측 → 로그인·결제·법무 | 7,8 | — |

## Milestone 프롬프트 뼈대
```
[공통 서두: 읽을 docs + Karpathy 4원칙 + 스펙=진실의 원천]
# Milestone: <이름>  / 목표 / 관련 스펙
## Step 1. 기획(순차): tech-lead가 Sprint 분할·의존·병렬 계획 제시(코드 X), 승인 대기.
## Step 2. 피드백(사람): 검토·승인.
## Step 3. 개발: /orchestration으로 Sprint 배치(순차 phase + 비겹침 병렬, 각 worktree). Sprint 후 qa 게이트.
## Step 4. 평가·수정: qa 통합 + evaluator 스코어카드, fix-now/defer, PROGRESS/ADR·커밋, 완료 판정.
```
