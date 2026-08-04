# 추천 엔진 (핵심 IP) — 구현 규칙

> 계약(테스트): `specs/golden_tests.json`. 이 규칙과 그 테스트를 **모두** 만족해야 한다.
> `rules_version = "2026.07.1"`. 규칙 변경 시 버전과 골든 테스트를 함께 갱신한다.
> 구현은 `packages/shared`의 순수 함수로 두어 백엔드(권위)와 프론트(오프라인 미러)가 공유한다.

## 함수 시그니처
```ts
recommendNextSet(input): Recommendation
// input:  { goal, exercise:{type:'compound'|'isolation', region:'upper'|'lower'|'core', step_kg},
//           target:{reps_low, reps_high, rir}, last_sets:[{w,reps,rir?}],
//           calibration?:{rir_bias}, safety?:{pain_score}, rules_version }
// output: { weight, reps_low, reps_high?, sets?, reason_code, confidence, rules_version }
```

## 목표별 파라미터
| 목표 | target RIR | 반복(복합/고립) | 부하 |
|---|---|---|---|
| hypertrophy | 1–2 | 6–12 / 10–20 | 30–85% |
| strength | 2–4 | 3–5 | ≥80% |
| diet | 2–3 | 6–12 | 60–75% |

## 판정 기본값
- `hit_top` = 모든 작업세트 `reps >= target.reps_high`
- `too_hard` = 어느 세트 `reps < target.reps_low` **또는** 보고 RIR `< target.rir - 1`
- 증량 스텝: 상체 바벨/고립/케이블/덤벨 **+2.5kg**, 하체 바벨/머신 **+5kg** (= `exercise.step_kg`)
- 증량 시 `reps`는 하단으로 리셋
- 결측 RIR: RIR 조건 미적용(반복만으로 판정), `confidence` 하향

## 세션 간 진행 — 더블 프로그레션 (P0)
```
IF hit_top AND NOT too_hard:
    weight = round_to_step(last_weight + step_kg)   # 상체+2.5 / 하체·머신+5
    reps_low = target.reps_low                      # 반복 하단 리셋
    reason = WEIGHT_UP_REP_TARGET_MET
ELIF too_hard:
    IF (어느 세트 reps <= target.reps_low - 2) OR (RIR 0 AND reps < reps_low):
        weight = last_weight - step_kg              # 1스텝 감량
    ELSE:
        weight = last_weight                        # 유지
    reps_low = target.reps_low
    reason = TOO_HARD (또는 RIR만 낮으면 HOLD_RIR_LOW)
ELSE:
    weight = last_weight
    reps 목표 +1 (min(last_reps+1, reps_high))
    reason = ADD_ONE_REP
```
- 무게 증가가 어려운 고립운동은 반복 증가를 우선 과부하 수단으로 사용.

## RIR 기반 오토레귤레이션 (P1) — 부하 자기조절 1차 신호
```
corrected_RIR = clamp(reported_RIR + rir_bias, 0, 6)   # rir_bias: RIR 튜토리얼 산출

IF 모든 작업세트 corrected_RIR >= target.rir + 1:      # 너무 쉬움(여유 많음)
    → 증량(부하 우선), reps 하단 리셋   reason = RIR_TOO_EASY_INCREASE
ELIF 어느 작업세트 corrected_RIR <= target.rir - 1:    # 너무 힘듦
    → 유지 또는 감량                    reason = RIR_TOO_HARD_REDUCE
ELSE:
    → 더블 프로그레션(위)               reason = RIR_ON_TARGET / ADD_ONE_REP
```
- rir_bias 미확보(튜토리얼 미완료)·RIR 결측 시 RIR 축 판정 보류 → 반복 기반 더블 프로그레션.

## e1RM (표시·추세)
- Epley: `e1rm = weight * (1 + reps/30)`; RIR 보정: `effective_reps = reps + corrected_RIR`.
- 저반복(≤6) 세트에서 우선 산출(정확도↑). 고반복·실패 미도달은 오차 큼.

## 볼륨 관리 (P0 고정 / P1 자동)
- 근육군별 주간 hard set 집계(대략 0~3 RIR을 유효 세트로). 근비대 MEV≈10→MAV 16~20 점증(P1 자동), 다이어트 8~14 유지.
- 12세트 초과 후 성장 정체 시 세트 추가보다 부하/반복 진행 우선.

## 유사 운동 초기값 (기록 없음)
- 같은 `movement_pattern`·주동근 운동의 e1RM 비율로 보수적 초기값 + 신뢰도(예 60~80%). **1:1 변환 금지**. reason = SIMILAR_INIT.

## 디로드 트리거 (P1)
- 다음 중 3개↑: 반복 2세션 연속 하락 / e1RM 2주 정체·하락 / 주관 피로↑ / 수면↓ / 통증↑ → 볼륨 감소형 디로드 제안(세트 ~50%↓, 강도 유지). 완전 휴식 아님. 주기 대략 5~6주.

## 안전 가드레일 (진행규칙보다 항상 우선)
1. `pain_score >= 4` 또는 날카로운 통증 → 운동 중단·부하 하향·대체 제안 + 상담 안내. reason = SUBSTITUTE_PAIN
2. 주당 볼륨 급증 제한(+20% 초과 캡). reason = VOLUME_SPIKE_CAP
3. 추천 증량 상한 캡(초보·약한 사용자 과증량 방지)
> 안전 조건이 참이면 진행규칙(증량/반복)을 덮어쓴다.

## reason_code 목록
WEIGHT_UP_REP_TARGET_MET, ADD_ONE_REP, HOLD_RIR_LOW, TOO_HARD, SIMILAR_INIT, BASELINE,
INVALID_INPUT, SUBSTITUTE_PAIN, VOLUME_SPIKE_CAP, DELOAD_SUGGESTED,
RIR_TOO_EASY_INCREASE, RIR_ON_TARGET_HOLD, RIR_TOO_HARD_REDUCE,
CALIBRATION_NEEDED, CALIBRATION_GRADUATED, CALIBRATION_STALE

## 재현성
- 모든 추천에 `reason_code`와 `rules_version`을 부여·기록(분석·A/B). 골든 테스트가 회귀를 막는다.
