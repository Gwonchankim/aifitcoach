# 카탈로그 확장과 검색

## 머신 카탈로그 (Sprint 02, ticket 01)

시드는 109종이다. 기존 106개 객체(기존 105종과 승인된 Smith 인클라인)는 변경하지 않고 아래 3종을 추가한다.

| canonical ID | 표시 이름 | 패턴 | 주동근 | 기본 반복 / 증량 단위 |
| --- | --- | --- | --- | --- |
| e_low_row_machine | 로우 로우 머신 | horizontal_pull | lats, upper_back | 8~15 / 2.5kg |
| e_high_row_machine | 하이 로우 머신 | horizontal_pull | upper_back, lats | 8~15 / 2.5kg |
| e_incline_chest_press_machine | 머신 인클라인 벤치프레스 | horizontal_push | chest, front_delts | 8~12 / 2.5kg |

세 종목 모두 기존 machine/compound/upper/beginner/reps 분류를 사용한다. 로우 로우와 하이 로우는 손잡이 시작 위치와 당김 궤도가 다른 머신 로우다. 하이 로우를 랫 풀다운으로 중복 등록하지 않는다. 기본값은 기존 머신 로우·Smith 인클라인의 카탈로그 관례를 따른 제품 설정이다.

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

통증 패턴 제외·장비 정렬·난이도·시간에 따른 개수 규칙은 그대로다. 어깨 통증은 horizontal_push 후보를 제외하며 팔꿈치 통증의 기존 elbow_extension/elbow_flexion 제외를 모든 복합 밀기/당기기로 확장하지 않는다. 상세 안전 계약은 [통증 매핑](SAFETY_PAIN_MAPPING.md)을 따른다.

시드는 ID 기반 upsert다. 검증은 소유가 명확한 disposable DB에서 실제 seed 두 번 실행과 기존 운동 객체·프로그램·세션·계획·수행 snapshot의 exact 비교로 수행한다. 실제 사용자 DB를 재시드하거나 기존 IndexedDB를 지우는 절차는 포함하지 않는다.
