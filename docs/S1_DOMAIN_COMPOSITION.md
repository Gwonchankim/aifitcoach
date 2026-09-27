# T06 S1 — 도메인·composition 기반

승인 범위는 Sprint04 rev3 §9.7의 K1(a)+K2다. 활성 `ROUTINE_RULES_VERSION`은 **2026.08.1**이며 공개 프로그램 생성·Profile·UI 목표는 기존 3종이다. Prisma Goal·내부 생성 입력과 Program 응답만 5종으로 확장했다. Profile reader는 3종 외 값을 추정해서 변환하지 않는다.

## 이번에 연결된 경로

| 경계 | 구현 의미 |
| --- | --- |
| Exercise | nullable modality 4종. canonical 110종만 명시 resistance backfill. non-resistance seed 0, ID·기존 속성·과거 기록 불변. NULL modality는 충분한 저항 분류가 있을 때만 legacy로 해석한다. CHECK 표는 DATA_MODEL 참조 |
| 순수 composition | `.09.0` §2.3과 `.09.1` §2.3.1을 별도 표로 적용한다. 4/5일 30행은 C 0. D5(i)는 interval 미배정·원 source 보존 상태로 표기한다. donor 생성·대체는 하지 않는다 |
| 저항 정책 | general_fitness/endurance는 D6(a)에 따라 diet의 compound/isolation 6–12회, RIR 3, rest 90초를 재사용한다. 시간 종목은 canonical 시간값과 reps/RIR NULL을 유지한다. 원 Program.goal/generationInput.goal은 보존한다 |
| 시간 예산 | `packSession.additional_fixed_block_sec`는 estimator에만 들어간다. 원 minutes의 cap·primary 2세트·3→2 규칙을 유지한다. interval 마지막 recovery도 포함하고 rounds를 저항 세트로 세지 않는다 |
| 내부 슬롯 진입점 | `generateWithRulesVersion(..., slotPlanning)`의 명시 `mandatoryBlocksByDay`를 mixed planner에 전달한다. 날짜별 결과를 template에 넣고 lazy DB가 저항 세트 수를 재생한다. 불가능한 블록은 Program 쓰기 전에 실패한다 |
| bundle | 기본 `ProgramRulesBundleProvider.current()`는 활성 포인터를 그대로 반환한다. Nest TestingModule override만 예약 bundle을 선택한다. 공개 DTO·env·query·header 선택 경로가 없다. 선택된 bundle을 factory/recommendation에 전달하고 lazy에서는 저장된 Program bundle을 사용한다. 기존 assistance 호환 helper는 변경하지 않았다 |
| nullable 소비 경계 | API 신규 저항 처방 writer와 웹 저항 편집 후보는 non-resistance·불완전 분류를 거부한다. 웹 wire에는 load semantics가 없으므로 공통 classification guard만 재사용하며 load 값을 만들어 넣지 않는다. swap 판정 불능은 recovery_unverifiable을 유지한다 |

## 증명과 한계

- `session-plan-base-1e15737.json`, `program-packer-base-1e15737.json`은 base `1e1573747d08ee9817c7af29d05bfc97412cd4a5`의 소스 hash 확인 후 한 번 캡처했다. capture SHA·시각·소스 SHA는 각 fixture metadata에 있다. 원 shared 20개 테스트와 원 API 225프로그램/900세션 검사를 실행해 얻은 전체 입출력이다. 회귀 테스트는 fixture를 읽기만 하고 미지정/0 블록 결과를 직렬화 전체와 비교한다.
- 명시 frozen descriptor로 저장된 저항 행의 시간 예산을 독립 산술로 확인한다. 이 검사는 S1의 전달 경로 증거이며 cardio descriptor의 DB 왕복·같은 날짜 donor 보존을 증명하지 않는다.
- 생성은 날짜 최대 6개와 기존 카탈로그 후보 안에서 메모리 계산한다. catalog·history·calibration 조회는 호출 단위로 공유하며 날짜별 DB fallback 질의를 추가하지 않는다. migration은 canonical ID scan과 NULL-only update, seed는 기존 110 upsert다.
- 신규 cardio 종목·equipment vocabulary, 실제 cardio 생성·저장·wire·offline reader는 S2다. 기존 planned snapshot의 reader/append는 S1의 신규 catalog 거부 경로와 별개이므로 S2에서 modality 교차 검증을 완성한다. preference 사용자 기능 및 예약 bundle E2E harness는 S3다. 이 slice를 full V2/HIIT 활성화나 P05–P10 전체 완료로 해석하지 않는다.

기존 `golden_tests.json`, `cardio_baseline_golden.json`, `feature_improvements_contract.json` 및 추천 수학은 변경하지 않는다. 기존 109종 oracle은 modality 양성 단언을 먼저 한 뒤 그 키만 제거하여 모든 기존 필드를 exact 비교하며 frozen fixture/hash를 유지한다.
