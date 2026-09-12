# PROGRAM_V2_CONTRACT — 운동 프로그램 V2 계약 (V2-SPEC-01)

승인: 사람 결정 2026-08-23 (Claude 초안 + Codex 검토 합의)
관련 ADR: **ADR-70**(게이트 축 분리·ADR-47 대체), **ADR-71**(제품정책 vs 근거 표기), **ADR-72**(RPE scale id)

이 문서는 V2 계약의 **원천**이다. 코드는 아직 V1이며, 각 절 끝의 `구현 티켓`이 이 계약을 코드로 옮긴다.
**이 문서와 현재 코드가 다르면 코드가 아직 안 따라온 것이다.** 그 반대가 아니다.

## 0. 이 계약이 반드시 지키는 3문장

1. **external 첫 세션에도 target reps와 calibration reason은 반환한다. load 값만 미준비다.**
   `recommendation_state=load_calibration_needed`는 `recommended_weight`만 `null`로 만들고,
   `recommended_reps`·`reason_code`는 첫 세션부터 항상 반환한다. `confidence`는 3세션 전까지 비공개다.
   **이 문장이 §1 표·§1.1 매트릭스·ADR-70·M4/UX 주석의 유일한 기준이다.**
2. **S/C/H 배치표와 세션 세트 상한은 문헌이 직접 정한 수치가 아니다.** evidence envelope 안에서 정한
   버전 관리되는 **제품정책**이며, 문서·코드·UI 어디에도 "연구 근거"로 표기하지 않는다.
   버전은 `Program.rules_version` rules bundle이 운반한다(§2.6).
3. **RPE는 `relative_effort_0_10_v1`.** Bok et al.(PMID 35507232)은 6~20 Borg 기반이므로 그 논문의
   10~11 / 13~15 값을 0~10으로 산술 변환해 쓰지 않는다. scale id는 암묵 상수가 아니라
   `PlannedSet.rpe_scale_id`로 저장한다(§3.1).

---

## 1. 표시 게이트 — 두 축 분리 (ADR-47 대체)

ADR-47은 성격이 다른 두 값을 한 게이트로 묶었다. **e1RM 추정·추세**는 서로 다른 날의 반복 관측이 필요하지만,
**다음 세트 처방**은 1세션 기록으로도 성립하는 결정론적 규칙이다. V2는 두 축을 분리한다.

```text
recommendation_state = ready | load_calibration_needed | substitution_required | unavailable
                                                         # 이 처방을 그대로 수행해도 되는가 (§1.2)
analysis_gate        = no_history | early | ready        # 통계 추정을 보여줄 수 있는가
```

**두 값은 서로 다른 것을 막는다. 겹치지 않는다.**

| 값 | V1 (ADR-47) | V2 | 무엇이 제어하나 |
|---|---|---|---|
| `recommended_weight` | 3세션 전 `null` | `load_calibration_needed`이면 `null`, 그 외에는 해당 상태의 값 | `recommendation_state` |
| `recommended_reps` | 3세션 전 `null` | **항상 반환**(첫 세션 포함) | 게이트 없음 |
| `reason_code` | 3세션 전 `null` | **항상 반환**(첫 세션 포함) | 게이트 없음 |
| `confidence` | 3세션 전 `null` | **3세션 전 `null` 유지** | `analysis_gate` |
| `e1rm` · 추세 · 연결선 | 3세션 전 `null` | **3세션 전 `null` 유지** | `analysis_gate` |

- **`load_calibration_needed`는 "external load 값만 미준비"라는 뜻이다.** 처방 전체를 막지 않는다.
  이 상태에서도 목표 반복 범위(`reps_low`/`reps_high`)와 `LOAD_CALIBRATION_NEEDED` reason은 반환한다 —
  사용자가 목표 반복을 알아야 캘리브레이션을 할 수 있다.
- `ready`는 **해당 modality에 적용되는 모든 처방 구성요소가 준비된 상태**다. 맨몸·시간 종목은 처방할 외부 부하가
  없으므로 첫 세션부터 `ready`다.
- `recommendation_state`에는 **`substitution_required`(통증)·`unavailable`(잘못된 입력·metadata 부재)** 도 있다.
  이 둘은 load substate가 아니라 **처방 수행 자체를 막는 safety/error 상태**다. 전체 4값과 정규화는 §1.2.
- `confidence`는 내부 계산·저장을 유지하되 응답에서 nullable이다. 초기 confidence는 사용자가 행동할 정보가
  아니라 분석 성숙도 정보이고, 낮은 숫자를 단독 노출하면 결정론적 처방에 대한 불필요한 불신을 만든다.
  응답의 `null`은 "값 없음"이 아니라 **ADR-70에 의한 비공개**다 — `confidence: 0`(명시적 zero confidence)과 다른 의미다.
- 기존 `recommendation_gate`(= `DisplayGateState`)는 V1 캐시·decoder 호환용으로만 남기고 V2 계약에서 deprecated.
- **별도 `recommendation_gate`를 추가하지 않는다.** `recommendation_state`는 이미 이 계약의 시작중량 절에 있는
  값이고, `analysis_gate`는 기존 `DisplayGateState`의 세 값을 그대로 쓴다.

### 1.1 wire contract 매트릭스 (V2-GATE-01 착수 전 필독)

**`analysis_gate`는 개념 축 이름이지 새 wire 필드가 아니다.** 새 필드를 중복 추가하지 않고 기존 `/v1` 필드에
매핑한다 — 이름은 그대로 두고 **의미를 analysis-only로 좁힌다**.

| 응답 | analysis 축의 V2 wire field | 계약 |
|---|---|---|
| `PlannedSet` | 기존 `recommendation_gate` | required, non-null `DisplayGateState`. 이름은 deprecated이나 `/v1`에서 유지, 의미는 analysis-only |
| `GatedRecommendation` | 기존 `gate_state` | required, non-null. analysis-only |
| `E1rmAnalytics` | 기존 `gate_state` | required, non-null. e1RM·points·confidence만 제어 |
| dashboard `primary_e1rm` | 기존 `gate_state` | required, non-null. 분석값만 제어 |

> 이 필드들은 **deprecated field가 아니라 deprecated name, retained compatibility field**다.
> **제거 조건**: API major version과 구형 PWA 클라이언트 sunset 절차가 생기기 전에는 제거하지 않는다.
> 현재 client-version handshake·min-version 계약이 없으므로 **V2 안에서 제거 날짜를 약속하지 않는다.**

### 1.2 `recommendation_state` — 안전·오류 상태까지 완결한 4값 enum

`ready`/`load_calibration_needed` 2값만으로는 **통증 가드레일과 잘못된 입력이 표현되지 않는다.** 두 경우 모두
"처방을 그대로 수행하면 안 되는" 상태인데 `ready`로 떨어지면 클라이언트가 정상 처방과 구분할 수 없다.

| 값 | 의미 |
|---|---|
| `ready` | 현재 운동 처방의 **적용 가능한 축이 준비됨** |
| `load_calibration_needed` | external load만 미정이며 **target reps로 보정 가능** |
| `substitution_required` | 통증 가드레일로 현재 운동을 중단하고 **무통 대체가 필요** |
| `unavailable` | 잘못된 입력 또는 **필수 카탈로그 메타데이터 부재**로 안전한 처방을 만들 수 없음 |

**정규화 우선순위 — 명시 state와 reason을 `OR`로 결합해 위에서부터 판정한다.**

```text
1. reason === SUBSTITUTE_PAIN          OR  state === substitution_required     → substitution_required
2. reason === INVALID_INPUT            OR  state === unavailable               → unavailable
3. reason === LOAD_CALIBRATION_NEEDED  OR  state === load_calibration_needed   → load_calibration_needed
4. 그 외                                                                        → ready
```

**"명시 state가 있으면 그대로 쓴다"를 폐기한 이유.** 명시 state를 먼저 신뢰하면 두 방향 모두에서 안전 상태가
증발한다 — `{state: ready, reason: SUBSTITUTE_PAIN}`은 통증 대체가 필요한데 `ready`로 통과하고, 반대로
명시된 보수적 state를 benign한 reason이 완화해버릴 수도 있다. **`OR` 결합은 어느 한쪽만 위험을 알아도 위험으로
판정**하므로 두 경우 모두 fail closed다. 두 신호가 어긋나는 것 자체가 데이터 결함이므로 관대한 쪽을 고르지 않는다.

추가 규칙:

- V1 `BASELINE`이고 canonical exercise가 **external**이며 `weight`가 `0 | null`이면 3번 항목으로 판정한다
  (`load_calibration_needed`).
- bodyweight·time baseline과 유효한 이력 처방은 4번(`ready`)이다.
- **필수 metadata 부재로 위 판별 자체가 불가능하면 `unavailable`로 fail closed**한다. 필드가 없는 구형 PWA
  mirror에서 canonical exercise metadata조차 없는 경우가 여기다. **추측해서 `ready`로 떨어뜨리지 않는다.**
- 명시 state 값은 그대로 쓰지 않더라도 **enum 유효성은 검증**한다. 알 수 없는 문자열은 신호로 취급하지 않는다.

**저장·전송**

- **API 응답은 required·non-null.** DB 컬럼은 nullable로 추가하거나 저장 없이 응답 시 파생해도 된다.
  어느 쪽이든 **기존 행 일괄 backfill은 하지 않는다.**
- 서버 response mapper와 PWA Dexie read/write가 **같은 shared pure normalizer**를 쓴다. 두 벌로 구현하면
  온라인·오프라인 판정이 갈라진다.
- 구형 mirror는 **read-normalize-rewrite** — 읽을 때 정규화하고 정규화된 값을 다시 저장한다.
- **V2-GATE-01 AC로 잠글 offline fixture 12종.**

  **① 기본 7종** — V1 external baseline · bodyweight baseline · time baseline · weighted history ·
  pain · invalid · metadata-missing.

  **② `reason → state` 방향 2종** (명시 state가 관대해도 reason이 위험하면 위험으로):

  | fixture | 기대 |
  |---|---|
  | `{state: ready, reason: SUBSTITUTE_PAIN}` | `substitution_required` |
  | `{state: ready, reason: INVALID_INPUT}` | `unavailable` |

  **③ `state → 보수성 유지` 방향 3종** (reason이 benign해도 명시 state가 위험하면 위험으로):

  | fixture | 기대 |
  |---|---|
  | `{state: substitution_required, reason: BASELINE}` | `substitution_required` |
  | `{state: unavailable, reason: BASELINE}` | `unavailable` |
  | `{state: load_calibration_needed, reason: BASELINE}` | `load_calibration_needed` |

  **②와 ③은 서로 다른 mutation을 잡는다.** ②만 있으면 normalizer가 **명시 state를 통째로 무시하고
  reason만 보도록** 바뀌어도 전부 통과한다(benign한 `BASELINE`이 `ready`로 흘러간다).
  ③만 있으면 반대로 "명시 state 선사용"으로 되돌아가도 통과한다.
  `OR` 결합 계약은 **양방향 fixture가 모두 있어야** 방어된다.

### 1.3 `recommendation_state`가 실리는 위치

**처방 객체가 있는 곳에만** required로 추가한다.

| 위치 | `recommendation_state` |
|---|---|
| shared engine `Recommendation` | required |
| OpenAPI `Recommendation` | required, enum `ready \| load_calibration_needed \| substitution_required \| unavailable` |
| `PlannedSet` | required |
| `GatedRecommendation.recommendation` · `E1rmAnalytics.next_recommendation` | nested `Recommendation`으로 전달 |
| dashboard `primary_e1rm` | **추가하지 않는다** |

필드 nullability:

| 필드 | 계약 |
|---|---|
| `recommended_weight` / `weight` | **required key + nullable.** calibration-needed external은 `null` |
| `recommended_reps` / target reps | modality에 따라 nullable. **calibration-needed external에서는 target reps를 반환한다** |
| `reason_code` | 처방 객체가 있으면 **non-null**. calibration reason도 첫 세션부터 반환 |
| `confidence` | **required key + nullable인 public wire 값.** `analysis_gate != ready`면 `null`. 엔진 내부의 calibration `confidence: 0`과 구분한다 |
| `GatedRecommendation.recommendation` · `E1rmAnalytics.next_recommendation` | 진짜 처방 자체가 없는 경우를 위해 nullable 유지. **analysis gate만으로 null 처리하지 않는다** |

### ADR-49와 충돌하지 않는 이유

ADR-49는 추천 **수식** 변경을 UI 마일스톤에서 분리하고 근거+골든을 먼저 두라는 결정이다.
이 절은 confidence 계산식도 증량 수식도 바꾸지 않는 **표시·API 계약 변경**이다. 다음을 함께 지킨다.

1. ADR-70이 ADR-47을 명시적으로 supersede한다.
2. 표시 계층에서 `analysis_gate`를 적용한다는 ADR-49 원칙은 유지한다.
3. `LOAD_CALIBRATION_NEEDED`·external 0kg 제거는 별도 V2-ENGINE-01이며 골든 red가 선행한다.
4. `confidence` 계산식·임계값 변경은 별도 M-ENGINE 티켓이다.

**구현 티켓: V2-GATE-01.** 대상(실측):
`apps/api/src/sessions/sessions.service.ts:526-527, 683-691` · `apps/api/src/sync/sync.service.ts:646-654` ·
`apps/api/src/analytics/analytics.service.ts:61, 213-214` · `packages/shared/src/display-gate.ts` ·
`docs/specs/openapi.yaml`(`GatedRecommendation`, `E1rmAnalytics`, `recommendation_gate`) ·
`docs/UX_STATES.md` §2.3·§11 · `docs/M4_CONTRACT.md` §4 · 해당 E2E.

---

## 2. 프로그램 생성 계약표

### 2.1 작성 분업 — 3단계 (순서가 계약이다)

1. **현행 inventory** — V1 값을 사실 그대로 추출하고 각 값에 **코드 위치와 기존 골든**을 연결한다.
   → **완료: `docs/PROGRAM_V1_INVENTORY.md`.** 결과 요약: 현행은 저항운동 전용이고 `experience_level`은
   종목 난이도 필터에만 쓰인다(세트·반복·휴식에 영향 없음). **현행 strength 프로그램이 아래 §2.4 세트 cap을
   전 시간 구간에서 초과하고, 30·45분 strength는 처방 시간 안에 물리적으로 끝낼 수 없다** — **§2.4의 B+C로 해소됨.**
2. **V2 constraint envelope** — 문헌 지지 범위 + 안전·시간 불변식을 별도 표로 만든다.
3. **smallest-diff mapping** — V1 값을 envelope 안에서 최대한 보존하고, **벗어나는 값만** 근거 또는
   명시적 제품정책으로 수정한다.

> **V1은 출발점이지 근거가 아니다.** 1단계 결과를 그대로 계약으로 승격하지 않는다.

### 2.2 375칸 표를 만들지 않는다

`5목표 × 주2~6일 × 5시간 × 3경험 = 375`를 한 표로 만들면 검증도 설명도 불가능하다. 직교 계약으로 분해한다.

| 계약 | 축 | 산출물 |
|---|---|---|
| composition | 목표 × 주당일수 | S/C/H 문자열 |
| time budget | 시간옵션 | 세션 time budget + 작업세트 hard cap |
| role/volume | 목표 × 경험 | role 배정, 세트 시작 구간 |
| safety | 공통 | 통증·장비·fallback 불변식 |

전체 cross product는 **자동 생성 property test만** 순회한다.

### 2.3 S/C/H composition — **확정 제품정책** (근거 아님)

**버전 구분(ADR-73, 2026-09-05): 아래 기존 표는 예약 `2026.09.0`의 의미로 보존한다. 이번 전체 기능개선이 최종 활성화할 `2026.09.1`의 4·5일 개편 표는 다음 절에 있다. 두 버전의 persisted snapshot을 서로 재해석하지 않는다.**

문자열은 주간 횟수 composition이며 실제 요일은 회복 가드레일이 정한다.
`S` = 저항운동 중심, `C` = 유산소 중심, `H` = 혼합.

| goal | 2일 | 3일 | 4일 | 5일 | 6일 |
|---|---|---|---|---|---|
| `diet` | HH | HHC | HHCC | HHCCC | HHCCCC |
| `hypertrophy` | SS | SSH | SSSH | SSSSH | SSSSHH |
| `strength` | SS | SSH | SSSH | SSSHC | SSSSHC |
| `general_fitness` | HH | HHC | SSCC | SSHCC | SSHHCC |
| `endurance` | HH | HHC | HHCC | HHCCC | HHCCCC |

- `diet`와 `endurance`의 composition이 같은 것은 오류가 아니다 — **cardio 처방 내용이 다르다**
  (steady 비중, long session 유무, interval 자격·진행).
- `hypertrophy`/`strength`의 `H`는 **short steady cardio**이며 HIIT 기본 배치가 아니다.

**위 표에 미확정 셀은 없다.** 전 조합이 확정 제품정책이며, 값을 바꾸려면 `rules_version` bundle을 올린다(§2.6).

`general_fitness` 3일의 이력: 초기 안은 `SHC`였는데 2일 `HH`에 없던 순수 `S`가 3일에 등장해 구성 성격이
불연속이었다 — 사용자가 주2일 → 주3일로 늘렸을 때 프로그램이 "발전"이 아니라 "다른 것"으로 보인다.
**`HHC`로 확정**했다. 저항 노출 2회와 혼합 성격을 보존하면서 `C`만 추가하므로 2일 → 3일이 증분이 된다.
문헌 수치가 아니라 ADR-71의 versioned product policy다.

#### 2.3.1 개편 `2026.09.1` — 모든 4·5일의 실제 저항 초점

사용자 사양 개정1·2와 독립 계약 합의(ADR-73). 순수 C를 H로 전환하되 같은 슬롯의 유산소 block을 보존한다. S/H 문자의 이름만 바꿔 저항 빈도를 맞추지 않는다.

| goal | 2일 | 3일 | 4일 | 5일 | 6일 |
| --- | --- | --- | --- | --- | --- |
| diet | HH | HHC | HHHH | HHHHH | HHCCCC |
| hypertrophy | SS | SSH | SSSH | SSSSH | SSSSHH |
| strength | SS | SSH | SSSH | SSSHH | SSSSHC |
| general_fitness | HH | HHC | SSHH | SSHHH | SSHHCC |
| endurance | HH | HHC | HHHH | HHHHH | HHCCCC |

- 4일은 MON/TUE/THU/FRI에 U/L/U/L(2:2). 5일은 MON/TUE/WED/FRI/SAT에 balanced·upper_priority = U/L/U/L/U(3:2), lower_priority = L/U/L/U/L(2:3). balanced 기본의 상3/하2 의미를 UI에서 명시한다. 2·3·6일 경량 선호는 N/A다.
- 각 4·5일 초점에 실제 해당 부위 non-core primary ≥1종 × ≥2 working sets가 있어야 한다. primary 불가·시간 부족은 명시 생성 불가이며 빈/유산소 전용 세션을 해당 부위로 세지 않는다.
- 같은 부위 최소48시간은 주 경계까지 검사하는 제품 일정 규칙이다. 새 swap operation에도 교환 후 실제 인접 주를 후보 및 최종 transaction에서 검사하고 위반409·양쪽 불변을 유지한다. 기존 프로그램을 이 규칙으로 backfill하지 않는다.
- 유산소 숫자 정책은 아직 미구현이다. **Sprint04 첫 CARDIO-CONTRACT-BASELINE(ticket10)의 docs+golden 전용 SHA를 제품 코드보다 먼저 승인·동결**한다. 순서는 freeze → PLAN-02 → cardio generator/wire → 개편 split/packer → 전체 `.09.1` activation이다. 기존 원천의 기계적 전사는 Evaluator 승인, 새 수치·용량 감소·생성 불가 확대는 Planner→사용자 승인이다.
- 개편 전 동일 입력과 원래 fallback의 descriptor/총초/강도별초/interval/long-session을 먼저 고정하고 개편 결과와 exact 비교한다. 개편 유발 fallback으로 baseline을 재설정하지 않는다. 불변을 못 지키면 명시 생성 불가이며 무승인 shortfall은 금지한다.
- §2.4 cap·§4.4 estimator/primary 보호는 그대로 사용하고 mandatory cardio 전체 시간을 additional_fixed_block_sec에 포함한다. 시간 예산 밖으로 cardio를 숨기거나 primary를 없애지 않는다. 상세 오류·배포·snapshot 계약은 [기능개선 계약](FEATURE_IMPROVEMENTS_CONTRACT.md), 기계적 fixture는 [예약 정책 fixture](specs/feature_improvements_contract.json)다. 이는 기능 runtime 검증 완료 주장이 아니다.

### 2.4 세트 envelope

| 항목 | 값 | 성격 |
|---|---|---|
| 운동당 기본 working sets | **2~3** | **evidence envelope** (ACSM 2026 position stand가 직접 지지) |
| 4번째 세트 | 목표·시간·수행이력이 허용할 때만 | **제품정책.** 문헌이 직접 지지하는 값이 아니다 |
| 5세트 | history로 tolerance가 확인된 **primary 1개/세션**에만 | **제품정책.** `experience_level=advanced`만으로는 불허 |
| `hypertrophy` 근육군별 주간 direct hard set | 시간 허용 시 약 8~12, 중심 10 | 문헌 참조값. **시간을 넘겨 강제하지 않음** |
| `strength` compound 기본 | **3세트** (V1의 5에서 하향) | **확정 제품정책.** V1의 5는 문서 근거 없는 해석값이었다 |
| `strength` priority lift | 주 2회 노출 우선, 노출당 2~3 working sets | 문헌 + 제품정책 |
| `diet`/`general_fitness`/`endurance` 저항축 | 주요 패턴 주 2회 + 운동당 2~3세트 우선 보장 | **제품정책.** 경험별 밴드는 직접 근거가 약하다 |
| 세션 총 작업세트 hard cap | 30/45/60/75/90분 → 8/12/16/20/24 | **운영 가드레일. 임상 근거 아님** |

#### V1 cap 충돌 — **B+C 확정** (2026-08-23)

현행 V1 strength는 이 cap을 모든 시간 옵션에서 초과하고, 30·45분은 처방 시간 안에 물리적으로 끝낼 수 없다
(실측·산술은 `docs/PROGRAM_V1_INVENTORY.md` §5). 세 선택지 중 **B와 C를 함께 채택**하고 A는 기각한다 —
cap을 V1 결함에 맞춰 올리는 것은 계약을 결함에 맞추는 일이다.

- **B(세트)** — `strength` compound 기본을 **5 → 3세트**로 내린다. 4번째는 시간·이력이 허용할 때의 제품정책,
  5세트는 수행 이력으로 tolerance가 확인된 **primary 1개/세션**에만 허용한다.
  `experience_level=advanced`만으로는 허용하지 않는다. 신규·미캘리브레이션 사용자의 기본은 3세트다.
- **C(운동 개수)** — 고정 `EXERCISE_COUNT` 상수표를 목표별로 늘리지 않는다. V2 generator는
  **role 우선 + 시간 추정 기반 packer**다: ① primary 1개 확보 ② 시간이 성립하면 secondary 1개 확보
  ③ accessory/core를 예상시간과 hard cap 안에서만 추가 ④ 초과 시 `accessory 제거 → 비-primary 세트 감축 →
  운동 제거` ⑤ primary는 최후에 감축하며 **accessory가 남은 채 primary가 잘리는 결과는 금지**.
  그래서 30분 strength는 보통 primary+secondary **2종 × 3세트 = 6 working sets**에서 시작한다.
  현행 `EXERCISE_COUNT`는 V1 inventory 기록으로만 남고 **V2 generator에서 폐기**된다.

**기존 사용자 영향: 데이터 마이그레이션 없음, 동작 마이그레이션 있음.** DB backfill도 기존 active V1 프로그램
수정도 하지 않는다. V2 전환 동의 후 다음 월요일에 생성되는 새 프로그램부터 적용된다. V2 변경 요약에
**"스트렝스 기본 복합운동이 5세트에서 3세트로 조정되고, 선택한 시간 안에 끝나도록 운동 수가 달라질 수 있음"**
을 명시한다 — V2-MIGRATE-01의 고지·동의 대상이다.

- 세션 총 작업세트의 보편적 의학 상한은 좋은 근거가 없다. 그래도 **cap과 시간 예산은 둘 다 hard
  constraint이고, 더 엄격한 쪽이 구속한다.**

  > **정정(2026-08-23, V2-PLAN-01 실측).** 이전 판은 *"실제 생성은 …계산해 **cap보다 먼저** 잘려야
  > 한다"* 고 적었다. **폐기한다** — 잠긴 시간 상수(§4.4)로 전 조합을 돌려 보면 **binding 제약이
  > 목표·시간대마다 갈린다.**
  >
  > | 조합 | 세트/cap | 추정/예산 | binding |
  > |---|---|---|---|
  > | `strength` 30분 | 6/8 | 28.5/30분 | **시간** (cap 여유 2) |
  > | `strength` 45분 | 11/12 | 42.2/45분 | **시간** |
  > | `diet` 90분 | 24/24 | 66.7/90분 | **cap** (시간 여유 23분) |
  > | `hypertrophy` 75분 | 20/20 | 64.0/75분 | **cap** (시간 여유 11분) |
  > | `diet` 30분 | 8/8 | 29.9/30분 | **둘 다** |
  >
  > 짧은 시간대는 시간이, 긴 시간대는 cap이 먼저 문다. **어느 한쪽이 항상 먼저인 것이 아니므로
  > 생성기는 두 제약을 모두 만족시켜야 하고 cap을 "2차 안전망"으로 낮춰 부르지 않는다.**
  > 30분 cap은 **8을 유지**한다(9로 올리지 않는다).
- 시간 옵션 `[30, 45, 60, 75, 90]`은 현행 `docs/specs/openapi.yaml:897` enum과 일치한다.
- **근거도 승인된 제품정책도 없는 필수 칸은 빈칸으로 두고, 그 조합을 출시에서 제외한다.**
  P3로 미룰 수 있는 것은 분석용 필드뿐이다.

### 2.5 근거

| 출처 | 이 계약에서 지지하는 것 |
|---|---|
| [WHO 신체활동 가이드라인](https://www.who.int/publications/i/item/9789240015128) | 참조값으로만 표시. 사용자 시간보다 강제하지 않음 |
| [ACSM 2026 저항운동 position stand](https://pubmed.ncbi.nlm.nih.gov/41843416/) | 운동당 2~3세트, 세션 앞 우선 배치, 주 2회 이상 |
| [2026 dose-response meta-regression](https://pubmed.ncbi.nlm.nih.gov/41343037/) | 볼륨 증가의 diminishing returns, direct/indirect set 구분 |
| [concurrent training meta-analysis](https://pubmed.ncbi.nlm.nih.gov/34757594/) | 유산소+저항이 최대근력·근비대를 유의하게 해치지 않음. 폭발력만 same-session 불리 |
| [ACSM 2024 체중관리 consensus](https://pubmed.ncbi.nlm.nih.gov/39277776/) | `diet` 카피를 "감량 지원"으로 제한하는 근거 |

**48시간 HIIT 간격은 위 concurrent 메타분석이 정한 값이 아니다.** 3시간 이상 분리 시 해당 moderator가
유의하지 않았다. 48시간은 버전 관리되는 보수적 제품 가드레일로만 표기한다.

### 2.6 "versioned product policy"를 무엇이 운반하는가

ADR-71이 "버전 관리되는 제품정책"이라고 말할 때, 그 버전을 실제로 저장·전송하는 필드를 여기서 고정한다.
이것이 없으면 정책이 바뀐 뒤 과거 프로그램을 재현할 수 없다.

- **S/C/H composition, set envelope·cap, time-estimator 상수, 그리고 추천 엔진 출력 계약은 하나의
  `Program.rules_version` rules bundle에 묶인다.** 엔진 버전과 프로그램 버전을 **서로 다른 의미의 상수로
  분리하지 않는다.**
- 최초 예약 V2 의미는 **`2026.09.0`** 으로 보존한다. ADR-73의 개편 composition+split을 포함한 전체 기능개선 최종 활성화 대상은 **`2026.09.1`** 이다. 활성 포인터는 그 전까지 `2026.08.1`이며 중간 V1에 `.09.1`을 표기하지 않는다.
- 같은 생성 결과의 `PlannedSet.rules_version`과 추천 엔진 출력도 같은 bundle 값을 쓴다.
- composition·cap·estimator·엔진 출력 의미 중 **하나라도 바뀌면 bundle version을 올린다.**
- 기존 persisted `2026.08.1` 행은 **backfill하지 않는다.** 그 행의 값은 그 버전의 규칙으로 해석한다.

#### 활성화는 원자적이다 — ENGINE-01에서 승격하지 않는다

`rules_version`은 세부 알고리즘별 버전이 아니라 **"이 계획세트·추천이 어느 규칙 묶음에서 나왔는가"** 를
가리키는 단일 bundle 버전이다. 그래서 **엔진만 V2로 바뀐 중간 상태에 `2026.09.0`을 찍으면 거짓말이 된다** —
그 버전은 PLAN B+C·S/C/H·packer까지 포함한다고 선언했는데 실제로는 엔진만 바뀐 결과이기 때문이다.

- **V2-ENGINE-01은 활성 `ROUTINE_RULES_VERSION`을 `2026.08.1`로 유지한다.**
- 엔진은 **입력 `rules_version`으로 V1/V2 동작을 결정적으로 분기**한다.
  `2026.08.1` 입력은 기존 `BASELINE + weight 0` 의미를 보존하고, `2026.09.0` 입력만
  `LOAD_CALIBRATION_NEEDED + weight null` 계약을 쓴다.
- 분기는 **문자열 범위·대소 비교가 아니라 지원 버전 equality 또는 helper로** 한다.
  `version >= "2026.09.0"` 같은 비교는 쓰지 않는다 — 문자열 정렬이 버전 의미를 보장하지 않는다.
- **예약 bundle 상수 + 활성 포인터** 구조는 허용한다(`2026.09.0` 상수를 미리 두고 활성 상수만 나중에 가리키게).
- PLAN B+C·S/C/H·role/time packer까지 구현·검증된 **activation ticket에서 활성 상수를 한 번만 전환**한다.
- **그 전환 이전의 중간 상태는 공개·배포하지 않는다.**

**구현 티켓: V2-PLAN-01 / V2-PLAN-02.**

---

## 3. 강도·피드백 척도

### 3.1 RPE = `relative_effort_0_10_v1`

| 값 | 앵커 |
|---|---|
| 0 | 휴식 |
| 1~4 | 가벼움 |
| 5~6 | 중강도 — 대화 가능, 노래는 어려움 |
| 7~8 | 고강도 — 몇 단어 뒤 호흡이 필요 |
| 9~10 | 거의 최대 ~ 최대 |

- UI에 숫자만 두지 않고 **talk-test 문구를 함께** 표시한다.
- **scale id와 version을 계약에 잠근다.** modified Borg CR10(중강도 3~4)과 미국 가이드 10점 척도(중강도 5~6)는
  같은 "0~10"인데 숫자가 다르다. id 없이 "RPE 0~10"만 쓰면 계약이 성립하지 않는다.
- 근거: [CDC 비임상 상대강도 척도](https://www.cdc.gov/physical-activity-basics/measuring/index.html)
- **인용 정정:** Bok et al.([PMID 35507232](https://link.springer.com/article/10.1007/s40279-022-01690-3))은
  6~20 Borg를 쓴다(VT RPE 10~11, RCT 13~15). 0~10 채택의 직접 근거가 아니므로 이 용도로 인용하지 않는다.

#### scale id는 암묵 상수가 아니라 저장 필드다

척도가 바뀐 뒤 과거 RPE 기록을 재현하려면 어떤 척도로 입력됐는지가 데이터에 남아야 한다.

- cardio planned prescription에 **nullable `rpe_scale_id`** 를 추가한다. 값은 `relative_effort_0_10_v1`.
- `target_rpe_low/high` 또는 cardio `actual_rpe`를 쓰는 planned set은 **`rpe_scale_id`가 non-null이어야 한다.**
- `PerformedSet.actual_rpe`는 **연결된 PlannedSet의 `rpe_scale_id`로 해석한다.**
  performed·outbox payload에 scale id를 중복 전송하지 않는다.
- 서버는 `actual_rpe`가 있는데 linked planned set의 scale id가 없으면 **validation error로 거부한다.**
- 이 필드의 Prisma·OpenAPI·shared·outbox 구현은 **V2-CARDIO-01에서** 한다. 지금은 계약만 잠근다.

### 3.2 피드백 필드 — 신규 척도를 만들지 않고 기존 것을 정리한다

| 필드 | 결정 | 근거 |
|---|---|---|
| `pain` | 0~10 유지 | 안전 임계 계약(통증 4). 건드리지 않는다 |
| `RIR` | 0~6 / `null` 유지 | ADR-39 · ADR-55 |
| cardio `actual_rpe` | `relative_effort_0_10_v1` **신규** | 유산소 강도 축이 없다 |
| `difficulty` | **1~5로 바꾸지 않고** 현행 `easy\|moderate\|hard` wire 필드를 그대로 유지 | `openapi.yaml:350`·`:1352`에 이미 존재 |
| `pre_session_readiness` | **1~5 대신 `low\|normal\|high`** | HIIT fallback에 필요한 건 `low` 하나. 결정론적 규칙으로 고정 |
| `post_session_fatigue` | **V2에서 제거(defer)** | `difficulty`·RPE와 중복이고 실행 수식이 없다. 사용 규칙·보존·암호화 계획이 생기면 P3 후보 |
| `pump` | V1 요청 호환으로 optional accept, V2 UI·추천 신호에서 deprecated | `openapi.yaml:351` |

결과: **신규 숫자 척도는 cardio effort 1개뿐**이고, `difficulty`·`readiness`는 설명이 붙은 3분류다.
최종계획 §2.5의 "difficulty 1~5 / post_session_fatigue 1~5 / pre_session_readiness 1~5"를 이 표가 대체한다.

> **`session_difficulty`는 개념명이지 wire rename이 아니다.** direct complete와 sync payload 모두 기존
> `difficulty: easy|moderate|hard`를 유지한다. **DB·API migration 없음.** 코드 내부 alias가 필요하더라도
> wire 필드명은 바꾸지 않는다. `pump`도 V1 optional accept·deprecated 정책을 그대로 유지한다.

`readiness`는 여전히 건강 관련 데이터이므로 PIPA 사람 검토 대상이다(`docs/SECURITY_PIPA.md`).
`post_session_fatigue` 제거로 검토 범위가 줄어든다.

**구현 티켓: V2-FEEDBACK-01 / V2-CARDIO-01.**

---

## 4. 착수 순서

1. 이 문서 + ADR-70~72 반영 — **코드 변경 없음** ✅
2. **V2-ENGINE-01** — `2026.09.0` **버전 경로**의 골든 red 선행. 활성 상수는 `2026.08.1`로 유지한다(§2.6)
3. **V2-ENGINE-02 — RIR 보수 경로 계약 고정** (§4.2). **엔진 수식을 바꾸지 않는다**
4. **V2-REASON-01** — emit되지 않는 reason code(`RIR_ON_TARGET_HOLD` 등) union·예약 정리 (별도 티켓)
5. 이후 최종계획 P0 로드맵 순서
6. **activation ticket** — PLAN B+C·S/C/H·packer 완료 후 활성 상수를 `2026.09.0`으로 **한 번만** 전환

각 티켓 후 `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && pnpm test`.

### 4.1 V2-ENGINE-01 잠긴 계약 (착수 전 확정, 2026-08-23 재리뷰 반영)

**엔진은 입력 `rules_version`으로 V1/V2를 분기한다.** ENGINE-01은 두 계약을 **병행 지원**하고,
활성 `ROUTINE_RULES_VERSION`은 `2026.08.1`에 그대로 둔다(§2.6 "활성화는 원자적이다").

| 입력 `rules_version` | external + 이력 없음 | 성격 |
|---|---|---|
| `2026.08.1` (V1, 현재 활성) | `weight: 0` + `BASELINE` — **의미 보존** | 기존 동작. 회귀 대상 |
| `2026.09.0` (V2, 예약) | `weight: null` + `LOAD_CALIBRATION_NEEDED` | 신규. 골든 red가 검증 |

분기는 **지원 버전 equality 또는 helper**로 한다. `version >= "2026.09.0"` 같은 문자열 범위 비교는 쓰지 않는다 —
문자열 정렬은 버전 의미를 보장하지 않는다(`"2026.10.0" < "2026.9.0"`).

**지원하지 않는 버전 문자열(오타·구버전·미래 버전)은 fail closed — 계산 전에 throw 한다.**
`rules_version`은 사용자 입력이 아니라 **내부 상수에서만** 온다(api `RULES_VERSION`, 오프라인 미러
`ROUTINE_RULES_VERSION`). 모르는 값이 들어왔다면 배포 오류이고, 조용히 V1로 떨어뜨리면 **결과에 잘못된
provenance가 박힌 채 저장된다** — 나중에 그 행을 어느 규칙으로 해석해야 하는지 알 수 없게 된다.
지원하지 않는 입력에 대해서는 `Recommendation`·출력·영속 행을 **만들지 않는다.**

- `resolveRulesBundle(version)`이 지원 bundle을 반환하거나 `RangeError`를 던진다.
- 판정은 진입점 **한 곳**에서 한다 — 경로별로 갈라지면 시간 종목만 통과하는 구멍이 생긴다.
- 외부 telemetry는 이 순수 함수 티켓의 범위 밖이다(호출자 입력이 내부 상수뿐이라 불필요).

**`2026.09.0` 경로 출력**

| 입력 상황 | `weight` | `reps_low/high` | `load_kind` | `recommendation_state` | `reason_code` | `confidence` |
|---|---|---|---|---|---|---|
| external + 이력 없음 | `null` | **target 범위 반환** | `external` | `load_calibration_needed` | `LOAD_CALIBRATION_NEEDED` | **exact `0`** |
| bodyweight + 이력 없음 | `null` | target 범위 | `bodyweight` | `ready` | `BASELINE` | 기존 baseline 정책 |
| time + 이력 없음 | `null` | — (time 축) | `not_applicable` | `ready` | `BASELINE` | 기존 baseline 정책 |
| 통증(`pain_score >= 4`) | 기존 그대로 | 기존 그대로 | 항상 존재 | **`substitution_required`** | `SUBSTITUTE_PAIN` | 기존 그대로 |
| 잘못된 입력 | 기존 그대로 | 기존 그대로 | 항상 존재 | **`unavailable`** | `INVALID_INPUT` | 기존 그대로 |
| 그 외(진행) | 기존 그대로 | 기존 그대로 | 항상 존재 | `ready` | 기존 그대로 | 기존 그대로 |

- `confidence: 0`은 "값 없음"이 아니라 **명시적 zero confidence**다. external load 추정이 전혀 없다는 뜻이고,
  `0.3` 같은 값은 검증되지 않은 거짓 정밀도라 쓰지 않는다. wire의 `confidence: null`(§1.1, 비공개)과 다르다.
  음수 불가 invariant를 타입·테스트로 유지한다.
- `recommendation_state`는 **모든 경로에서 항상 존재**한다. 4값 정의·파생 우선순위·V1 정규화는 §1.2.

**`load_kind`는 새 입력이 아니라 파생값이다.** `metric`·`step_kg` canonical metadata에서 shared pure helper로
한 번만 파생하고 엔진 출력에만 싣는다. 입력 스키마·`Exercise`·DB 컬럼에 **추가하지 않는다.**

```text
metric === "time"   → not_applicable
step_kg === null    → bodyweight
그 외               → external        (step_kg <= 0 의 기존 INVALID_INPUT 검증은 별도 유지)
```

이 helper는 **현행 resistance/time 엔진용으로 한정**한다. V2 modality·`prescription_kind`가 들어오는 후속
티켓에서는 그 계약이 상위 canonical discriminator가 된다.

**나머지 확정 사항**

- **활성 `ROUTINE_RULES_VERSION`은 `2026.08.1`을 유지한다.** `2026.09.0`은 예약 상수로만 도입하고
  활성 포인터는 activation ticket에서 한 번에 전환한다(§2.6). 엔진·프로그램 버전을 별도 상수로 쪼개지 않는다.
  persisted V1 행은 `2026.08.1` 그대로 보존하고 backfill하지 않는다.
- **골든은 두 버전 경로를 모두 검증한다.** `2026.08.1` 입력의 V1 `BASELINE + 0` 보존과
  `2026.09.0` 입력의 V2 `null + LOAD_CALIBRATION_NEEDED`를 각각 고정한다.
  **GC-15는 id를 유지하고 V2 경로 기대값으로 교체**하되, V1 경로를 밟는 케이스를 함께 둔다 —
  이게 없으면 V1 분기가 지워져도 골든이 통과한다. bodyweight no-history · time no-history 골든을 **신규 추가**해
  `BASELINE + ready`를 고정하고, 각 케이스에 `load_kind`·`recommendation_state`·confidence 기대를 넣는다.
- **`SIMILAR_INIT`을 runtime union `REASON_CODES`에서 제거한다.** 실행 경로가 없는 코드를 union에 남기면
  모든 소비자가 가능 응답으로 처리해야 하므로 "예약"이 아니다. 필요하면 docs 또는 별도
  `RESERVED_REASON_CODES`에만 둔다. **이번 티켓과 맞닿은 `SIMILAR_INIT`만** 정리하고 다른 예약 코드의
  대량 정리는 별도 티켓으로 남긴다.
- **UI의 `0 → unknown_weight` 방어는 모든 `reason_code`에 대해 유지한다.**
  회귀 고정: V1 `BASELINE + weight 0`은 계속 "무게 미정"이고 `0kg` 프리필이 없다.
  V2 `LOAD_CALIBRATION_NEEDED + weight null`도 "무게 미정"이다.

  > **폐기된 요구: `recommended_weight === 0 && reason_code === "BASELINE"` 좁히기 (2026-08-23).**
  > 초기 계약은 이렇게 좁혀 "새 reason인데 weight 0"인 잘못된 V2 결과를 드러내려 했다.
  > 구현 중 실측으로 **폐기**했다. 두 가지가 이를 무너뜨린다.
  >
  > 1. **기존 안전 계약과 충돌한다.** `apps/web/test/session-set-rules.test.ts`가 *"reason_code가 무엇이든
  >    0은 절대 0kg으로 그리지 않는다"* 를 이미 고정하고 있다(AC-E-1). 좁히면 이 테스트가 깨지고,
  >    통과시키려면 테스트를 약화시켜야 한다 — 금지 사항이다.
  > 2. **0은 V1 baseline sentinel 전용이 아니다.** `stepDown`의 바닥이 0이라 마지막 무게가 1스텝 이하이면
  >    **V1·V2 공통으로** 통증·`TOO_HARD` 감량 경로도 0에 닿는다(실측: `step_kg 2.5`, 마지막 2.5kg → 0).
  >    좁히면 그 결과가 `weighted`로 떨어져 **사용자에게 "0kg"이 뜨고 0이 기록값으로 프리필된다.**
  >
  > **대체 결정**: 넓은 UI 방어(모든 0 → `unknown_weight`)를 유지하고, 잘못된 결과는 **엔진 불변식**이
  > 원천에서 잡는다 — `LOAD_CALIBRATION_NEEDED ⇒ weight null`, `load_calibration_needed ⇒ load_kind external`
  > (`packages/shared/test/recommend.test.ts`). 계층이 맞다: 렌더러는 안전을, 엔진은 정확성을 책임진다.
**V2-ENGINE-01 구현 경계 — AC로 잠근다**

1. **`routine-plan.test.ts`의 기대 동작은 바꾸지 않는다.** provisional은 활성 버전(`2026.08.1`) 경로를 타므로
   `BASELINE + 0`이 유지된다. 이 테스트가 바뀌어야 한다면 활성 상수를 잘못 건드린 것이다.
2. **그러나 `recommend.ts`의 모든 return path는 갱신해야 한다.** shared `Recommendation`에
   `load_kind`·`recommendation_state`가 required로 들어가므로 안전·invalid·baseline·진행·time 경로가 전부
   두 필드를 채워야 한다. 골든 `expect`의 타입과 known-key 목록도 함께 갱신한다.
   **"V1 경로는 안 건드린다"가 "V1 경로 코드를 안 고친다"는 뜻이 아니다** — 값의 의미는 보존하되 shape는 바뀐다.
3. **골든 harness를 dual-version으로 바꿔야 한다.** 현행 `golden_tests.json`은 root에 `rules_version` 하나를
   주입하는 구조라 한 버전만 실행된다. **case-level `rules_version` override 또는 동등한 dual-version harness**로
   바꿔 V1·V2 external no-history를 **둘 다 실행**한다. 이게 없으면 §4.1의 병행 지원 계약이 검증되지 않는다.

- **오프라인 provisional** — `packages/shared/src/routine-plan.ts`는 활성 bundle 버전을 엔진에 넘기므로
  ENGINE-01 시점에는 계속 `2026.08.1` 경로를 타 **`BASELINE`을 만든다.** external provisional이
  `null + LOAD_CALIBRATION_NEEDED`로 바뀌는 것은 **activation ticket에서다.** bodyweight·time provisional은
  양쪽 버전 모두 `BASELINE`이다. 서버 authoritative mapping 도착 시 state·reason이 덮어써지는 기존 원자성은
  두 버전 모두에서 회귀 대상이다.
- **ENGINE-01에서는 DB 스키마를 바꾸지 않는다.** 기존 V1 데이터도 그대로 두고 reader·test 호환으로 처리한다.
  `recommendation_state`·`load_kind`는 이 티켓에서 **shared engine 반환 타입에만** 추가하고
  OpenAPI 응답·DB 컬럼에는 넣지 않는다.
  wire 노출은 §1.1~§1.3에 따라 **V2-GATE-01**에서 하며, 그 시점에도 `recommendation_state`는
  **nullable 컬럼 추가 또는 응답 시 파생** 중 하나를 고르고 **기존 행 일괄 backfill은 하지 않는다**(§1.2).
  즉 "DB migration 없음"은 ENGINE-01 한정 서술이지 V2 전체에 대한 약속이 아니다.

### 4.2 V2-ENGINE-02 — RIR 보수 경로 계약 고정 (2026-08-23 합의)

**엔진 수식을 바꾸지 않는다.** 인벤토리 실측 결과 현행 엔진이 이미 이 계약을 만족한다
(`artifacts/v2-engine-02-inventory`). 이 티켓은 그 동작을 **characterization test 로 못박아**
나중에 조용히 무너지지 않게 하는 것이다. 그래서 **신규 테스트는 처음부터 green 이어야 정상**이고,
실효성은 인위적 red 가 아니라 **mutation red** 로 증명한다.

#### 사용자 관점 계약

| 상황 | 동작 |
|---|---|
| **uncalibrated** + 높은 RIR(쉬움)만 있음 | **증량하지 않는다** |
| `hitTop`(모든 세트가 목표 반복 상단 도달) | 증량한다 — 근거는 **RIR 이 아니라 reps 성과**다 |
| 낮은 RIR / `RIR 0` | **uncalibrated 에서도** 유지·감량한다(보수적 방향은 항상 허용) |
| **calibrated**(튜토리얼 `graduated`) | corrected RIR 기반 **양방향** 조정 |

#### 결정표 — 전부 현행 동작이다

`C` = `calibration` 있음, `hitTop` = 모든 세트 `reps >= reps_high`

| # | C | hitTop | RIR 신호 | 결정 | reason | 판정 지점 (`recommend.ts` 심볼) |
|---|---|---|---|---|---|---|
| 1 | ✅ | — | 전부 `corrected >= target+1` | 증량 1스텝 | `RIR_TOO_EASY_INCREASE` | `calibration !== undefined && hasAllRir` → `corrected.every(...)` |
| 2 | ✅ | — | 하나라도 `corrected <= target-1` | 감량/유지 | `RIR_TOO_HARD_REDUCE` | 같은 가드 → `corrected.some(...)` |
| 3 | ✅ | ✅ | on-target | 증량(reps 근거) | `WEIGHT_UP_REP_TARGET_MET` | RIR 가드 통과 후 `hitTop && !tooHard` |
| 4 | ❌ | ✅ | 높음(쉬움) | **증량하되 근거는 reps** | `WEIGHT_UP_REP_TARGET_MET` | `hitTop && !tooHard` |
| 5 | ❌ | ❌ | 높음(쉬움) | **증량 금지**, 반복 +1 | `ADD_ONE_REP` | 마지막 fallback(`floorToStep` 유지) |
| 6 | ❌ | — | `rir < target-1` | 유지 | `HOLD_RIR_LOW` | `rirBelowTarget` → `tooHard`, `!repsBelowLow` |
| 7 | ❌ | — | `rir == 0` && `reps < low` | 1스텝 감량 | `TOO_HARD` | `shouldDrop` → `stepDown` |

> 줄번호 대신 **조건·심볼 이름**으로 가리킨다. 줄번호는 무관한 편집에도 어긋나 계약 문서를 조용히 거짓말하게 만든다.

**4행과 5행의 구분이 계약의 핵심이다.** 4행은 "uncalibrated RIR 이 쉽다고 말해서" 올리는 것이 아니라
**"목표 반복을 다 채워서"** 올린다. 5행이 "uncalibrated RIR 만으로는 못 올린다"를 실증한다.

#### 적용 범위

- **두 bundle 모두 동일**하다. RIR 로직에 `2026.08.1` / `2026.09.0` 분기를 **새로 만들지 않는다.**
- `GC-22` 는 `calibration.rir_bias` **측정값** 을 적용하는 산술 계약이므로 그대로 존치한다
  (경험 prior 금지와 무관 — 입력으로 주어진 값이고 `experience_level` 파생 경로는 코드에 없다).
- 통증·`INVALID_INPUT` 은 RIR 판정보다 앞이고, 맨몸·시간 종목은 부하 축이 없어 이 표의 대상이 아니다.

#### 이번 티켓에서 하지 않는 것

- **reason union 을 건드리지 않는다.** `RIR_ON_TARGET_HOLD` 는 emit 되지 않는 죽은 코드지만
  정리는 **V2-REASON-01** 소유다. 다만 `GC-21` 의 `reason_code_in` 이 그 사실을 **가려 주고 있으므로**
  실제 반환값 `ADD_ONE_REP` 로 좁힌다(골든의 가림막만 걷어내고 union 은 그대로).
  → **완료: V2-REASON-01 이 `RIR_ON_TARGET_HOLD` 를 완전히 제거했다**(§4.3).
- **RIR 튜토리얼 상태 전환을 구현하지 않는다.** `V2-RIR-01` 소유이고 V2 공개 전 완료 게이트다
  (`docs/RIR_TUTORIAL.md` 참조).
- DB migration·OpenAPI 변경 없음. 기존 `graduated` 행은 **유효한 측정 calibration 으로 계속 해석한다.**

### 4.3 V2-REASON-01 — reason code 어휘 정리 (2026-08-23 완료)

**runtime `ReasonCode` 는 지금 실제로 반환될 수 있는 값만 담는다.** 실행 경로 없는 코드를 union 에 남기면
모든 소비자가 "가능한 응답"으로 처리해야 하므로 예약이 아니라 부채다.

#### 최종 어휘

**runtime `REASON_CODES` (16종)** — `packages/shared/test/reason-codes.test.ts` 가
"union == 실제 emit 집합"을 **exact** 로 강제한다. 여기에 추가하려면 emit 경로와 테스트를 함께 만들어야 한다.

```text
WEIGHT_UP_REP_TARGET_MET  ADD_ONE_REP  HOLD_RIR_LOW  TOO_HARD
LOAD_CALIBRATION_NEEDED   BASELINE     INVALID_INPUT SUBSTITUTE_PAIN
RIR_TOO_EASY_INCREASE     RIR_TOO_HARD_REDUCE
REPS_UP_BODYWEIGHT        PROGRESSION_CAP_BODYWEIGHT  SUBSTITUTE_TOO_HARD_BODYWEIGHT
TIME_UP  TIME_HOLD  TIME_DOWN
```

**`RESERVED_REASON_CODES` (정확히 4종)** — runtime 과 **disjoint** 하며 사용자 설명 map·실제 응답
어디에도 넣지 않는다. 되살릴 때는 **입력·emit 경로·테스트와 함께 원자적으로** 승격한다.

| 예약 코드 | 막고 있는 것 | 소유 |
|---|---|---|
| `SIMILAR_INIT` — SIM-01/02로 이동 | SIM-01에서 입력·계산식·골든 계약 동결, SIM-02에서 runtime 승격(위 16/4종은 V2-REASON-01 완료 시점) | `SIM-01` / `SIM-02` |
| `VOLUME_SPIKE_CAP` | 엔진 입력 채널 + **오프라인 미러 대책**(집계 `muscle_weekly_load` 는 이미 있음) | `V2-PLAN-02` |
| `DELOAD_SUGGESTED` | 다세션 추세·피로 입력 | P3 회복 주간 |
| `CALIBRATION_STALE` | **stale 정책 사람 승인** | 승인 후 별도 티켓 |

#### 제거된 것 — 예약도 아니다

- **`RIR_ON_TARGET_HOLD` 완전 제거.** on-target 은 별도 reason 없이 더블 프로그레션으로 넘긴다는 것이
  설계이므로 되살릴 계획 자체가 없다. 예약에 두면 "언젠가 되살린다"는 잘못된 신호를 준다.
  계약은 `GC-21`(calibrated + on-target → exact `ADD_ONE_REP`)이 고정한다.
- **`CALIBRATION_NEEDED` · `CALIBRATION_GRADUATED` 는 추천 근거가 아니라 튜토리얼 상태다.**
  `CalibrationStatus`(`not_started|in_progress|graduated|stale`) DB enum 이 **이미 같은 의미를 담고 있어**
  새 vocabulary 를 만들지 않는다. UI 문구가 필요해도 status 기반으로 설계한다(소유: `V2-RIR-01`).

#### persisted 호환 — 제거해도 깨지지 않는다

| 층 | 근거 |
|---|---|
| DB | `PlannedSet.reasonCode` 는 `String`(enum 아님) → **migration 불필요** |
| OpenAPI | `reason_code: { type: string }` — enum 없음 → **스펙 변경 불필요** |
| API `explanation` | persisted 경로에 **이미 fallback 이 있다** — 제거된 코드는 일반 문구로 저하 |
| Web 근거 배지 | 목록 밖 코드는 `null` → 근거 영역 숨김(AC-E-6). **영문 코드 노출 없음** |
| PWA mirror | 문자열 그대로 저장·전달 |

"애플리케이션이 emit 한 적이 없다"와 "행이 없다"는 다르므로, 수동·과거 환경 행 가능성을 배제하지 않고
**제거된 6종을 직접 밟는 회귀 테스트**를 api·web 양쪽에 둔다(일반 unknown 테스트로 대신하지 않는다).

**active V1 동작 변화 없음** — 6종은 `2026.08.1` 에서도 emit 되지 않았다.

### 4.4 V2-PLAN-01 — 역할·시간 기반 저항운동 packer (2026-08-23 합의)

**`EXERCISE_COUNT` 고정 상수표를 V2 경로에서 폐기하고** role 우선 + 시간 추정 packer로 대체한다.
legacy(`2026.08.1`) 경로는 상수표와 strength 5세트를 **그대로 보존**한다.

#### 시간 상수 — 전부 단일값이다 (범위 금지)

범위로 두면 같은 입력이 다른 계획을 낼 수 있어 "같은 입력·같은 `rules_version`은 같은 계획" 불변식이 깨진다.

| 상수 | 값 |
|---|---|
| 워밍업 | **480초** (8분) |
| 쿨다운 예약 | **300초** (5분). PLAN-02 mobility/cooldown이 쓴다. 생략되면 실제 소요만 짧아진다 |
| 운동 전환 | **90초 × (운동 수 − 1)** |
| 세트 간 휴식 | 운동마다 **(sets − 1) × rest_sec**. 마지막 세트 뒤는 세지 않고 전환만 센다 |
| 세트 수행(reps) | **clamp(target_reps_high × 4초, 20, 90)** |
| 세트 수행(time) | **target_time_high_sec** |
| unilateral | **수행 시간만 ×2** (휴식·전환은 그대로) |
| 추가 고정 블록 | `additional_fixed_block_sec` — 단순 입력. **cardio 전용 분기를 만들지 않는다** |

`estimateSessionSeconds`는 **순수·결정론적**이며, 이 함수의 계약은 "추정치가 상한을 넘지 않음"이다.
실제 소요와의 오차는 KPI이지 이 함수의 계약이 아니다.

#### role — 세션 문맥 in-memory 값 (저장하지 않는다)

focus별 pattern 목록과 기존 comparator 순서를 **그대로 승계**한 뒤 파생한다.

```text
core      = movement_pattern === "core"
primary   = 첫 feasible non-core 후보
            (기존 mechanicFirst 때문에 사실상 compound 가 먼저 오지만,
             통증·장비 필터 뒤 compound 가 하나도 없으면 isolation primary 를 허용한다)
secondary = 나머지 compound
accessory = 나머지 isolation
```

> **`primary는 항상 compound`를 절대 property로 두지 않는다.** 통증·장비 safety fallback이 우선하므로
> compound가 전부 걸러진 세션이 정상적으로 존재할 수 있다.

- **추가 순서**: `primary → secondary → core → accessory`
- **제거 순서**: `accessory → core → secondary → primary` (추가 순서의 역순)
- **`accessory`가 남은 채 `primary`가 제거되는 결과를 금지한다.**
- **feasible한 primary가 하나라도 있으면 반드시 보존한다.**
- `core`를 accessory보다 **뒤에** 제거한다 — `metric=time` 코어는 `mechanic=isolation`이라 accessory로
  묶으면 코어가 항상 먼저 잘린다.

#### 세트

- V2 기본은 **모든 운동 3세트**다(B 결정으로 strength compound가 5 → 3이 되면서 전 종목이 3으로 수렴).
- 시간·cap이 모자라면 **모든 role이 2세트까지** 줄인다(envelope 하한 2). **primary도 3 → 2를 시도한다.**
  primary만 하한을 못 쓰면 **줄일 수 있는 비-primary가 살아남고 줄일 수 없는 primary가 탈락**해,
  보호하려던 것이 오히려 먼저 죽는다.
- **primary가 2세트로도 시간·cap에 들어가지 않으면 세션이 성립하지 않는다** — `packSession`은
  **빈 결과를 반환**한다. **accessory-only 세션을 만들지 않는다.**
  이 경로에 새 wire·state(`coverage_shortfall` 등)를 만들지 않는다.
- **4·5세트는 PLAN-01에서 구현하지 않는다.** tolerance 판정 데이터가 생성 경로에 없고
  (`historyFor`는 최근 1세션만 준다), 프로그램 생성은 주 1회인데 tolerance는 세션마다 변한다.
  소유: PLAN-02 이후 progression/volume 티켓.

#### 저장·wire — 이번 티켓은 0

`role`·예상 소요를 **공개하지도 저장하지도 않는다.** Prisma·OpenAPI·sync·outbox migration **0**.
working set 수는 planned set 행을 세어 얻는다.
세션 편집 후 시간 재검증은 **V2-SESSION-EDIT-01**, 공개 role/duration/modality wire는 후속 migration 티켓.

#### 통합 지점

- **session-level pure packer를 상위에 둔다.** `plannedSets.build`는 현행 "운동 1개 → 행들"을 유지한다.
- 호출자 6곳 중 **생성 2곳에만** V2 분기를 넣는다. 세션 편집 3곳·sync 1곳은 **건드리지 않는다.**
- activation 전에는 production에서 V2 프로그램이 생성되지 않는다(활성 상수가 `2026.08.1`).

#### 지원 범위

PLAN-01은 **`diet`·`hypertrophy`·`strength` 3목표의 저항운동만** 다룬다.
`general_fitness`·`endurance`와 S/C/H composition·cardio는 **PLAN-02** 소유다.
