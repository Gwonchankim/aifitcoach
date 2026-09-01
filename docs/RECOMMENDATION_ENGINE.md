# 추천 엔진 (핵심 IP) — 구현 규칙

> 계약(테스트): `specs/golden_tests.json`. 이 규칙과 그 테스트를 **모두** 만족해야 한다.
> `rules_version = "2026.08.1"`. 규칙 변경 시 버전과 골든 테스트를 함께 갱신한다.
> 2026.08.1 = 2026.07.1 + "맨몸(체중 부하) 종목"·"시간 종목" **가산 규칙**. 기존(가중·반복) 입력의 출력은
> 하나도 바뀌지 않는다(골든 18건 무변경, 신규 7건 추가). apps/api가 맨몸·시간 처방을 실제로 내보내기 시작한
> 시점(STEP 4)에 `RULES_VERSION`·golden·openapi를 함께 올렸다.
> 구현은 `packages/shared`의 순수 함수로 두어 백엔드(권위)와 프론트(오프라인 미러)가 공유한다.

## 함수 시그니처
```ts
recommendNextSet(input): Recommendation
// input:  { goal, exercise:{type:'compound'|'isolation', region:'upper'|'lower'|'core',
//                           step_kg:number|null,           // null = 맨몸(자체중량)
//                           metric?:'reps'|'time'},        // 기본 'reps'
//           target:{reps_low?, reps_high?, rir?,           // metric='reps'
//                   time_low_sec?, time_high_sec?},        // metric='time'
//           last_sets:[{w?,reps?,rir?,time_sec?}],
//           calibration?:{rir_bias}, safety?:{pain_score}, rules_version }
// output: { weight:number|null, reps_low?, reps_high?, sets?,   // weight null = 자체중량
//           time_low_sec?, time_high_sec?,                      // metric='time'
//           reason_code, confidence, rules_version }
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

## 맨몸(체중 부하) 종목 — `step_kg = null`, `metric = reps`
> 대상: `e_dips`, `e_pullup` 등 `default_step_kg`가 없는 종목. **부하 대신 반복으로 진행**한다.
> `step_kg = 0`은 맨몸이 아니라 잘못된 증량 단위다(`INVALID_INPUT`). 맨몸은 반드시 `null`.

- 출력 `weight = null`(자체중량). 어떤 분기에서도 부하를 처방하지 않는다. `e1rm`도 내지 않는다(외부 부하 없음).
- RIR은 **부하 축(증량/감량) 판정에 쓰지 않는다** — 조절할 부하가 없다. `too_hard` 판정(유지 신호)에는 그대로 쓴다.
```
IF 어느 세트 reps <= 2 AND reps < target.reps_low:      # 하단에 크게 미달
    → 무한 하향 대신 보조 종목(랫풀다운·체스트프레스 머신 등) 제안
      reason = SUBSTITUTE_TOO_HARD_BODYWEIGHT (+ suggest_substitution: true)
ELIF hit_top AND NOT too_hard:
    IF target.reps_high >= 20:                          # 진행 상한
        reps 범위 유지 + 가중(웨이트 벨트)·난이도 상향 제안
        reason = PROGRESSION_CAP_BODYWEIGHT
    ELSE:
        reps_high = target.reps_high + 1                # 범위 자체를 올린다(부하 대신)
        reason = REPS_UP_BODYWEIGHT
ELIF too_hard:
    reps 범위 유지                                       reason = TOO_HARD / HOLD_RIR_LOW
ELSE:
    reps_low = min(최저 세트 reps + 1, reps_high)        reason = ADD_ONE_REP
```
- `REPS_UP_BODYWEIGHT`은 **상단만** 올린다(하단은 유지). 하단까지 함께 올리면 아직 못 하는 반복을 최소치로 강제하게 된다.
- 골든: GC-23(상단 도달), GC-24(미달), GC-25(상한), GC-26(대체 제안).

## 시간 종목 — `metric = time`
> 대상: `e_plank` 등. 무게·반복 대신 **목표 유지 시간**(`time_low_sec`/`time_high_sec`)을 처방한다.

- 출력: `weight = null`, `time_low_sec`, `time_high_sec`. `reps_low`/`reps_high`/`e1rm`은 내지 않는다.
- **RIR은 시간 종목에 적용하지 않는다(수집도 생략)** → RIR 결측을 이유로 `confidence`를 깎지 않는다.
- 진행 단위 `time_step` = 상단 60초 미만이면 **+5초**, 60초 이상이면 **+10초**. 하향 바닥은 10초.
```
min_time = 유효 세트(time_sec > 0) 중 최소
IF min_time >= target.time_high_sec:                    # 모든 세트가 상단 도달
    time_high_sec += time_step                          reason = TIME_UP
ELIF min_time < target.time_low_sec * 0.5:              # 하단의 절반에도 크게 미달
    time_low_sec  = max(10, time_low_sec  - time_step)
    time_high_sec = max(10, time_high_sec - time_step)  reason = TIME_DOWN
ELSE:
    범위 유지                                            reason = TIME_HOLD
```
- 골든: GC-27(상단 도달), GC-28(유지), GC-29(하향).

## RIR 기반 오토레귤레이션 (P1) — 부하 자기조절 1차 신호
```
corrected_RIR = clamp(reported_RIR + rir_bias, 0, 6)   # rir_bias: RIR 튜토리얼 산출

IF 모든 작업세트 corrected_RIR >= target.rir + 1:      # 너무 쉬움(여유 많음)
    → 증량(부하 우선), reps 하단 리셋   reason = RIR_TOO_EASY_INCREASE
ELIF 어느 작업세트 corrected_RIR <= target.rir - 1:    # 너무 힘듦
    → 유지 또는 감량                    reason = RIR_TOO_HARD_REDUCE
ELSE:                                                  # on-target
    → 더블 프로그레션(위)               reason = ADD_ONE_REP (상단 도달 시 WEIGHT_UP_REP_TARGET_MET)
```
> on-target 분기는 **별도 reason 을 만들지 않고** 더블 프로그레션으로 그대로 넘어간다.
> `RIR_ON_TARGET_HOLD` 는 V2-REASON-01 에서 **완전히 제거**했다(예약도 아니다) — 되살릴 설계가 없다.
> 이 계약은 골든 `GC-21`(calibrated + on-target → exact `ADD_ONE_REP`)이 고정한다.
- rir_bias 미확보(튜토리얼 미완료)·RIR 결측 시 RIR 축 판정 보류 → 반복 기반 더블 프로그레션.

### 보수 경로 계약 (V2-ENGINE-02에서 고정, 2026-08-23)

**uncalibrated RIR은 증량 신호가 될 수 없고 유지·감량 신호로만 쓴다.** 판별자는 엔진 입력
`calibration` 객체의 **유무**다(`recommendation.service.ts:75` — "존재 자체가 RIR 축 활성 스위치").
`rir_bias: 0`을 채워 넣는 것과 `undefined`는 의미가 다르다.

| calibration | hitTop | RIR | 결정 | reason |
|---|---|---|---|---|
| ✅ | — | 전부 `>= target+1` | 증량 | `RIR_TOO_EASY_INCREASE` |
| ✅ | — | 하나라도 `<= target-1` | 감량/유지 | `RIR_TOO_HARD_REDUCE` |
| ❌ | ✅ | 높음(쉬움) | **증량 — 근거는 RIR이 아니라 reps** | `WEIGHT_UP_REP_TARGET_MET` |
| ❌ | ❌ | 높음(쉬움) | **증량 금지**, 반복 +1 | `ADD_ONE_REP` |
| ❌ | — | `< target-1` | 유지 | `HOLD_RIR_LOW` |
| ❌ | — | `0` && `reps < low` | 1스텝 감량 | `TOO_HARD` |

두 `rules_version` bundle에 **동일하게** 적용한다(RIR 로직에 버전 분기를 만들지 않는다).
계약 원문·골든 매핑은 `docs/PROGRAM_V2_CONTRACT.md` §4.2.

## e1RM (표시·추세)
- Epley: `e1rm = weight * (1 + reps/30)`; RIR 보정: `effective_reps = reps + corrected_RIR`.
- 저반복(≤6) 세트에서 우선 산출(정확도↑). 고반복·실패 미도달은 오차 큼.

## 볼륨 관리 (P0 고정 / P1 자동)
- 근육군별 주간 hard set 집계(대략 0~3 RIR을 유효 세트로). 근비대 MEV≈10→MAV 16~20 점증(P1 자동), 다이어트 8~14 유지.
- 12세트 초과 후 성장 정체 시 세트 추가보다 부하/반복 진행 우선.

## 유사 운동 초기값 (기록 없음)
- 같은 `movement_pattern`·주동근 운동의 e1RM 비율로 보수적 초기값 + 신뢰도(예 60~80%). **1:1 변환 금지**. reason = SIMILAR_INIT **(예약 — 아직 emit 경로 없음)**.

## 디로드 트리거 (P1)
- 다음 중 3개↑: 반복 2세션 연속 하락 / e1RM 2주 정체·하락 / 주관 피로↑ / 수면↓ / 통증↑ → 볼륨 감소형 디로드 제안(세트 ~50%↓, 강도 유지). 완전 휴식 아님. 주기 대략 5~6주. reason = DELOAD_SUGGESTED **(예약 — 아직 emit 경로 없음)**.

## 안전 가드레일 (진행규칙보다 항상 우선)
1. `pain_score >= 4` 또는 날카로운 통증 → 운동 중단·부하 하향·대체 제안 + 상담 안내. reason = SUBSTITUTE_PAIN
2. 주당 볼륨 급증 제한(+20% 초과 캡). reason = VOLUME_SPIKE_CAP **(예약 — 아직 emit 경로 없음, `V2-PLAN-02` 소유)**
3. 추천 증량 상한 캡(초보·약한 사용자 과증량 방지)
> 안전 조건이 참이면 진행규칙(증량/반복)을 덮어쓴다.

## reason_code 목록

**runtime `REASON_CODES` = 실제로 반환될 수 있는 16종.** 이 목록에 무언가를 추가하려면
**emit 경로와 테스트를 함께** 만들어야 한다 — `packages/shared/test/reason-codes.test.ts`가
"union == 실제 emit 집합"을 exact로 강제하므로, 경로 없는 코드를 넣으면 즉시 실패한다.

```text
WEIGHT_UP_REP_TARGET_MET, ADD_ONE_REP, HOLD_RIR_LOW, TOO_HARD,
LOAD_CALIBRATION_NEEDED, BASELINE, INVALID_INPUT, SUBSTITUTE_PAIN,
RIR_TOO_EASY_INCREASE, RIR_TOO_HARD_REDUCE,
REPS_UP_BODYWEIGHT, PROGRESSION_CAP_BODYWEIGHT, SUBSTITUTE_TOO_HARD_BODYWEIGHT,
TIME_UP, TIME_HOLD, TIME_DOWN
```

> **예약 `RESERVED_REASON_CODES` — 응답에 나오지 않는다(정확히 4종).**
> `SIMILAR_INIT`(유사 운동 초기값) · `VOLUME_SPIKE_CAP`(안전 가드레일 2) ·
> `DELOAD_SUGGESTED`(디로드 트리거 P1) · `CALIBRATION_STALE`(stale 정책 사람 승인 전).
> union에 남겨 두면 모든 소비자가 "가능한 응답"으로 처리해야 하므로 예약이 아니라 부채가 된다.
> 되살릴 때는 **입력·emit 경로·테스트와 함께 원자적으로** 옮긴다.
> `VOLUME_SPIKE_CAP`은 집계 데이터(`muscle_weekly_load`)가 이미 있으나 **엔진 입력 채널과
> 오프라인 미러 대책이 없어** `V2-PLAN-02` 소유다.
>
> **`RIR_ON_TARGET_HOLD`는 완전히 제거했다(예약도 아니다).** on-target은 별도 reason을 만들지 않고
> 더블 프로그레션으로 넘긴다는 것이 설계이므로 되살릴 계획 자체가 없다.
>
> **`CALIBRATION_NEEDED`·`CALIBRATION_GRADUATED`는 추천 근거가 아니라 튜토리얼 상태다.**
> `CalibrationStatus`(`not_started|in_progress|graduated|stale`)로 표현한다 — 새 vocabulary를
> 만들지 않는다(소유: `V2-RIR-01`).
>
> `LOAD_CALIBRATION_NEEDED`는 **`rules_version = 2026.09.0`에서만** 나온다. `2026.08.1`의 external
> 무이력은 기존 `BASELINE + weight 0` 의미를 그대로 유지한다(docs/PROGRAM_V2_CONTRACT.md §4.1).

## 재현성
- 모든 추천에 `reason_code`와 `rules_version`을 부여·기록(분석·A/B). 골든 테스트가 회귀를 막는다.
