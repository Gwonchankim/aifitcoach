# T06 S3 상·하체 빈도 선호

선호 저장과 계획 적용은 별개다. `User.splitPreference`는 nullable enum이며 저장·지우기는 현재 API에서 지원한다. 실제 split 적용은 `2026.09.1`에만 연결하고 활성 포인터 `2026.08.1`은 유지한다. 공개 목표는 기존 세 가지다.

## 프로필과 요청

`GET /me`의 `split_preference_supported`는 같은 `ProgramRulesBundleProvider`에서 파생한 읽기 전용 boolean이다. 규칙 버전 문자열을 노출하거나 입력으로 받지 않는다. false일 때 UI는 선호 저장·지우기만 제공하고 generate 요청에는 선호를 넣지 않는다. true일 때도 5일 priority만 지원하며, 4일 priority와 2·3·6일 priority는 자동 제출하지 않는다.

`PATCH /me`의 미지정은 유지, null은 clear, enum은 저장이다. 빈 객체는 기존 501을 유지한다. 기존 다른 프로필 필드가 포함되면 기존 `notImplemented()`의 501로 요청 전체를 거부한다. 체중·체지방·목표 변경 및 자동 프로그램 재생성은 이번 범위가 아니다. `POST /programs/generate`는 null을 400으로 거부하고, 요청에서 생략한 선호를 서버가 저장 프로필로 대체하지 않는다.

## 고정된 생성 snapshot

`generation_input.split_preference_snapshot`에 예약 `SplitProgramSnapshot`의 여섯 필드를 저장한다. `Program.split_preference_snapshot`은 이 값을 읽는다. 현재 프로필 변경으로 과거 Program을 수정하지 않는다.

| 경우 | requested / effective | applicable / reason | upper_days / lower_days |
| --- | --- | --- | --- |
| 지원 4일 성공 | 요청 원문(null 또는 balanced) / balanced | true / four_day_balanced_only | 2 / 2 |
| 지원 5일 균형·상체 우선 | 요청 원문 / balanced 또는 upper_priority | true / null | 3 / 2 |
| 지원 5일 하체 우선 | lower_priority / lower_priority | true / null | 2 / 3 |
| 2·3·6일 | 요청 원문 / null | false / unsupported_days | 0 / 0 (N/A sentinel) |
| snapshot 없는 과거 Program | null / null | false / legacy_input | persisted template의 upper/lower 수 |
| 미지원 bundle 신규 4·5일 | 요청 원문(null 또는 balanced) / null | false / legacy_input | 기존 template의 upper/lower 수 |

4일 `four_day_balanced_only`는 오류가 아닌 정보다. 과거 snapshot은 읽기 시 파생할 뿐 DB backfill하지 않는다. 잘못된 신규 snapshot을 정상 legacy 값으로 보정하지 않는다.

4일 요일은 월·화·목·금, 5일은 월·화·수·금·토다. 각 focus에 실제 non-core primary와 2개 이상의 working set이 있어야 한다. 시간·primary·회복·donor 검증 실패 시 Program을 부분 저장하지 않는다. 원 donor의 날짜·순번·descriptor·강도별 시간과 S2 fallback 기록을 보존한다.

P09의 48시간은 새 immutable template의 반복 주 경계(±7일)에 적용한다. 다른 Program의 과거 actual을 이 검사에 포함하지 않는다. 이는 기존 날짜를 교환하는 T05 이웃 판정과 별개이며, 실제 이력과의 연결은 건강·활성화 후속 트랙에서 결정한다.

## 화면과 검증 범위

프로필 저장 안내와 Program의 실제 적용 여부를 구분한다. Program은 프로필 대신 snapshot을 표시한다. 온보딩은 기존 7단계를 유지하고 운동일 단계에 선호 선택을 둔다. 고정식 자전거는 장비 선택지에만 추가하고 기존 여섯 기본 장비 선택을 바꾸지 않는다.

예약 TestingModule 서버의 spec22는 profile clear, 실제 5일 하체 우선 mixed 생성, 4일 priority의 UI 차단과 직접 API 400, lazy·reload·offline 처방 읽기를 검증한다. WebKit offline 읽기는 spec09와 같은 fresh-page API-offline helper를 재사용한다. 건강 입력·실제 유산소 수행/종료·actual RPE·공개 `.09.1` 활성화는 후속이다.
