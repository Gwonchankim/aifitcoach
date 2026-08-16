# M-4′ 기록·주간 프로그램·대시보드 집계 계약

> 상태: Sprint 0 계약 잠금, Sprint 1A projector·Sprint 1B T-UI-3, Sprint 2 서버 계약 완료,
> Sprint 3 클라이언트 read-through 계약 잠금(2026-08-16).
> 원본 프로토타입 7종 추출 및 M-4′ 3화면 픽셀·문구 체크리스트까지 고정했다.

## 1. 범위와 현재 경계

실기기에서 본 대시보드와 프로토타입의 차이는 예정된 상태다. 현재 홈은 오늘/내일, 연속 운동일,
주간 계획 준수율과 빈 e1RM 카드까지만 구현돼 있다. M-4′가 실제 수행기록으로 e1RM, 주간 볼륨,
주간 리듬, 기록/세션 상세, 12주 프로그램 진행을 연결한다.

- `Estimated1rm`·`MuscleWeeklyLoad`는 스키마에만 있고 읽기·쓰기가 없다.
- `/analytics/e1rm`·`/volume`·`/completion`은 501이다.
- 프로그램은 현재 주간 `template`을 저장하고 2주 세션만 생성한다.
- 저장소에는 승인 설명에 언급된 `generation_input` 컬럼과 `planWeek` 함수가 실제로 없다.
- STEP 6 Dexie는 현재 세션·draft·outbox를 보존하지만 과거 전체 수행기록 저장소는 아니다.
- 대시보드 PR은 raw Epley, 추천 엔진은 저반복 우선 + RIR 보정 Epley라 같은 기록의 값이 갈릴 수 있다.

## 2. D-32~D-44 확정 계약

| 결정 | 확정 내용 |
|---|---|
| D-32 | 원본은 `performed_sets`·`workout_sessions`다. 같은 순수 projector를 세션 완료/수정/삭제/sync 뒤 targeted recompute, 조회 시 reconcile, 전체 rebuild/backfill에 쓴다. |
| D-33 | `estimated_1rm`은 사용자·종목·완료 세션당 1행이다. `session_id`가 논리 키이며 timestamp를 행 식별자로 쓰지 않는다. |
| D-34 | e1RM은 Epley + corrected RIR, 저반복(6회 이하) 세트 우선이다. 맨몸·시간 종목은 e1RM을 만들지 않는다. 대시보드 PR도 같은 공용 함수를 사용한다. M-4′에서는 캘리브레이션 미구현이므로 bias=0을 명시적 입력으로 쓰고, M-7′이 bias를 도입할 때 versioned rebuild/snapshot 정책을 다시 잠근다. 통일 전 값은 전체 rebuild로 교체하며 구 계산값을 섞어 두지 않는다. |
| D-35 | hard set은 완료됐고 실제 RIR 0~3인 세트만 센다. 주동근마다 1세트, 보조근은 제외한다. `volume_load`는 외부 무게×반복만, `avg_rir`은 입력된 RIR만 평균낸다. |
| D-36 | 근비대 권장 범위는 10~20 hard sets, 다이어트는 8~14다. 스트렝스는 승인된 근육별 범위가 없어 실제값만 표시하고 범위 경고를 만들지 않는다. |
| D-37 | `programs`에 `started_at`, `total_weeks=12`, `status`와 신규 생성부터 재생성 입력을 보존한다. 12주 세션을 사전 생성하지 않는다. 주차는 `started_at`과 UTC 오늘로 계산하고, 실제 생성 세션 + 아직 생성하지 않은 미래 주차 `scheduled` 표현을 합성한다. 레거시는 기존 `template` 스냅샷을 lazy 생성 원천으로 쓰므로 lifecycle backfill은 `started_at` 설정만으로 충분하다. 복원 불가능한 옛 generation input을 추측해 채우지 않는다. |
| D-38 | `/analytics` 3종을 실제 구현하고, e1RM observation, 주별 volume, 날짜별 completion/session summary를 반환한다. 완료 세션 상세는 기존 `GET /sessions/{id}`에 실제 수행값을 붙인다. `/sync` cursor를 이력 조회에 재사용하지 않는다. |
| D-39 | 게이트 구현은 오직 `packages/shared/display-gate.ts` 한 파일이다. 서버가 종목별 distinct 완료 세션 수로 게이트를 적용한 응답을 내려주며 웹은 서버 결과를 신뢰한다. 오프라인 mirror만 같은 모듈로 판정하고, 서버 응답 도착 시 서버가 권위다. |
| D-40 | 4탭 IA는 별도 선행 티켓 T-UI-3으로 먼저 만든다. 오늘/기록/프로그램/내 정보 네 경로를 제공하며 내 정보는 비민감 프로그램 설정의 읽기 전용 최소 화면이다. |
| D-41 | 홈 상태 중 미수행/진행/완료/부분/휴식/프로그램 없음은 실제 세션과 세트로 파생한다. 계획 충돌은 같은 날짜의 계획/실제 불일치, 공백 복귀는 마지막 완료 뒤 계획 세션 누락을 표시만 하며 추천 감량 수식은 바꾸지 않는다. |
| D-42 | ADR-24를 유지한다. 계획 충돌·볼륨 범위 이탈은 읽기 전용 경고만 제공하고 세션 재배치나 다음 주 세션 추가 mutation은 만들지 않는다. |
| D-43 | 집계 DB backfill은 필수다. 서버 이력 읽기와 이전 기록 표시는 이번에 구현한다. 사용자가 과거 기록을 직접 입력하는 R-21은 ADR-38과 충돌하므로 별도 티켓이다. |
| D-44 | 종목별 PR 값·날짜·세션 표시는 이번에 통일한다. 첫 관측은 PR이 아니다. 완료행 접기 16×44px와 F14 한글 키커는 세트 그리드/디자인 티켓으로 유지하며, 스트릭은 기존 ‘연속 완료 운동일’ 정의를 유지한다. |

## 3. 집계 불변식

1. 같은 사실 행 집합이면 DB 삽입 순서와 무관하게 정렬된 JSON 직렬화까지 동일하다.
2. affected session/week 증분 재계산 결과와 전체 rebuild 결과가 행 단위로 동일하다.
3. 같은 완료·sync·backfill 재실행은 새 e1RM·PR·hard-set 행을 만들지 않는다.
4. set 수정/삭제/LWW는 해당 세션 e1RM과 해당 UTC 주를 통째로 교체한다.
5. 모든 조회·projection·backfill은 `user_id`로 격리한다.
6. e1RM/PR 공식은 하나이며, 전환 시 기존 `estimated_1rm`과 PR 파생값을 전량 rebuild한다. M-4′의
   corrected RIR bias는 0이고, 아직 존재하지 않는 캘리브레이션 값을 추측하지 않는다.
7. `avg_rir`은 RIR 입력이 한 건도 없는 근육/주에는 `null`이다. 결측을 0으로 만들지 않는다.

## 4. 3세션 표시 게이트

- 단위: 종목별 **distinct 완료 세션**, 임계값 3. 세트 수가 아니다.
- `no_history`: observation 0, e1RM 추이와 다음 추천 없음.
- `early`: observation 1~2, 날짜 observation만 제공하고 e1RM 수치/선/다음 추천/추천 근거는 서버 응답에서 제거한다.
- `ready`: observation 3 이상, e1RM points와 게이트된 다음 추천을 제공한다.
- 온라인 웹은 `gate_state`와 nullable/empty payload를 그대로 렌더한다. 다시 판정하지 않는다.
- 오프라인 provisional 데이터만 공용 `display-gate.ts`로 판정하고 서버 결과가 오면 교체한다.

## 5. 12주 lazy lifecycle

- `started_at`: 프로그램이 시작된 UTC 날짜. 신규 프로그램은 생성 당시 주의 월요일이다.
- `total_weeks`: v1은 12 고정.
- `status`: `active | completed`; `started_at + 12주` 경계에서 completed로 해석한다.
- `current_week`: `clamp(floor((today-started_at)/7일)+1, 1, 12)`로 계산하며 저장하지 않는다.
- 현행처럼 가까운 주차만 실제 `workout_sessions`로 lazy 생성한다. API는 실제 행이 없는 미래 주차를
  프로그램 template에서 `scheduled` preview로 합성하되 DB 행/ID가 있는 것처럼 가장하지 않는다.
- 레거시 program에는 반복 가능한 `template`이 이미 있으므로 `started_at`만 earliest planned session의
  주 시작일로 backfill한다. 세션이 없는 레거시는 `created_at`이 속한 주의 월요일을 쓴다.
- 신규 generation input은 보존하되, 레거시에서 복구 불가능한 experience/equipment/avoid 입력을 추정하지
  않는다. 레거시는 template snapshot fallback을 유지한다.

## 6. API 응답 원칙

- e1RM 응답은 observation 수와 서버 `gate_state`를 항상 포함한다. early/no-history에서는 값과 추천을
  구조적으로 제거한다.
- volume은 목표와 권장 범위를 함께 주되 스트렝스의 범위는 `null`이다.
- completion은 주별 날짜 리듬과 실제 session summary를 함께 준다. 미래 lazy 주차에는 session ID가 없다.
- 완료 세션 `planned_sets[]`에는 소유 사용자의 실제 수행값만 붙인다. 내부 user id와 암호화 저장값은 노출하지 않는다.
- 대시보드는 weekly rhythm과 서버가 게이트한 주요 e1RM 요약을 포함한다.

## 7. Sprint 0 red proof

red suite는 501 하나로 전부 실패하면 무효다. 최소 다음 축을 따로 발화시킨다.

1. analytics endpoint가 501이라 실패하는 transport/구현 경계.
2. 200 Program 응답에 lifecycle 필드가 없어 실패하는 응답 계약.
3. 200 Session 응답에 actual 수행값이 없어 실패하는 세션 상세 계약.
4. 200 Dashboard 응답에 weekly rhythm/서버 gate가 없어 실패하는 대시보드 계약.
5. test oracle의 insertion order mutant와 incremental mismatch mutant가 각각 다른 단언으로 실패.
6. 한 세션의 세 세트를 3세션으로 세는 mutant와 raw-Epley mutant가 각각 게이트/수치 단언으로 실패.

구현 Sprint에서는 이 red suite를 일반 `.spec.ts` 게이트로 승격한 뒤 production 코드를 작성한다.

## 8. 프로토타입 증거와 적용 우선순위

원본 7개 오프라인 번들은 각각 약 22MB이며 브라우저 런타임과 압축 자산이 대부분이다. 전체 번들은 커밋하지
않고 `scripts/extract-prototypes.mjs`로 embedded `__bundler/template`에서 실행 스크립트·폰트 바이너리 참조를
제거한 마크업/스타일과 한글 카피만 `docs/prototypes/`에 보존한다. `manifest.json`이 원본 파일명·크기·SHA-256을
고정하며 `--check` 재실행은 추출물의 바이트 단위 재현성을 검증한다.

- M-4′ 직접 근거: [홈 대시보드](prototypes/home-dashboard.template.html),
  [기록](prototypes/history.template.html), [주간 프로그램](prototypes/weekly-program.template.html)
- 후속/기구현 대조용: 세션·온보딩·RIR 튜토리얼·페이월 B도 같은 방식으로 보존하되 M-4′ 화면 범위에는 넣지 않는다.
- 우선순위: OpenAPI/ADR/D-32~D-44와 접근성 계약 > 이 체크리스트의 구현 목표 > 프로토타입 원문이다.
  특히 D-39 서버 권위 display gate와 충돌하는 프로토타입 상태는 그대로 구현하지 않는다.

## 9. 픽셀·문구 단위 체크리스트

### 9.1 공통 프레임·토큰·4탭 IA

| 요소 | 프로토타입 실제 값 | M-4′ 구현 목표 |
|---|---|---|
| 기준 뷰포트 | 폰 목업 `390×812px`, `surface #FFFFFF`, 외곽 `1px #C9D0DA`, radius `14px`; 바깥 canvas `#E9ECF1` | 실제 앱은 고정 높이/목업 테두리·그림자 없이 `390px` 폭에서 동일 밀도. `max-w-md` 반응형과 `min-h-dvh` 유지 |
| 상태/앱 헤더 | 목업 상태줄 `26px`; 화면 헤더 좌우 `16~18px`, 하단 `1px #C9D0DA`; 제목 `19px/800` | 가짜 `9:41/PWA` 상태줄은 구현하지 않음. 제품 헤더는 19px 제목과 1px divider, 최소 44px 조작 목표 유지 |
| 스크롤 본문 | 좌우 `16px`, 상하 `12~18px`, 카드 사이 `11~12px` | 세 화면 공통 content gutter `16px`, vertical gap `11~12px`; 안전영역은 별도 합산 |
| 카드 | 기본 `1px #C9D0DA`, 강조 `1.5px #151A21`, radius `3px`, padding `12~15px`, 그림자 없음 | `border`, `ink`, `rounded-card`, `surface` 토큰으로 동일. 목업 frame shadow는 유입 금지 |
| 색 | ink `#151A21`, muted `#5D6875`, weak divider `#E4E9F0`, primary `#1B4FC4`, success 원본 `#1B8A4B`, warn `#D08A00` | 기존 토큰 사용. AA 보정으로 success text는 `#198146`, warn text는 `#8A6100`; 원본 미달색을 문자에 복제하지 않음 |
| 타이포 | 키커 `JetBrains Mono 9.5px/.14em/uppercase`; 본문 `12.5~13.5px`, `1.55~1.6`; 지표 `21~36px` mono/tabular | 한글 키커를 영문 uppercase처럼 축소하지 않음(F14 defer 유지). 숫자·날짜·RIR만 mono/tabular, 본문 Pretendard |
| 버튼/포커스 | 주 CTA `44px` 또는 `48px`, radius `3px`; focus `2px #1B4FC4`, offset `2px` | 모든 탭 가능 요소 min `44×44px`; 핵심 CTA 48px. 기존 focus ring 토큰 사용 |
| 하단 IA | `오늘 / 기록 / 프로그램 / 내 정보`, 높이 `50px`, 4등분; active `#1B4FC4` + 15×15 채운 표식, inactive `#5D6875` | T-UI-3에서 실제 링크/랜드마크/active route 구현. 각 탭 hit area ≥44px, 화면 본문이 nav/safe-area에 가리지 않음 |

### 9.2 홈 대시보드

| 요소 | 프로토타입 실제 값·문구·배치 | M-4′ 구현 목표 |
|---|---|---|
| 헤더 | 좌 `오늘`, 우 `8.09 토 · 3주차`(10px mono) | 실제 UTC 오늘과 D-37 `current_week`로 생성. 하드코딩 금지 |
| 프로그램 없음 | 1.5px 강조 카드; `프로그램 없음` → `주 몇 회 운동할지만 정하면 오늘 할 일이 생깁니다`; 12.5px 설명; `프로그램 만들기` 44px | 실제 program 없음에서 동일 hierarchy/copy. 아래 ad-hoc 진입 CTA는 제외(D-45~D-47) |
| 빈 상태 안내 | `만들고 나면` 카드, 01 요일 계획 / 02 `세 세션` 뒤 추천·e1RM / 03 리듬·볼륨 | `세 세션`을 유지. D-39와 같은 종목별 distinct 완료 세션 3회임을 테스트로 고정 |
| 오늘 카드 | 강조 border, padding 13px; kicker+상태 chip 한 줄, 제목 20px, 설명 12px, 종목 리스트, CTA | 세션 사실에서 미수행/진행/완료/부분/휴식/없음을 서버 view model로 파생(D-41). 문자열을 상태별 고정 계약으로 사용 |
| 미수행 | `오늘 수행할 운동` / `12세트 예정` / `상체 밀기 · 4종목` / `세션 시작` | 실제 planned count·routine·첫 recommendation 사용. recommendation nullable이면 값 문구를 숨김 |
| 진행 | `진행 중인 세션 · 기기에 저장됨` / `5세트 기록됨` / `이어하기` / 보조 `오늘은 여기까지` | Dexie mirror의 local pending 상태를 표시하고 서버 권위 도착 후 교체. count는 실제 completed sets |
| 완료·부분 | `오늘 기록 요약`; 완료 `완료 ✓`, 부분 `8세트 완료`; `오늘 기록 보기`, 부분은 `남은 종목 이어하기` | 완료/부분을 색뿐 아니라 ✓·명시 문구로 구분. 실제 session detail 경로로 연결 |
| 휴식·공백 복귀 | `오늘은 휴식`/`예정된 운동 없음`; 복귀 `추천 신뢰도 낮음`과 마지막 세션 설명 | 휴식은 실제 schedule. 공백은 읽기 전용 설명만; 원본의 임의 `10% 낮춤`은 추천 수식 계약 밖이므로 생성 금지 |
| 계획 충돌 | `예정이던 상체 밀기` / `어떻게 할까요`와 이어하기·미루기·건너뛰기 3개 라디오, 결과 문장, `이대로 반영` | D-42 우선: 충돌 사실과 영향만 읽기 전용으로 표시. 재배치/건너뛰기 mutation UI는 제외(D-46) |
| 이번 주 리듬 | 카드 padding `12px 11px`; 7열 `repeat(7,1fr)`, gap 4px; 요일 9.5px, 표식+상태 8.5px; 날짜 탭 시 divider 아래 상세 | completion API의 7일을 월→일 안정 정렬. 완료 ✓/부분 ½/오늘 ●/예정/휴식을 문자+색으로 표시하고 상세 행 연결 |
| e1RM 요약 | `벤치프레스 추정 1RM`; `78.5kg` 21px mono; `▲ 3.2kg · 4주`; 우측 `기록 탭 ›` | 서버 `primary_e1rm` ready일 때만 값·delta 노출. early/no_history에서는 카드 값/링크 추천 유도 없음 |
| 주간 볼륨 | `주간 볼륨`, 우 `권장 10–20`; 행 grid `34px 1fr 54px`, gap 8px; 가슴/등/어깨/하체/팔 | projector 결과와 goal range 사용. strength는 권장 문구/범위 band 없음. warn은 실제 범위 이탈 + 텍스트 설명 |

### 9.3 기록

| 요소 | 프로토타입 실제 값·문구·배치 | M-4′ 구현 목표 |
|---|---|---|
| 기본 IA | 제목 `기록`, 우측 종목명; content `12px 16px 16px`; 최근 수행 순서의 horizontal exercise chips | `/history`에서 종목별 추이를 기본으로 표시하고 선택 종목을 URL/상태로 보존 |
| 전체 빈 상태 | `기록 0회`; 19px `첫 세션을 마치면 여기에 추이가 쌓입니다`; `시작하는 법` 01~03; CTA 2개 | 03은 `세 세션`으로 수정. `예전 기록 직접 입력`은 R-21 defer라 제외(D-47); 오늘 세션 링크만 제공 |
| e1RM 카드 | 강조 border; kicker `추정 1RM · 5주`; delta 11px; 값 `36px` mono; SVG `326×118`, 선 primary 2px, grid 1px | ready에서만 observation chart. point·축은 서버 정렬 그대로, 공백 구간은 선을 잇지 않음 |
| 1~2회 early | 원본은 `기록 N회` 차트/최신 e1RM과 `지금 알 수 있는 것`의 `다음 추천`·근거까지 노출 | D-39 우선: e1RM 값/선/다음 추천/근거 모두 숨김. 완료 세션 observation 날짜·실제 수행만 표시(D-45) |
| 공백 구간 | `4주간 기록이 없습니다`; 차트 선을 양쪽 segment로 끊고 회색 gap rect/dashed bounds | 실제 observation 날짜 간 공백을 결정론적으로 계산. 감량 추천 수식은 만들지 않고 설명만 제공 |
| 최근 세션 | 카드 제목 `최근 세션`; 날짜/교체 tag/무게 한 줄, 반복/RIR 둘째 줄; 내부 divider | completion/session detail 실제 데이터. 정렬 completed_at desc + stable id tie-break |
| 예정 종목 | `아직 수행 전`; 예정일·`시작 무게` 참고값; `오늘 세션으로 앞당기기` | 계획/참고값은 읽기 전용. inline 앞당기기 mutation은 제외하고 활성 세션이 있으면 그 화면 링크만 제공(D-49) |
| 종목 기록 없음 | `이 종목 기록 0회`; 비슷한 종목 3행; `오늘 세션에 … 추가` | 유사 기록은 승인된 데이터가 있을 때만. inline add mutation은 M-4′에서 만들지 않음(D-49) |
| 세션 상세 요약 | `8월 8일 금 · 3주차`; routine; `4종목 / 11세트 완료 / 45분`을 26px mono로 한 줄 | 기존 `GET /sessions/{id}` actuals로 실제 count/duration. 빈 duration은 추측하지 않음 |
| 종목 상세 행 | 카드별 44px 종목 header + `추이 ›`; grid `16px 1fr 1fr 42px`, gap 7px; 추천/실제/RIR; row padding 7px | planned/performed mapping을 안정 정렬. 추천과 실제 차이는 primary + 텍스트/기호로 함께 표시 |
| 세션 이력 | muted card `이 세션의 이력`; 시간 10px mono + 통증/교체/부분 종료 문장 | 서버에 존재하는 감사/이벤트 사실만. 현재 계약에 없는 이벤트를 performed data에서 추측 합성하지 않음 |

### 9.4 주간 프로그램

| 요소 | 프로토타입 실제 값·문구·배치 | M-4′ 구현 목표 |
|---|---|---|
| 헤더 | `주간 프로그램`; 우측 `무료`, `가입 24일 · 10세션` 9px chips | 결제 상태는 M-7′ 범위이므로 `무료` hardcode 금지. 실제 session count만 lifecycle 요약 안에 표시(D-48) |
| 진행 카드 | 강조 border; `프로그램 진행`; `근비대 4분할 · 12주 중 3주차`; 우 `일정 바꾸기` 32px; progress 6px/25%; 성과 한 줄 | D-37 `started_at/today`로 주차·progress 계산, `total_weeks` 사용. 일정 변경 mutation은 제외(D-49) |
| 성과 요약 | `3주간 10세션 완료 · 벤치프레스 +3.2kg · 스쿼트 +7.5kg` | completion + ready e1RM delta만 사용. early 종목 값은 누락 처리, raw Epley 금지 |
| 주간 볼륨 | `이번 주 볼륨 · 권장 10–20세트`; 각 행 label 28px, track 9px, value 34px; range band + fill | volume API와 목표별 범위. strength는 band/경고 없음. 이탈 시 읽기 전용 한 줄만 제공 |
| 요일 목록 | 1px bordered card; 7행; 요일 26px, 상태 mark, routine, sub, chevron; 완료/부분/오늘/예정/휴식 | 실제 생성 session과 lazy future preview를 합성. preview에는 session id가 없고 `예정`임을 명시 |
| 펼친 날짜 | 좌 padding 55px; 종목 행 dotted divider; 계획 값 + 원본 `교체` 28px; 하단 예상 분 | 종목/계획/예상 시간을 읽기 전용 표시. 미래 planned swap은 별도 계약 전 제외(D-49) |
| 미래 주차 | 원본은 현재 1주 목록만 있고 4~12주를 사전 생성한 행은 없음 | D-37 우선: 실제 생성 주차 + template 기반 미래 `예정` 주차를 별도 목록/요약으로 합성, DB 사전 생성 금지 |
| 종료 상태 | `12주 완료`; 19px 완료 제목; 3열 `세션/벤치/스쿼트` 20px; `같은 목표로 계속`·`목표 바꾸기` 각 48px | status completed에서 실제 count/ready delta. 다음 프로그램 생성은 기존 onboarding 경로로 명시적 이동하며 자동 생성 금지 |
| 교체 sheet | bottom sheet radius `12px 12px 0 0`, padding `16px 18px 20px`, max-height 78%; 48px `교체하기` | 활성 세션 교체는 M-UIb 계약을 재사용. 미래 주간 계획의 사전 교체는 M-4′에서 노출하지 않음 |

## 10. 프로토타입 모순·범위 충돌 — D-45~D-49

아래는 원본을 그대로 복제할 수 없는 지점이다. D-45·D-46은 이미 승인된 D-39·D-42의 화면 적용이며,
D-47~D-49도 2026-08-16 제품 오너 승인으로 확정됐다. 다섯 결정 모두 후속 범위를 앞당기지 않는 현재 계약이다.

| 결정 | 발견된 충돌 | 권장 처리 |
|---|---|---|
| D-45 | 홈은 `세 세션`, 기록 빈/early는 `세 세트`·2회 상태의 다음 추천/e1RM을 노출한다 | **D-39 우선**. 전부 종목별 distinct 완료 세션 3회로 통일하고 early 값/추천/근거를 구조적으로 숨긴다 |
| D-46 | 홈 계획 충돌 원본은 이어 붙이기·미루기·건너뛰기와 `이대로 반영` mutation을 제공한다 | **D-42 우선**. 충돌/볼륨 영향은 읽기 전용 경고만 표시하고 재배치 mutation을 만들지 않는다 |
| D-47 **확정** | 홈 `프로그램 없이 … 기록`은 M-UIa D-1에서 제거 확정, 기록 `예전 기록 직접 입력`은 ADR-38/R-21과 충돌한다 | 두 CTA 모두 제외. M-UIa D-1·D-43과 일치시키고 현재 세션/프로그램 생성의 승인된 경로만 제공한다 |
| D-48 **확정** | 주간 헤더의 `무료`는 실제 결제 상태처럼 보이나 결제·구독은 M-7′ 범위다 | TEST_SCOPE의 결제 보류를 따른다. 결제·가입 chip을 생략하고 M-7′에서 페이월과 실제 구독 상태를 함께 도입한다 |
| D-49 **확정** | 기록의 앞당기기/add와 주간의 일정 바꾸기/미래 종목 교체는 새 planning mutation 계약을 요구한다 | D-42·ADR-24와 같이 M-4′는 조회·집계 화면으로 제한한다. 활성 세션의 기존 add/swap 경로만 허용하고 미래 계획 inline mutation은 별도 티켓으로 둔다 |

## 11. Sprint 2 서버 계약 구현·검증

- `/analytics/e1rm`, `/analytics/volume`, `/analytics/completion`을 200 실데이터 응답으로 구현했다.
  e1RM·PR은 추천 엔진과 같은 `estimateE1rm`을 쓰며 raw Epley 계산 경로를 두지 않는다.
- 세션 완료·sync는 affected session/week를 재계산하고, 조회는 사용자 원본 사실에서 reconcile한다.
  기존 파생값은 `pnpm --dir apps/api run analytics:backfill`로 전량 rebuild한다.
- D-37 migration은 `started_at`을 earliest session 주(없으면 `created_at` 주)로 채우고 `total_weeks=12`,
  `status`, nullable `generation_input`을 추가한다. 신규 POST는 세션 0행으로 시작하고 첫 조회에서 현재+다음
  주만 만든다. 레거시 `generation_input IS NULL` 프로그램도 저장된 template만으로 같은 lazy 경로를 쓴다.
- D-39의 판정 함수는 `packages/shared/src/display-gate.ts` 하나다. 세션 상세·완료 추천·analytics·dashboard와
  D-31 sync mapping 응답까지 서버가 distinct 완료 세션 수로 gate한 값을 내려준다. 웹 요약은 nullable
  recommendation을 그대로 신뢰하며 자체 임계값 판정을 하지 않는다.
- Sprint 0의 4개 intentional-red 계약은 `m4-server-contract.spec.ts` 일반 게이트로 승격했다. volume과
  completion 실응답도 각각 OpenAPI 키셋까지 검사한다.
- `analytics-determinism.spec.ts`는 고정 source fact를 정방향/역방향으로 DB에 넣은 두 API 응답의
  `JSON.stringify`가 바이트 단위로 같음을 검증한다. 같은 수행값 수정 뒤 targeted recompute와 파생 테이블
  삭제 후 full rebuild의 정렬된 e1RM/주간 부하 행도 바이트 단위로 같다.
- 데이터가 있던 로컬 `afc`에서 migration과 backfill을 실제 실행했다. 원본 performed set 12행에서
  `estimated_1rm` 3행·`muscle_weekly_load` 3행을 재생성했고, 레거시 program 1행은 `started_at` non-null,
  `total_weeks=12`, `generation_input IS NULL`을 유지했다. 세션은 기존 7행 그대로라 12주 사전 생성이 없었다.
- 웹은 gate로 null이 된 추천값을 운동 종류 판별에 쓰지 않는다. 카탈로그 `step_kg=null`만 자체중량이고,
  외부 부하 운동의 gated null은 무게 입력이 필요한 `unknown_weight`다. 완료했지만 계획세트를 남긴 서버
  `partial` 상태는 “오늘 수행한 운동”과 읽기 전용 부분 완료 배지로 표시하며 다시 시작 CTA로 되돌리지 않는다.

## 12. Sprint 3 클라이언트 read-through 계약 — D-50~D-52

| 결정 | 확정 내용 |
|---|---|
| D-50 | Dexie에는 전체 수행 이력을 복제하지 않고 **성공적으로 조회한 서버 응답 범위만** user-scoped snapshot으로 저장한다. e1RM·volume·completion 조회는 최대 12주로 제한하고, 종류별 최근 접근 상한은 dashboard 1, e1RM 8, volume 4, completion 4, history session detail 48이다. 상한을 넘으면 가장 오래 동기화한 snapshot부터 같은 IndexedDB transaction에서 제거한다. |
| D-51 | transport offline일 때 snapshot이 있으면 마지막 서버 데이터와 `synced_at`을 `stale`로 반환한다. snapshot이 없으면 오프라인 빈 상태다. HTTP 4xx/5xx, 요청 취소, JSON/계약 오류는 stale fallback으로 숨기지 않는다. 화면은 `마지막 동기화 HH:mm 기준`을 표시하고 미동기화 outbox가 집계에 포함된 것처럼 가장하지 않는다. |
| D-52 | read-model mirror는 **서버 snapshot 전용**이며 로컬 draft/outbox를 합성해 쓰는 API를 제공하지 않는다. cached `gate_state`와 nullable 값은 서버가 적용한 그대로 보존한다. 온라인 응답은 mirror보다 항상 권위 있고, 늦게 끝난 오래된 동일-key 요청은 먼저 시작한 시각 비교로 더 최신 요청의 snapshot을 덮지 않는다. 오프라인 provisional 집계를 Sprint 4에서 추가할 필요가 생기면 공용 `display-gate.ts`를 별도 표시층에서만 쓰며 서버 snapshot 도착 시 교체한다. |

저장량은 사용자당 최대 65개 read-model snapshot으로 유계다. 세션 로깅의 drafts/outbox/session mirror와
테이블을 분리하므로 analytics 정리 작업이 미전송 운동 기록을 삭제할 수 없다. CacheStorage에는 `/v1/**`를
넣지 않는 ADR-58 경계도 유지한다.
