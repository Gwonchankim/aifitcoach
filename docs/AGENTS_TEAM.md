# 팀(서브에이전트) 오케스트레이션 — AFC

개발을 역할별 전문 서브에이전트로 나눠 **병렬** 수행한다. 메인 세션이 **기술총괄(오케스트레이터)** 로서 STEP을 분해·배치·통합·게이트한다.

## 도구별 적용
- **Claude Code**: `.claude/agents/*.md`에 정의된 서브에이전트를 메인 세션이 위임한다(설명 기반 자동 위임 또는 명시적으로 해당 에이전트에 요청). 각 서브에이전트는 독립 컨텍스트에서 작업하고 결과를 반환한다. 서로 독립적인 작업은 동시에 진행할 수 있다.
- **Codex/기타**: 네이티브 서브에이전트가 없으면, 메인 프롬프트가 기술총괄로서 역할별 하위작업으로 분해하고 — 독립 모듈은 사람이 **여러 Codex 세션으로 병렬 실행**하거나 순차로 위임한다. 아래 역할·경계·게이트는 동일하게 적용한다.

## 에이전트
| 에이전트 | 담당 | 경계(하지 않는 것) |
|---|---|---|
| **tech-lead** | 계획·분해·배치·통합·의사결정 (메인 세션이 수행) | 코드 직접 작성 |
| **frontend** | apps/web 화면·컴포넌트·상태·라우팅 | api·shared 수정 |
| **ui-ux** | 인터랙션·상태·접근성·마이크로카피 스펙/리뷰 | 대규모 코드 구현 |
| **design** | 디자인 토큰·컴포넌트 스타일 | 로직·API |
| **backend** | apps/api·API·인증·동기화 | 추천 수학·프론트 |
| **recommendation** | packages/shared 추천 엔진(TDD) | api·프론트 |
| **qa** | 테스트·게이트·측정(Lighthouse/axe/E2E) | 기능 구현 |
| **evaluator** | 독립 평가·피드백(점수) | 코드 수정 |

> **기능별 담당**은 recommendation을 본떠 추가한다(예: `sync`, `rest-timer`, `billing` 특화 에이전트). 큰 STEP은 기능 단위로 frontend/backend 작업을 나눠 병렬화한다.

## 병렬화 원칙
- 서로 다른 파일/영역의 **독립 작업만** 동시에 배치한다. 같은 파일을 건드리면 **직렬화**한다.
- 자주 통합한다(작은 diff). 통합 후 **qa 게이트** → **evaluator 스코어카드**.
- 의존: 계약(openapi.yaml / golden_tests.json / DATA_MODEL.md)이 먼저 고정돼야 frontend/backend 병렬이 안전하다(STEP 2 이후 특히).

## STEP별 배치(권장)
| STEP | 병렬 배치 |
|---|---|
| 0 스캐폴딩 | tech-lead(주로 단독) |
| 1 DB/시드 | backend → qa 검증 |
| 2 코드젠/목서버 | backend + frontend(병렬) |
| 3 추천 엔진 | recommendation(TDD) + qa |
| 4 엔드포인트 | backend + qa(통합). 인증/PIPA 사람 검토 |
| 5 프론트(핵심) | **frontend + ui-ux + design(병렬)** + qa(E2E). 기능 많으면 frontend를 기능별로 분할 |
| 6 동기화 | backend + frontend + qa(유실0 E2E). 사람 검토 |
| 7 엔타이틀먼트/계측/RIR | backend + (기능 특화) + qa |
| 8 QA·안전·배포·최종평가 | qa + design(폴리시) + **evaluator(99점 루프)** |

## 핸드오프 프로토콜
1. **tech-lead**: 하위작업 + 컨텍스트(읽을 스펙/수용 기준)를 명시해 배치한다.
2. **전문가**: 산출물(diff) + 자기검증(명령 결과)을 반환한다. 경계 밖은 tech-lead에 요청한다.
3. **tech-lead**: 통합 + qa 게이트 실행. **evaluator** 스코어카드 요청.
4. 이슈 트리아지(fix-now / defer). PROGRESS.md·ADR 갱신. 커밋.
5. 다음 STEP.

## 모든 에이전트 공통 규칙
- 스펙(docs/)이 진실의 원천. **Karpathy 4원칙** 준수(가정 명시·최소 코드·외과적 변경·성공 기준 검증).
- 테스트 약화·시크릿 커밋·스펙 외 임의 생성 금지.
- **골든 테스트 실패·보안/PIPA 결함·데이터 손실은 절대 defer 금지(항상 fix-now).**
