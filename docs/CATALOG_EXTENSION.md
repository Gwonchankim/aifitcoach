# 카탈로그 확장과 검색

## 머신 카탈로그 (Sprint 02, ticket 01)

ticket 01은 기존 106개 객체(기존 105종과 승인된 Smith 인클라인)를 변경하지 않고 아래 3종을 추가했다. ticket 02의 어시스트 딥스를 포함한 현재 시드는 110종이다.

| canonical ID | 표시 이름 | 패턴 | 주동근 | 기본 반복 / 증량 단위 |
| --- | --- | --- | --- | --- |
| e_low_row_machine | 로우 로우 머신 | horizontal_pull | lats, upper_back | 8~15 / 2.5kg |
| e_high_row_machine | 하이 로우 머신 | horizontal_pull | upper_back, lats | 8~15 / 2.5kg |
| e_incline_chest_press_machine | 머신 인클라인 벤치프레스 | horizontal_push | chest, front_delts | 8~12 / 2.5kg |

세 종목 모두 기존 machine/compound/upper/beginner/reps 분류를 사용한다. 로우 로우와 하이 로우는 손잡이 시작 위치와 당김 궤도가 다른 머신 로우다. 하이 로우를 랫 풀다운으로 중복 등록하지 않는다. 기본값은 기존 머신 로우·Smith 인클라인의 카탈로그 관례를 따른 제품 설정이다.

## 어시스트 딥스 (Sprint 02, ticket 02)

`e_assisted_dips` / 어시스트 딥스 머신 / Assisted Dip Machine을 추가한다. horizontal_push, 주동근 chest·triceps, 보조근 front_delts, 기본 반복 6~12, 도움 단위 2.5kg이며 machine/compound/upper/beginner/reps 분류를 사용한다. 대체 후보는 `e_dips`, `e_chest_press_machine`이다. 기존 109개 seed 객체는 그대로다.

도움 무게는 기존 assistance snapshot·버전·표시 게이트를 따른다. 같은 운동 ID라도 저장된 external snapshot을 assistance로 승격하지 않는다. 도움 증감 방향·최소값·반올림·수행값·안전 판정·F-4b 복구와 적용된 migration은 변경하지 않는다. 도움 kg을 external e1RM이나 external 볼륨에 합산하지 않는다.

최소 도움 경계의 전환 제안에는 canonical 운동 ID 메타데이터만 추가한다. shared 계산 입력, 신규 재계산, 저장된 추천 응답, session GET, sync 응답 및 오프라인 mirror가 같은 대상을 전달한다.

| 현재 canonical ID | 제안 대상 |
| --- | --- |
| e_assisted_pullup | e_pullup / 풀업 |
| e_assisted_dips | e_dips / 딥스 |
| 누락 또는 그 외 ID | recommended_action=null |

제안 대상은 위 두 쌍만 허용한다. 대체 후보·운동 부위·기본 풀업으로 추측하지 않는다. 메타데이터 누락은 추천 숫자나 안전 상태를 바꾸지 않는다. 실제 UI는 최소 도움 reason, ready 상태, 기존 3세션 표시 게이트와 안전 판정이 모두 허용할 때 카탈로그의 canonical 이름으로 수동적인 안내를 표시한다. catalog 미도착·실패, null action, 안전 차단, sample count 0/1/2에서는 구체적인 전환 안내를 숨긴다. GET·새로고침·오프라인 복귀로 운동을 자동 교체하지 않으며 planned ID·exercise ID·수행 기록·outbox를 수정하지 않는다.

## 검색과 저장 경계

`GET /exercises`의 기존 cursor 페이지 전체를 받은 뒤 클라이언트에서 한글·영문·동의어를 검색한다. 앞뒤 및 내부 공백을 제거하고 영문 대소문자를 구분하지 않는 부분 일치다. 검색어가 없으면 선택한 부위, 있으면 전체 부위를 검색한다. 지우면 기존 부위로 돌아간다.

| 검색 동의어 | 기존 canonical ID / 표시 이름 |
| --- | --- |
| 머신 벤치 프레스 | e_chest_press_machine / 체스트 프레스 머신 |
| 시티드 머신 로우 | e_machine_row / 머신 로우 |

동의어는 검색 전용이다. 시드 이름·ID·API 계약·기록의 운동 ID를 바꾸거나 중복 생성하지 않는다. 추가/교체 모두 같은 검색을 사용하고 현재 운동 및 중복 추가 제한을 유지한다.

전체 페이지 성공 후에만 사용자 범위의 catalog cache를 교체한다. 중간 실패 시 기존 완전한 캐시를 유지하며, 캐시가 없는 경우 불러오기 실패와 재시도 안내를 표시한다. 오프라인은 이미 받은 카탈로그만 제공한다. session/draft/outbox를 삭제하거나 catalog 갱신을 위해 IndexedDB를 초기화하지 않는다.

## 선택 영향과 이력

새 종목은 기존 프로그램 선택기의 후보가 된다. 기존 프로그램의 저장된 template/planned/performed는 변경하지 않는다. active V1 goal 3 × days 5 × minutes 5 × level 3 × (통증 없음 + 8부위)의 2,025개 입력에서 baseline 106종과 확장 카탈로그의 실제 선택 결과를 비교한다. 기존 Smith 105→106 회귀는 별도 고정 baseline으로 보존한다.

106→109 비교에서 바뀌는 입력은 405/2,025개다. 통증 없는 225개 입력은 모두 동일하다. 통증별 변경 수는 knee 45, lower_back 45, shoulder 36, elbow 45, wrist 45, hip 45, neck 99, ankle 45다. 신규 하이 로우와 머신 인클라인이 안정성 우선 대체 후보에 들어가며, 로우 로우는 이 격자에서 자동 선택되지 않는다(수동 추가는 가능). 전체 주간 ID·순서·개수 행렬의 SHA256은 API 회귀 테스트에 고정되어 있다.

어시스트 딥스 추가는 기존 정렬·선택 규칙 아래에서 실제 선택을 더 바꾼다. 전체 110종의 변경을 머신 3종의 405개 결과로 대신하지 않는다.

| 후보군 비교 | 변경 / 전체 | 통증 없음 | shoulder | 나머지 7개 통증 부위 각각 |
| --- | --- | --- | --- | --- |
| 106→110 | 1,686 / 2,025 | 75 / 225 | 36 / 225 | 225 / 225 |
| 109→110 | 1,650 / 2,025 | 75 / 225 | 0 / 225 | 225 / 225 |

두 행렬은 106→109 및 Smith 회귀와 별도 해시로 고정한다. 기존 `v1-plan-225` 정적 fixture는 신규 4개 ID만 `avoid_exercises`로 제외해 원래 106종 후보군에서 정확 비교한다. fixture 예상값·225개 입력·모든 필드 비교는 유지한다. 별도의 실제 110종 V1 225개 생성 규칙 검사와 예약 packer 225개 시간/cap 검사는 신규 운동을 제외하지 않는다. 실제 API 대표 입력은 106·109·110 후보군별 template와 materialized planned 값을 각각 대조한다. 이 과정은 DB 운동 행을 삭제하거나 기존 프로그램을 재생성하지 않는다.

통증 패턴 제외·장비 정렬·난이도·시간에 따른 개수 규칙은 그대로다. 어깨 통증은 horizontal_push 후보를 제외하며 팔꿈치 통증의 기존 elbow_extension/elbow_flexion 제외를 모든 복합 밀기/당기기로 확장하지 않는다. 상세 안전 계약은 [통증 매핑](SAFETY_PAIN_MAPPING.md)을 따른다.

시드는 ID 기반 upsert다. 검증은 소유가 명확한 disposable DB에서 실제 seed 두 번 실행과 기존 운동 객체·프로그램·세션·계획·수행 snapshot의 exact 비교로 수행한다. 실제 사용자 DB를 재시드하거나 기존 IndexedDB를 지우는 절차는 포함하지 않는다.
