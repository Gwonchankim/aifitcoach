# AIFITCOACH 스타터 킷 (AI 코딩 에이전트용)

기록 기반 폐루프 오토레귤레이션 운동 코칭 웹앱을 **Claude Code / Codex** 같은 AI 코딩 에이전트로
개발하기 위한 시작 저장소입니다. 코드 자체는 에이전트가 생성하고, 이 저장소는 에이전트를 **스펙과 규칙으로
정확히 안내**합니다.

## 이 저장소에 든 것
- `CLAUDE.md` / `AGENTS.md` — 에이전트 작업 지침(가장 중요). Claude Code는 `CLAUDE.md`를 자동으로 읽습니다.
- `docs/` — **진실의 원천**(제품·아키텍처·데이터·API·추천 엔진·보안·컨벤션·골든 테스트).
  - `docs/specs/` — `openapi.yaml`(API 계약), `golden_tests.json`(추천 엔진 계약), `exercises_seed.json`, `tutorial_program_rir.json`.
- `PROMPTS.md` — 단계별 복사·붙여넣기 프롬프트.
- `.github/workflows/ci.yml` — CI(타입체크·린트·테스트, 골든 테스트 게이트).
- `apps/`, `packages/` — 에이전트가 스캐폴딩할 위치(비어 있음).

## 사용법(요약)
1. 이 폴더를 Git 저장소로 만들고 커밋합니다.
2. Claude Code(또는 Codex)를 저장소 루트에서 실행합니다. 에이전트가 `CLAUDE.md`/`docs/`를 읽게 합니다.
3. `PROMPTS.md`의 단계 순서대로 프롬프트를 하나씩 실행합니다(한 번에 한 단계).
4. 각 단계 후 `pnpm typecheck && pnpm lint && pnpm test`가 통과하는지 확인합니다.
5. 보안·결제·개인정보 관련 변경은 **사람이 리뷰**합니다(`docs/SECURITY_PIPA.md`).

## 확정 스택
Next.js PWA(프론트) · NestJS(백엔드) · PostgreSQL/Redis · IndexedDB(오프라인) · 국내 PG 정기결제 · 쿠키 세션.
자세한 내용은 `docs/ARCHITECTURE.md`.

## 실행
```
pnpm install
cp .env.example .env            # 로컬 값(커밋 금지)
pnpm db:up                      # postgres:16, redis:7 (scripts/docker-compose.yml)
pnpm --filter web dev           # http://localhost:3000
pnpm --filter api start:dev     # http://localhost:3001
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test
```

## 목서버 / 코드젠
```
pnpm codegen                    # openapi.yaml → apps/web/lib/api-types.ts (생성물 커밋, CI가 드리프트 차단)
pnpm mock                       # prism 목서버 :4010
```
- 목서버는 `/v1` **없이** 루트에 마운트된다(`http://localhost:4010/exercises`). 실서버는 `/v1` 프리픽스(`http://localhost:3001/v1/exercises`) → 클라이언트 base URL만 교체해서 전환한다.
- 목서버는 openapi의 `cookieAuth`를 강제하므로 더미 쿠키가 필요하다: `curl -b "sid=dev" http://localhost:4010/exercises`.
