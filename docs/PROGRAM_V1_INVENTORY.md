# PROGRAM_V1_INVENTORY — 현행 프로그램 생성 규칙 실측 (ADR-71 분업 1단계)

작성 2026-08-23 · **사실 추출 문서다. 이 문서의 값은 근거가 아니라 "현재 코드가 하는 일"이다.**
ADR-71 분업의 **1단계 산출물**이다. 2단계(문헌 envelope)·3단계(smallest-diff mapping)는 완료됐고 결과는 `docs/PROGRAM_V2_CONTRACT.md` §2와 이 문서 §5-D·§8에 있다.

## 0. 한 줄 요약

현행 생성기는 **저항운동 전용**이고, `experience_level`은 **종목 난이도 필터에만** 쓰이며 세트·반복·휴식에는
전혀 영향을 주지 않는다. 그리고 **현행 strength 프로그램은 V2 세션 세트 cap을 모든 시간 옵션에서 초과한다**(§5. §5-D의 B+C로 해소됨).

## 1. 요일·분할 배치

`apps/api/src/programs/program-rules.ts:54-99` — 코드 주석이 **"해석: 문서에 표가 없다"** 라고 명시한다.

| days | 요일 | focus | split_type |
|---|---|---|---|
| 2 | MON, THU | full_body ×2 | `full_body` |
| 3 | MON, WED, FRI | full_body ×3 | `full_body` |
| 4 | MON, TUE, THU, FRI | upper, lower, upper, lower | `upper_lower` |
| 5 | MON, TUE, WED, FRI, SAT | upper, lower, upper, lower, upper | `upper_lower` |
| 6 | MON~SAT | push, pull, legs ×2 | `push_pull_legs` |

- **목표(`goal`)가 배치에 전혀 반영되지 않는다.** diet·hypertrophy·strength가 같은 요일·같은 focus를 받는다.
- 일요일은 어떤 분할에서도 운동일이 아니고 월요일은 어떤 분할에서도 휴식일이 아니다(ADR-50이 지적한 구조적 공백).

## 2. 시간 → 운동 개수

`program-rules.ts:105` — 역시 **"해석: 문서에 표가 없다"**. 운동 1개당 약 12~13분으로 잡았다는 주석.

| minutes_per_day | 30 | 45 | 60 | 75 | 90 |
|---|---|---|---|---|---|
| 운동 개수 | 3 | 4 | 5 | 6 | 7 |

`openapi.yaml:897`의 `minutes_per_day` enum과 1:1 대응한다. **예상시간을 계산하지 않는다** — 개수를 상수표에서 뽑을 뿐이라
워밍업·휴식·전환 시간이 실제로 그 시간 안에 들어가는지 검증하는 코드가 없다.

## 3. 목표별 파라미터

`packages/shared/src/routine-plan.ts:6-28`. 반복·휴식은 문서 근거가 있고, 세트 수는 해석이다.

| goal | compound reps | isolation reps | target RIR | rest(초) | compound 세트 | isolation 세트 |
|---|---|---|---|---|---|---|
| `hypertrophy` | 6–12 | 10–20 | 2 | 120 | 3 | 3 |
| `strength` | 3–5 | 3–5 | 3 | 180 | **5** | 3 |
| `diet` | 6–12 | 6–12 | 3 | 90 | 3 | 3 |

- 반복 표 근거: `docs/RECOMMENDATION_ENGINE.md` "목표별 파라미터"(`program-rules.ts:244`).
- 휴식 근거: `docs/FEATURES_UX.md` F2(`program-rules.ts:257`).
- **세트 수는 근거 없음** — `program-rules.ts:263` 주석이 "해석: 문서에 표가 없다"라고 적고, MEV≈10 언급만 있다.
- target RIR은 문서의 **범위**(hypertrophy 1–2, strength 2–4, diet 2–3)를 중앙값 올림으로 정수화한 것(`program-rules.ts:250`).

관련 골든/테스트: `packages/shared/test/routine-plan.test.ts`, `apps/api/test/programs.spec.ts`.

## 4. `experience_level`은 세트·반복에 영향이 없다

`apps/api/src/programs/programs.service.ts:66, 96, 393` — `DIFFICULTY_RANK`로 바뀌어 `SelectionOptions.levelRank`가 되고,
**종목 후보의 난이도 상한**으로만 쓰인다. `routineSetCountFor(goal, mechanic)`·`routineRepsFor`·`routineRestSecFor`
어디에도 경험 인자가 없다(`routine-plan.ts:14-28`).

> **V2 영향**: `PROGRAM_V2_CONTRACT.md` §2.2의 "목표 × 경험 → role·세트 시작 구간" 계약축은 **현행 구현이 전무하다.**
> 3단계 mapping에서 "V1 값 보존"이라고 쓸 수 있는 값이 없으므로 전부 신규 제품정책이다.

## 5. ⚠ 충돌 — 현행 strength가 V2 세트 cap을 전 구간 초과한다 (→ §5-D B+C로 해소됨)

`PROGRAM_V2_CONTRACT.md` §2.4의 확정 cap은 `30/45/60/75/90분 → 8/12/16/20/24세트`다.
현행 생성기의 세션 총 작업세트는 `운동 개수 × 세트 수`로 결정된다.

| minutes | 확정 cap | hypertrophy·diet | strength |
|---|---|---|---|
| 30 | 8 | **9** ✗ | **15** ✗ |
| 45 | 12 | 12 (경계) | **18–20** ✗ |
| 60 | 16 | 15 ✓ | **21–25** ✗ |
| 75 | 20 | 18 ✓ | **24–30** ✗ |
| 90 | 24 | 21 ✓ | **27–33** ✗ |

**두 열 모두 실측이다. 상한 가정과 섞지 않았다.**

- hypertrophy·diet는 단일값이다. `setCountFor`가 mechanic과 무관하게 3을 주기 때문이다(`routine-plan.ts:26-28`).
- strength는 **범위**다. `setCountFor`가 compound에만 5를 주고 isolation에는 3을 주는데, `PATTERNS_BY_FOCUS`의
  뒤쪽 패턴에 isolation이 섞이는 정도가 focus마다 다르기 때문이다. **산출 기준은 현행 시드 카탈로그
  (`docs/specs/exercises_seed.json`) + `experience_level=intermediate` 난이도 필터 + 현행 선택 comparator의
  `mechanicFirst` 정렬 후 `slice(운동 개수)`** 를 적용했을 때 각 focus(full_body / upper / lower / push / pull /
  legs)에서 나오는 최소~최대다. 하한은 isolation이 가장 많이 섞이는 focus, 상한은 compound가 가장 많은 focus다.
- **30분은 범위가 아니라 단일값 15다.** 운동 3개를 뽑으면 `mechanicFirst` 정렬 때문에 어느 focus에서도
  compound 3개가 먼저 채워져 isolation이 들어올 자리가 없다.
- **90분 35세트는 현행 어느 focus에서도 나오지 않는다.** 초기 값 35는 "전 종목 compound"라는 가정값이었고
  실측 상한은 33이다. 초기의 15/20/25/30/35 단일값 표는 폐기한다.
- 어느 범위를 잡아도 확정 cap을 넘는다.

> **이 표는 수기 추출이라 재발 위험이 있다.** 실제로 이 문서는 한 번 잘못된 값(전 종목 compound 상한)을 실었고
> 독립 리뷰가 두 번 정정했다. **V2-PLAN-01의 선행 AC로 characterization test를 추가한다** — 실제
> `selectExercises` + seed를 호출해 focus·시간별 세션 총 작업세트를 뽑는 read-only 추출 테스트를 두고,
> 이 표를 그 출력과 대조한다. 사람이 세는 방식으로는 같은 실수가 반복된다.

**더 중요한 건 시간이 안 맞는다는 점이다.** strength 30분 = compound 3종 × 5세트 = 15세트, 휴식 180초.

```text
세트 간 휴식   (5-1) × 3운동 × 180초 = 36분   ← 운동별 마지막 세트 뒤 휴식은 세지 않는다
세트 수행      15세트 × 약 20초        ≈ 5분
운동 전환      2회 × 60~90초           ≈ 2~3분
워밍업                                 ≈ 5~8분
────────────────────────────────────────────
합계                                   약 48~52분
```

즉 **현행 30분·45분 strength 프로그램은 처방된 시간 안에 물리적으로 끝낼 수 없다.**
이를 검증하는 테스트가 없다(§2의 "예상시간을 계산하지 않는다").

### ⟨V2 결정⟩ 3단계 결론 — **B+C 확정** (2026-08-23, Codex 협의)

> **이 소절만 사실이 아니라 결정이다.** 이 소절 위쪽(§1~§5)과 아래 §6~§7은 현행 코드의 사실 기록이다.
> 결정의 원천은 `docs/PROGRAM_V2_CONTRACT.md` §2.4이고 여기는 그 요약·근거 연결이다.

검토한 선택지와 판정:

| 안 | 내용 | 판정 |
|---|---|---|
| A | cap을 현행에 맞춰 올린다 | **기각.** 시간 초과가 그대로 남고 cap의 의미가 사라진다. V1 결함에 계약을 맞추는 것 |
| B | strength compound 기본 세트를 5 → 3 | **채택.** 현행 5는 문서 근거 없는 해석값이고 ACSM 2026 envelope은 2~3을 지지 |
| C | 운동 개수를 시간에 맞춰 줄인다 | **채택.** 단 목표별 상수표를 늘리는 방식이 아니라 packer로 간다 |

**B — 세트.** strength compound 기본은 3세트다. 5세트를 금지하지는 않되, 충분한 수행 이력으로 tolerance가 확인되고
시간 예산이 성립하는 **primary 1개/세션**에만 선택적으로 허용한다. `experience_level=advanced`만으로는 허용하지 않는다.
따라서 V2 신규·미캘리브레이션 사용자의 strength 기본은 3세트다.

**C — 운동 개수.** `EXERCISE_COUNT` 같은 고정 상수표를 목표별로 늘리지 않는다(과도기에도). V2 generator는
**role 우선 + 시간 추정 기반 packer**다:

1. primary 1개 확보
2. 시간이 성립하면 secondary 1개 확보
3. accessory/core를 예상시간과 hard cap 안에서만 추가
4. 초과 시 `accessory 제거 → 비-primary 세트 감축 → 운동 제거` 순
5. primary는 최후에 감축하며, **accessory가 남은 채 primary가 잘리는 결과는 금지**

그래서 30분 strength는 보통 primary+secondary **2종 × 3세트 = 6 working sets**에서 시작한다. 45분 이상도 상수가 아니라
같은 packer 결과로 정한다. **`EXERCISE_COUNT`(§2)는 V1 inventory 기록으로만 남기고 V2 generator에서는 폐기 대상이다.**

**기존 사용자 영향 — 데이터 마이그레이션은 없고 동작 마이그레이션은 있다.**
DB backfill도, 기존 active V1 프로그램 수정도 하지 않는다. V2 전환 동의 후 다음 월요일에 생성되는 새 프로그램부터
적용된다. V2 변경 요약에 **"스트렝스 기본 복합운동이 5세트에서 3세트로 조정되고, 선택한 시간 안에 끝나도록 운동 수가
달라질 수 있음"** 을 명시한다 — V2-MIGRATE-01의 고지·동의 대상이다.

## 6. 유산소·role은 현행에 아예 없다

- **cardio 없음**: `Exercise`에 `modality`가 없고 카탈로그 105종이 전부 저항운동이다(`schema.prisma:304-332`).
  따라서 V2의 `S/C/H` composition은 **V1 보존 대상이 아니라 전부 신규**다.
- **role 없음**: `primary/secondary/accessory/core` 개념이 없다. 운동 순서는 `PATTERNS_BY_FOCUS`(`program-rules.ts:120-159`)의
  배열 순서가 전부이고, 이 목록도 주석이 **"해석: 문서에 목록이 없다 — 복합 → 고립 순서, 길항근 균형 기준"** 이라고 적는다.

## 7. 안전 규칙은 문서 근거가 있다 (V2에서 건드리지 않는다)

`program-rules.ts:203-212`의 `PAIN_EXCLUSIONS`는 `docs/SAFETY_PAIN_MAPPING.md` 매핑표를 그대로 옮긴 값이고
주석이 **"사람이 확정한 안전 계약 — 코드에서 임의로 바꾸지 않는다"** 라고 명시한다. `PAIN_AREAS`·`BODY_PARTS`는
이 매핑에서 파생되므로 문서·계약·검증이 갈라질 수 없다.

## 8. 요약 — 3단계 mapping 결과

**3단계는 완료됐다.** 아래 "결정" 열은 확정 사항이며, 원문은 `docs/PROGRAM_V2_CONTRACT.md` §2.4·§2.6이다.

| 축 | V1에 값이 있나 | 결정 |
|---|---|---|
| 요일·분할 | 있음(목표 무관) | **결정됨** — 목표별 S/C/H로 확장(`PROGRAM_V2_CONTRACT.md` §2.3). 기존 focus 배치는 `S` 세션 기본값으로 보존 |
| 시간 → 운동 개수 | 있음(목표 무관) | **결정됨(C)** — 고정 `EXERCISE_COUNT` 폐기, role 우선 + 시간 추정 packer로 대체 |
| 반복·RIR·휴식 | 있음(**문서 근거 있음**) | **결정됨** — 그대로 보존. envelope 안에 있음을 확인 |
| 세트 수 | 있음(근거 없음, 해석) | **결정됨(B)** — strength compound 기본 5 → **3**. 4번째는 제품정책, 5는 tolerance 확인된 primary 1개/세션 |
| 경험별 볼륨 | **없음** | 신규 제품정책. `experience_level`은 계속 종목 난이도 필터로만 쓰고 세트·반복 계수를 만들지 않는다 |
| role | **없음** | 신규 — packer의 primary/secondary/accessory/core |
| cardio | **없음** | 신규 — V2-CARDIO-01 |
| 안전(통증) | 있음(**사람 확정**) | **변경 금지** |
| 정책 버전 운반 | `Program.rules_version` 있음 | **결정됨** — S/C/H·cap·estimator·엔진 출력을 **하나의 bundle**에 묶고 최초 V2 값은 `2026.09.0`. 활성 전환은 PLAN 완료 후 activation ticket에서 한 번만(`PROGRAM_V2_CONTRACT.md` §2.6) |
