# AGENTS.md (for Codex and other coding agents)

Work rules here are identical to **`CLAUDE.md`**. Read `CLAUDE.md` and `docs/README.md` first.

Summary:
- Specs in `docs/` are the **source of truth**. Treat `docs/specs/openapi.yaml` (API contract) and `docs/specs/golden_tests.json` (recommendation-engine contract) as authoritative.
- Work in **small units (one ticket)** and run `pnpm typecheck && pnpm lint && pnpm test` after every change.
- Do not change security/payments/privacy(PIPA) code arbitrarily; if anything conflicts with the spec, ask first.
- Never weaken or bypass tests. Never commit secrets.

## 코딩 행동 원칙 (Andrej Karpathy 기반) — CLAUDE.md와 동일 적용
1. **Think Before Coding**: 추측하지 말고 가정을 명시·질문. 해석이 여럿이면 제시. 불명확하면 멈추고 질문.
2. **Simplicity First**: 요청한 것만. 투기적 추상화·유연성 금지. 200줄→50줄 가능하면 다시 쓴다.
3. **Surgical Changes**: 꼭 필요한 것만. 인접 코드/포맷 임의 개선 금지, 안 깨진 것 리팩터 금지, 내 변경이 만든 미사용만 제거.
4. **Goal-Driven Execution**: 성공 기준을 정의하고 테스트로 검증될 때까지 반복(추천 엔진·동기화는 테스트 먼저).
> 출처: andrej-karpathy-skills. 절충: 속도보다 신중함. 사소한 작업은 판단껏.

## 팀(서브에이전트)
네이티브 서브에이전트가 없으면, 메인 세션이 기술총괄로서 역할(frontend/backend/ui-ux/design/recommendation/qa/evaluator)로 작업을 분해해 순차/병렬로 진행한다. 역할·경계·병렬화·게이트는 `docs/AGENTS_TEAM.md`를 따른다.
