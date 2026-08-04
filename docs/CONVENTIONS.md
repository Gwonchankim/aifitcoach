# 코딩 컨벤션

## 언어/도구
- TypeScript strict. ESLint + Prettier. 커밋 전 lint/format 통과.
- 패키지 매니저 pnpm(workspaces). Node 20.

## 네이밍
- 파일: 컴포넌트 PascalCase, 그 외 kebab-case. 변수/함수 camelCase. 타입/인터페이스 PascalCase.
- API 경로/JSON 필드: snake_case (openapi.yaml과 일치).
- DB: snake_case 테이블/컬럼.

## 에러 처리
- API 에러 엔벨로프: `{ "error": { "code", "message", "details? } }` (openapi Error 스키마).
- 예외를 삼키지 말 것. 도메인 에러와 시스템 에러를 구분.

## 테스트
- 단위: 추천 엔진(golden), 유틸. 통합: API+Postgres(Testcontainers). E2E: 핵심 플로우 + 오프라인 동기화.
- 커밋/PR마다 `pnpm typecheck && pnpm lint && pnpm test` 통과. 추천 골든 테스트 실패 시 머지 금지.

## 커밋
- Conventional Commits: feat|fix|chore|docs|test|refactor(scope): summary.
- 하나의 논리 변경 = 하나의 커밋/PR(작게).

## 폴더 컨벤션(백엔드)
- 모듈별 폴더(controller/service/dto/entity/repository). 도메인 로직은 service, I/O는 controller.
- 추천 순수 로직은 packages/shared에 두고 백엔드/프론트가 import.
