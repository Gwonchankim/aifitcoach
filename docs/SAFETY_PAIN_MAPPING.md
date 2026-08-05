# 통증 부위 → 운동 패턴 제외 매핑 (안전)

> **의료적 조언이 아니다.** 일반적인 회피 가이드이며, 통증이 지속·악화되면 전문가 상담을 권고한다.
> 이 문서는 온보딩 문진의 `pain_areas`(users.constraints)를 프로그램 생성에 반영하기 위한 **계약**이다.
> 사람 결정으로 확정(2026-08-05). 변경 시 사람 리뷰 필요.

## 매핑표

| pain_area | 제외할 movement_pattern |
|---|---|
| `knee` (무릎) | `squat`, `lunge`, `knee_extension` |
| `lower_back` (허리) | `hinge`, `squat` (deadlift/RDL 계열 전부 포함) |
| `shoulder` (어깨) | `vertical_push`, `horizontal_push`, `shoulder_isolation` |
| `elbow` (팔꿈치) | `elbow_extension`, `elbow_flexion` |
| `wrist` (손목) | (제외 없음 — 대신 머신/케이블 우선 정렬) |
| `hip` (고관절) | `hinge`, `lunge`, `squat` |
| `neck` (목) | `vertical_push`, `shoulder_isolation` |
| `ankle` (발목) | `lunge`, `calf`, `squat` |

## 규칙

1. **제외 후 해당 부위 운동이 부족하면** 같은 근육군의 **머신/케이블 종목으로 대체**한다(안정성 높은 것 우선).
2. **제외로 프로그램이 성립 불가해도 에러를 내지 않는다** — 축소된 프로그램을 생성하고 사유를 안내한다.
3. 응답에 **어떤 운동이 왜 제외됐는지 근거(reason)** 를 포함한다.
4. `wrist`는 제외 패턴이 없다. 대신 후보 정렬에서 머신/케이블(`equipment: machine|cable`)을 우선한다.
5. **통증 강도 가드레일과의 관계**: 이 표는 *프로그램 생성 시점*의 사전 회피다. 운동 중 보고되는 `pain_score >= 4`는
   `docs/RECOMMENDATION_ENGINE.md`의 `SUBSTITUTE_PAIN` 가드레일이 별도로 처리하며, 둘은 서로를 대체하지 않는다.
6. 사용자에게 노출되는 문구에도 "일반적 회피 가이드이며 의료적 조언이 아님"을 명시한다.
