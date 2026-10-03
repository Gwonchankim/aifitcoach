# T06 S2 유산소 처방 생성·읽기

S2는 `.09.1` 내부 생성 경로에 실제 유산소 처방을 연결한다. 활성 포인터는 `.08.1`, 공개 생성 DTO의 목표는 기존 3종이다. `.09.0` 순수 baseline은 동결 250개 골든을 재현하며, 기존 `.09.0` resistance packer 내부 진입점의 의미는 유지한다. 선호 UI·활성화는 S3 이후다.

## 생성과 저장

- canonical cardio는 `e_stationary_bike` 1종이다. 명시 `stationary_bike` 장비와 알려진 무통 `pain_areas: []`가 필요하다. 통증 8부위 중 하나라도 있거나 장비·통증 정보가 없으면 생성하지 않는다. `machine`을 자전거로 추정하지 않는다.
- API의 screening/readiness/history는 항상 unknown이다. 따라서 API에서 interval 자격을 만들어내지 않는다. 자격 충족 분기는 순수 planner에서 검증하고 그 결과 descriptor를 내부 저장 entry에 전달하는 테스트로 저장을 검증한다.
- D5(i)의 4·5일 자격 충족자는 원 interval을 같은 슬롯의 steady donor로 대체한다. `cardio_fallback`에 `redesign_recovery`, 원본·실효 descriptor와 source identity를 보존한다. 실효 총초는 감소하지 않고 high 초는 0이다. 원래 자격 fallback은 별도 `source_eligibility_fallback`으로 기록한다.
- mandatory cardio 시간은 저항 packer의 시간만 차감하며 rounds를 저항 working set으로 세지 않는다. 분량을 줄여 예산을 맞추지 않는다. 시간 부족은 `insufficient_time_for_mixed_focus`이며 쓰기 전 실패한다.
- template과 lazy planned row는 descriptor·RPE scale·source identity·강도별 시간·fallback을 저장한다. 유산소 한 블록은 planned row 하나이고 sets·저항 처방 필드는 null이다.

## 읽기와 호환

`source_eligibility_fallback`의 original/effective descriptor가 같은 것은 정상이다. 자격 미확인 상태에서 원래 처방 자체가 steady였음을 기록하며, 존재하지 않았던 interval을 원본으로 만들지 않는다.

GET·sync·오프라인 저장은 저장된 descriptor를 그대로 읽는다. 새 계산이나 건강 판정을 읽기에 끼워 넣지 않는다. UI는 전용 카드에서 읽기만 제공하고 유산소 수행·수정은 이 slice에서 지원하지 않는다. 저항 추천·집계에 cardio를 전달하지 않는다.

legacy NULL kind는 catalog resistance와 교차 검증한다. 신규 저항 writer와 append clone은 explicit `resistance`를 저장한다. 원본 legacy row와 source revision은 바꾸지 않는다. `.08.1`·`.08.2` 기존 응답에는 discriminator를 추가하지 않고 V2 wire에서 kind를 노출한다.

## 검증 경계

`v2-split-e2e-server.ts`는 실제 AppModule의 bundle provider만 TestingModule에서 override한다. 공개 route·환경 bundle selector·앱 코드의 테스트 import는 없다. `playwright.v2-split.config.ts`의 spec23은 실제 생성부터 lazy GET·재접속·오프라인 읽기를 검증한다. 기본 E2E는 활성 `.08.1`을 계속 검증한다.

S1의 225 프로그램·900 세션 baseline은 packer 입출력의 동결 fixture이며 재생성하지 않는다. 기존 106/109/110 catalog oracle은 승인된 새 metadata만 선행 양성 단언 후 제외하고 나머지 모든 필드를 exact 비교한다. S1 backfill SQL은 현행 111행 카탈로그와 분리된 임시 역사 schema에서 원 SQL과 hash 그대로 검증한다.
