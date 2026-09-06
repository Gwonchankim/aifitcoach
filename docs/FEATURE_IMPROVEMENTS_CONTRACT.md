# 기능개선 계약 — 예약 API·세션 편집·분할·V2 전환

승인: 2026-09-05 사용자 사양 개정1·2 및 독립 Evaluator의 Sprint01 재시작1 계약 합의. ADR-73.

**이 문서는 후속 구현의 계약이다. 새 endpoint·sync entity·프로필 필드는 아직 runtime에 없다.**
활성 API는 [openapi.yaml](specs/openapi.yaml), 예약 wire는 [feature-improvements.openapi.yaml](specs/feature-improvements.openapi.yaml), 예약 정책 fixture는 [feature_improvements_contract.json](specs/feature_improvements_contract.json)이다.
기존 추천 golden과 활성 `.08.1` runtime은 바꾸지 않는다. future 계약 검증은 future 기능의 실행 성공 증거가 아니다.

| 범위 | 구현 소유 | 이번 기준선 산출물 |
| --- | --- | --- |
| 위치 복원·세션 append | Sprint03 | source/mapping/guard/실패/복사/rollback 계약 |
| 실제 주 projection·swap·split | Sprint04 | 예약 API·프리퍼런스·경합/회복 계약 |
| CARDIO 기준 | Sprint04 첫 독립 slice, ticket10 | 아래 승인·freeze 선행 경계만 확정 |
| 전체 `.09.1` 활성화 | Sprint05 | forward-only, 구버전 reader 및 주 경계 동의 계약 |

## Wire·저장·배포 경계

- 예약 append: `POST /sessions/{id}/sets`; `client_id`, `exercise_id`, `correlation_id`, `source`를 받는다. source는 서버 planned ID+opaque source_revision 또는 미적용 parent correlation 중 정확히 하나다. 성공201은 client ID·session ID·correlation·server planned ID·권위 planned row와 source_revision을 반환한다.
- 예약 `/sync` entity `session_set`은 append 전용이다. `op=upsert`, `entity_id=session_id`, payload는 append source/exercise/correlation이며 client_id는 기존 mutation UUID다. 기존 entity/payload와 LWW/cursor 의미는 보존한다. append는 additive idempotent 처리이며 오래된 full snapshot의 LWW로 새 행을 덮지 않는다. 직접 endpoint와 동일 처리기를 호출하고 `Idempotency-Key` 헤더를 새로 도입하지 않는다.
- UUID/payload/source/result/tombstone은 기존 `SyncMutation`의 owner-scoped ledger에 기록한다. 해당 planned row 삭제 후에도 replay가 소멸/부활하지 않게 한다. audit에 건강값을 새로 복제하지 않는다. session 삭제/사용자 삭제 시 기존 purge 경계는 후속 구현에서 정합 검증하며 개인정보 정책을 이번에 변경하지 않는다.
- append의 source_revision은 raw 처방 필드의 canonical hash이며 응답 시 파생한다. 숨겨진 추천값을 클라이언트가 역산하지 않고 이 opaque token만 mirror에 보관한다. current-week revision도 aggregate 파생이며 Prisma revision column을 추측해서 추가하지 않는다.
- split: User에 nullable `splitPreference`(wire `split_preference`)를 additive 도입하고 기존 사용자 행은 null/legacy 의미를 유지한다. 새 Program의 `generation_input` JSON에 requested/effective preference를 snapshot하고 `Program.split_preference_snapshot`으로 표시한다. 기존 프로그램은 missing snapshot을 `applicable=false`, `reason=legacy_input`으로 해석하며 현재 프로필을 소급 대입하지 않는다.
- nullable 필드의 신규 migration/default와 profile/generate/Program wire/codegen/DTO/readers를 Sprint04 동일 기능 commit에서 승격한다. old client가 optional preference를 생략해도 기존 입력은 계속 유효하다. generation request의 explicit invalid preference만400이며 기존 프로필 값을 몰래 적용해 프로그램 생성을 깨지 않는다.
- planned unique `(session_id,exercise_id,set_no)`와 correlation UNIQUE는 유지한다. session date는 기존 index이며 이번 Sprint에서 소급 UNIQUE migration을 만들지 않는다. 잠금/duplicate detection이 편집 및 lazy 생성 경계를 보장해야 한다.
- rollback: 아직 활성화 전이면 해당 기능 writer/UI를 되돌리되 additive 저장값을 destructive drop/backfill하지 않는다. 이미 새 snapshot/append가 생겼다면 reader/idempotency/tombstone 지원을 유지한다. 사용자가 완료한 기록을 feature rollback으로 삭제하지 않는다.
- 예약 paths/components는 각 소유 Sprint의 서버/프론트/schema/migration/tests와 함께 활성 openapi로 옮긴다. 그때 codegen을 같이 커밋한다. dummy route나 active route 테스트 제외 목록으로 앞서 공개하지 않는다.
- 기존 AUTH_MODE·cookie·CSRF·PIPA·payment 및 assistance sign/load direction/safety predicate는 범위 밖이다. 새 개인정보 정책이 필요한 후속 작업은 Planner로 올린다.
# 상세 경계

아래 세부 규칙은 위 assertion의 일부다. 예약 OpenAPI와 docs 산출물도 같은 의미를 운반해야 한다.

## C03 — 사용자 대안 C 및 Planner M1/M2/M3 반영

승인 근거: 2026-09-05 사용자 사양 개정1·2 및 Planner 티켓06·10. 이전 저항일 수에 따른 goal별 N/A 제안은 폐기됐다. 모든 goal에서 4·5일 운동일 모두가 실제 upper/lower 저항 초점을 가진다.

### 새 composition (문자열은 운동일 순서의 확정 tie-break)

C만 H로 전환하며 기존 S/H 슬롯의 유산소 처방은 유지한다. 아래 2·3·6일 구성은 기존 §2.3 그대로이고 경량 split 선호는 N/A다. 4·5일 구성은 모든 preference에서 동일하고 저항 focus 배열만 달라진다.

| goal | 2일 | 3일 | 4일 | 5일 | 6일 |
| --- | --- | --- | --- | --- | --- |
| diet | HH | HHC | HHHH | HHHHH | HHCCCC |
| hypertrophy | SS | SSH | SSSH | SSSSH | SSSSHH |
| strength | SS | SSH | SSSH | SSSHH | SSSSHC |
| general_fitness | HH | HHC | SSHH | SSHHH | SSHHCC |
| endurance | HH | HHC | HHHH | HHHHH | HHCCCC |

| days | preference | focus 배열(운동일 순서) | 실제 주간 빈도 |
| --- | --- | --- | --- |
| 4 | balanced | upper, lower, upper, lower | 2:2 |
| 4 | upper_priority/lower_priority 명시 생성 요청 | 400, 4일은 균형만 지원 | 비적용 |
| 5 | balanced 또는 upper_priority | upper, lower, upper, lower, upper | 3:2 |
| 5 | lower_priority | lower, upper, lower, upper, lower | 2:3 |
| 2/3/6 | 생략 또는 balanced | 기존 일정 | N/A와 이유 |
| 2/3/6 | upper_priority/lower_priority 명시 생성 요청 | 400 | 비적용 |

- 5일 balanced는 **상3/하2 고정**이다. UI는 '균형(기본 상체3·하체2)'로 정확히 안내하며 주차마다 교대하거나 2.5:2.5로 표시하지 않는다. 명시 상체 우선과 비율은 같지만 선택한 preference 원문을 snapshot한다.
- V1과 개편 V2 모두 위 focus 표를 쓴다. 4일 요일 MON/TUE/THU/FRI, 5일 MON/TUE/WED/FRI/SAT로 현행 요일을 보존한다. 같은 부위 연속 운동일 간 최소48시간을 주 경계까지 검사한다. 이것은 제품 일정 규칙이며 의학적 절대 기준으로 표현하지 않는다.
- 매 4·5일 실제 세션에 해당 부위의 feasible non-core primary 저항운동을 최소1개·최소2 working sets 포함한다. core/유산소/빈 planned row만으로 focus를 충족했다고 세지 않는다. safety filter 뒤 해당 focus primary가 없으면 명시 생성 불가이며 다른 부위나 C로 조용히 대체하지 않는다.
- 요청 생략의 legacy 입력은 기존 해석을 유지한다. 새 생성은 effective preference와 requested preference를 generation_input에 snapshot하며 기존 Program/template/실제 세션에는 덮어쓰지 않는다. 프로필의 저장 preference가 새 days에서 지원되지 않으면 UI에서 적용 불가 이유와 balanced 선택을 제시하고, 생성 시 미지원 preference를 몰래 전달하지 않는다.

### 유산소 보존의 정량 계약과 현재 근거의 한계

현행 저장소에는 아직 cardio generator가 없다. `PROGRAM_V2_CONTRACT`는 S/C/H와 RPE 척도는 확정하지만 goal×minutes별 steady 초·interval work/recovery/round 수를 정의하지 않는다. 기존 `V2-CARDIO-01` 티켓도 숫자표가 아닌 선행 구현 티켓이다. 따라서 없는 과거 유산소 분수를 사실로 만들거나 '용량 보존 검증 완료'로 쓰지 않는다.

이 Sprint에서는 **유산소 처방을 만드는 수식** 대신 **개편이 그 처방을 보존하는 계약**을 잠근다. donor는 동일 goal/days/minutes/readiness/history에 대해 별도 CARDIO 계약으로 승인될 개편 전 §2.3 슬롯의 처방이다. CARDIO 숫자 계약과 oracle 없이는 Sprint04/05의 유산소 보존·activation 게이트를 통과할 수 없다. 소유와 동결은 [ticket10 CARDIO-CONTRACT-BASELINE](FEATURE_IMPROVEMENTS_CONTRACT.md#유산소-보존의-정량-계약과-현재-근거의-한계)으로 확정한다.

- 소유: Sprint04의 첫 독립 slice. cardio/새 packer 제품 코드 전에 docs+golden만의 전용 commit SHA를 동결하고 Evaluator가 승인한다.
- 기존 authoritative 문서의 기계적 전사는 Evaluator 승인. 새 수치·용량 감소·생성 불가 범위 확대는 Planner→사용자 승인이 필요하다. 미확정 수치를 기존 사실로 쓰지 않는다.
- 실행 순서: **baseline 계약/fixture SHA freeze → 기존 PLAN-02 전제 구현 → cardio generator/wire → split composition+packer → `.09.1` 전체 원자 activation**. 제품 경로의 기존 PLAN02→CARDIO 의존은 유지한다. 사전 문서/fixture 동결만 PLAN02보다 앞이다.
- 새 packer 결과에 맞춰 donor를 사후 축소하지 않는다. 기준 변경은 새 승인과 freeze SHA가 필요하며 그 변경이 비교를 무효화하는 영향도 기록한다.
- Sprint01은 이 선행 소유/순서/승인 경계와 예약 계약을 확정하고, 아직 없는 numeric oracle이나 실제 용량 보존 실행을 완료로 주장하지 않는다.

1. 옛 H/C 슬롯의 cardio block을 같은 운동일의 새 H 슬롯으로 **1:1 운반**한다. 블록 삭제/시간 축소/숨김 추가시간/목표간 donor 공유 금지. 순수 S 슬롯에는 cardio를 새로 만들지 않는다.
2. 순서와 타입을 포함한 block descriptor `(kind, duration_sec, rpe_scale_id, target_rpe_low/high, work_sec, recovery_sec, rounds, long_session_flag, progression_axis)`가 old/new exact 동일해야 한다. 해당 kind에 없는 필드는 null이다. interval 총시간은 실제 work/recovery 포함 명시 timeline의 합이며 마지막 recovery 생략 여부도 descriptor에 고정한다.
3. 각 goal·날짜의 cardio 총초, 주간 총초, 강도별 총초, interval work 총초, interval 횟수, long-session 총초의 **new−old=0**을 검사한다. block ID와 세션 용기 ID만 비교에서 제외한다. diet와 endurance는 같은 H 문자여도 각자 donor와 비교한다. hypertrophy/strength 기존 H의 short steady를 임의 HIIT로 바꾸지 않는다.
4. 개편 전 동일 입력에 원래 정책의 자격/회복 fallback을 적용한 baseline descriptor를 **새 composition 실행 전에 고정**한다. 개편으로 새로 발생하는 fallback 결과로 baseline을 다시 쓰지 않는다. 새 focus 때문에 interval→steady 등 필수 descriptor/용량이 달라지면 원래 baseline 대비 보존 실패이며 명시 생성 불가다. diff 공개만으로 통과시키지 않는다. shortfall은 별도 Planner→사용자 승인 없이는 허용하지 않는다. 원래 fallback과 개편 유발 fallback은 각각의 원인과 원래 baseline 대비 차이를 기록하며 자격/가드레일은 낮추지 않는다.
5. donor 총초는 `additional_fixed_block_sec`에 전부 포함하고 warmup/cooldown은 중복하지 않는다. 4·5일 각 세션은 기존 estimator+working set cap 8/12/16/20/24를 동시에 만족한다. 저항은 기존 packer가 3→2로 줄이며 donor는 자동으로 줄이지 않는다.
6. `T_min = estimateSessionSeconds(primary 2 sets, all mandatory cardio blocks)`가 예산보다 크면 해당 입력을 `insufficient_time_for_mixed_focus`로 명시 거절하며 program/session을 부분 생성하지 않는다. 기간을 늘리거나 cardio를 줄이는 제품 결정을 숨겨서 하지 않는다. 예: 30분·diet·양측 primary reps_high12·rest90·cardio15분이면 480+300+96+90+900=1866초로 불가능하다. 이 예는 **시간 경계 fixture**이며 현재 실제 cardio15분 처방의 존재를 주장하지 않는다.
7. Sprint01은 예약 composition/보존 규칙 fixture 및 parse/ref 검증을 만든다. Sprint04는 실제 CARDIO oracle이 고정된 후 goal×days×preference×minutes×experience×pain matrix의 가능/불가능 목록·동일 descriptor 증거·RED→GREEN·cap/시간 mutation을 제출한다. 불가능 조합을 통과율 계산에서 몰래 제외하거나 모든 실패를 빈 성공 프로그램으로 처리하면 불합격이다.

### Rules·원천 문서·전환

- composition 의미가 바뀌므로 기존 `2026.09.0` 의미를 덮어쓰지 않는다. 이미 예약된 `2026.09.1`을 **개편 composition+split를 포함한 전체 V2 bundle**로 최종 활성화할 대상으로 정의한다. `.09.0`·V1 persisted snapshot 해석을 그대로 지원하고, `.09.1`을 V1 중간 단계의 이름으로 사용하지 않는다. 현재 runtime 상수/assistance version allowlist는 Sprint01에서 수정하지 않는다.
- `PROGRAM_V2_CONTRACT §2.3/§2.6`에 legacy 예약 `.09.0` 표와 개편 `.09.1` 표를 구분하고 이번 사용자 승인 근거·시간/cap/회복/failure 계약을 연결한다. composition/golden fixture를 개정해 두 의미를 구분한다. 기존 추천 수학 golden은 약화하거나 새 composition로 소급 교체하지 않는다.
- activation은 모든 V2 필수 구성·CARDIO oracle·gate·offline mirror·migration notice/동의·주 경계 전환을 검증한 뒤 Sprint05에서 단 한 번 수행한다. 원천대로 동의 후 다음 월요일에 새 Program을 선택하며 기존 Program·실제 기록은 보존한다. 미래 lazy 주 생성도 그 Program의 rules/input을 사용한다.

## W — 현재 주 조회와 swap 원자성

- W06: 일회성 대체는 사용자가 명시적으로 선택하는 보조 모드이며 주간 볼륨 보존을 약속하지 않는다. 기존 운동 단위 편집 경계를 재사용한다. 실제 두 세션 swap이 불가능하거나 실패했다고 일회성 대체를 묵시적으로 실행하는 자동 fallback은 금지한다.
- 기존 `Program.sessions`는 immutable template 그대로다. 예약 `GET /programs/{id}/weeks/current`를 추가하여 UTC week_start, program_id, materialized actual sessions의 `id`, `scheduled_date`, `focus`, `status`, `revision`, `planned_set_ids`, 운동별 planned count를 반환한다. 이번 주 lazy materialization 완료 후 같은 transaction snapshot에서 읽는다. 미래 preview는 기존 template 기반임을 표시하고 이 응답과 섞지 않는다.
- 예약 `POST /programs/{id}/week-swaps`: client_id, today_session_id, target_session_id, today_revision, target_revision. 응답은 두 세션의 새 id/date/focus/revision과 `today_session_id`(교환 전 target ID), week_start. 호출 당시 today였던 ID를 계속 오늘 경로로 사용하는 것을 금지한다.
- 프로그램 현재 주 화면은 actual-week projection, 대시보드와 세션 화면은 같은 실제 세션 데이터에 근거한다. 성공 시 current-week/dashboard/두 session query를 갱신하고 서버 `today_session_id`로 이동한다. cache invalidation만으로 template 표시를 고치는 구현은 불합격이다.
- revision은 세션 상태/date/focus/origin 및 ordered planned rows의 ID·updatedAt·목표·추천·안전 snapshot, performed 행의 ID·updatedAt·completed를 포함한 canonical aggregate hash의 opaque 토큰이다. 단순 WorkoutSession.updatedAt 하나로 대체하지 않는다. 서버 시작(in_progress)·planned 편집·수행 쓰기·다른 swap이 모두 토큰을 바꾼다.
- 최종 transaction 안에서 동일 프로그램의 lazy 생성/swap과 양쪽 세션의 모든 mutation이 같은 잠금 규약을 공유한다. 순서는 program 잠금 후 정렬된 session ID 잠금이다. 기존 mutation 경로도 이 규약에 연결하거나 동등한 serializable 재시도 증거를 내야 한다. hash 비교를 transaction 밖에서만 하는 것은 금지한다.
- 잠금 뒤 owner/program/week/date/origin/status=scheduled/미수행 및 요청 revision을 재검증한다. 과거·완료·in_progress와 performed row가 하나라도 있는 세션은 제외한다. 대상 날짜에 별도 actual 세션이 있으면 409이며 임의 선택/삭제/merge 금지다. 기존 DB에 중복 날짜가 있으면 backfill로 청소하지 않는다.
- **교환 후 회복 검사**: 이 새 swap operation은 V1/V2 모두에서 같은 부위 최소48시간을 후보 조회와 최종 transaction에 적용한다. 기존 persisted 계획의 해석/backfill을 변경하는 것이 아니라 새 편집의 허용조건이다. 각 프로그램의 실제 적용 bundle이 갖는 cardio/HIIT 회복 규약도 함께 검사한다.
- 검사 범위는 교환한 두 날짜 및 회복 간격에 영향을 주는 앞·뒤 주의 인접 실제 세션/저항/cardio 블록이다. 실제 세션이 있으면 template로 대체하지 않는다. 미생성 이웃은 그 Program의 persisted rules/input으로 preview를 산출해 구분하고, 안정적으로 판정할 수 없으면 fail-closed한다. 고정 template만의 검사로 actual 일정 변경을 숨기지 않는다.
- 후보는 `recovery_gap_violation` 사유와 함께 제외/비활성 표시한다. 최종 transaction은 program→정렬된 양쪽/관련 이웃 session 잠금 아래 최신 실제 일정과 revision/eligibility를 다시 읽어 검사한다. 동일 program의 lazy 생성과 모든 관련 session mutation도 이 규약을 사용하여 검사 후 상태가 바뀌는 경합을 막는다.
- 월U·화L·목U·금L에서 월↔금은 월L·화L·목U·금U가 되어 양 부위24h이므로 반드시409이며 양쪽 날짜/제품 데이터/planned/performed 전부 불변이다. 주내 통과/주경계 실패와 후보 조회 뒤 이웃 변경도 별도 회귀 assertion이다. 허용 swap은 실제 인접 간격>=48h와 해당 cardio 회복을 모두 증명한다.
- 두 날짜 교환과 idempotency 응답 저장을 한 transaction으로 commit한다. 동일 client_id+동일 body는 최초 결과를 재생하고 다시 교환하지 않는다. 같은 ID+다른 body는409. 동시 다른 swap은 한 번만 승인되고 stale 요청409. lazy 생성은 날짜 존재 확인과 생성이 같은 program 잠금을 사용해 duplicate 생성하지 않는다.
- 검증은 양쪽 Session ID, 각 PlannedSet ID·내용, PerformedSet ID·내용, 주간 세션 수, 운동별 set-count/target volume multiset이 before/after exact 동일이고 제품 데이터 중 scheduled_date 두 개만 교환됨을 증명한다. Session.updatedAt 및 날짜/시각 변경에 따라 파생된 revision은 예상 기술 메타데이터 변경으로 별도 기록한다. 모든 planned/performed 내용·ID는 이 예외에 포함하지 않는다. 모든 경합 실패는 양쪽 모두 미변경이다. 완료 history와 program.template/generation_input도 byte/semantic hash 불변이다.

## A — append source·복사·재전송

- A10: 추가 세트는 당일 요약·실제 수행 projection에 포함하고, 완료한 기록은 동일 운동 추천의 완료 history에 정상 포함한다. 추가 행이나 세트 수를 program.template/generation_input 및 다음 회차 기본 세트 수에 전파하지 않는다. 완료 history를 추천 입력으로 쓰는 것과 프로그램 기본 세트 수를 바꾸는 것은 별개다.
- 예약 POST 두 개는 기존 `CsrfHeader` required 계약을 그대로 참조한다. 모든 오류 응답의 표준 schema는 공통 `Error`의 직접 참조를 유지한다. 409의 `x-afc-response-refinement`는 추가로 반드시 검증할 `FeatureConflict` body schema이며 `code=CONFLICT`와 허용된 `details.reason`을 제한한다. 이는 OpenAPI 도구가 자동 적용하는 키가 아니므로, 소유 Sprint의 승격 시 해당 ref와 공통 Error를 함께 검사하는 실제 응답 테스트를 추가해야 한다. 필수 헤더·공통 오류 ref 검사나 refinement를 없애 승격시키지 않는다.
- 새 append 경로에만 UTC 오늘 guard를 적용한다. 기존 add/remove/swap-exercise의 assertEditable 날짜 정책은 이 티켓에서 넓히거나 좁히지 않는다. 당일 completed는 기존 완료 상태를 유지하며 실제 세트 입력 후 기존 projection 규약을 사용한다.
- 클릭 당시 같은 운동 중 최대 set_no 행을 source로 선택한다(완료 여부는 선택 순서를 바꾸지 않음). request는 source_planned_set_id와 source_revision을 보낸다. source_revision은 source의 immutable/처방 필드 hash로 서버가 응답하고 mirror가 보관한다. 서버는 source가 여전히 해당 session/exercise에 존재하고 해당 처방 revision이 같은지 확인한다. 먼저 다른 append가 진행되어 더 큰 번호가 생겨도 기존 source가 유효하면 허용한다.
- provisional 운동/세트의 source는 기존 correlation UUID로 참조 가능하며 /sync 적용 순서는 session_routine 생성 → append → performed_set → session 완료다. parent correlation이 해결되지 않으면 dependent append는 conflict/pending으로 남고 actual mutation을 먼저 적용하지 않는다.
- 서버는 잠금 뒤 기존 번호가 정확히 1..N 연속인지 확인한다. gap/중복/범위밖은409, 재번호화 금지. N<10이면 N+1 append. N=9에서 서로 다른 두 요청은 한 성공(set10)과 한409이고 N=8이면 set9/10 각각 한 행이다. 같은 UUID는 어느 cap에서도 추가 행을 만들지 않는다.

| 필드 | 복사/검증 규칙 |
| --- | --- |
| source ID / new ID / correlation / set_no | source는 참조만, 새 server ID 발급, client correlation 보존, 현재 max+1 |
| session_id / exercise_id / order_index | 같은 운동 source 값, 다른 세션/운동 요청404 또는 correlation mismatch409 |
| target_reps_low/high / target_time_low/high / target_rir / rest_sec | source raw snapshot 그대로; reps/time 배타성과 기존 범위 검증; 현재 카탈로그 기본값으로 교체 금지 |
| recommended_weight / recommended_reps / reason_code / confidence / rules_version | source raw 그대로, engine 재실행/actual 값 차용 금지. server 응답에는 기존 display gate 재적용 |
| load_semantics / assistance_step_kg / assistance_provenance | source snapshot 그대로. native/remediated 유효 snapshot은 원래 provenance/version을 보존; remediation으로 가장하는 새 감사 이벤트/계산은 만들지 않음 |
| recommendation_state / load_kind / recommended_action / assistance_safety_status / recommendation_gate | DB 복제 필드가 아닌 기존 응답 파생 규칙 사용. raw 처방의 safety/error 상태를 ready/safe로 강제하지 않음 |
| performed_set 및 actual_*, pain, performed_at, completed | 생성하지 않음/복사 금지. 실제 RIR 빈칸과 목표 RIR 별도 유지 |
| updated_at | 신규 행 시각. source의 timestamp를 신규 쓰기 시각으로 사칭하지 않음 |

- assistance는 해당 운동 전체 snapshot의 semantics/version/provenance uniformity와 raw 안전 판정을 검사한다. 기존 native/remediated 모두 유효하며 원본·신규 미수행 복사본이 안전한 경우만 append 가능하다. legacy_performed 하나라도 있거나 missing/unknown metadata·혼합 cohort·unsafe면409이며 기존 행과 marker를 보존한다. performed 사실을 지워 legacy가 안전해지거나 카탈로그 metadata로 legacy를 native로 승격하는 것은 금지다. sign/load direction/safety predicate 코드는 수정하지 않는다.
- 오프라인 mirror에 숨겨진 raw 추천 값은 만들어내지 않는다. 표시된 값·null·gate/safety marker를 provisional에 보존하고 서버 mapping에서 권위 row로 교체한다. 충분한 source identity/safety snapshot이 없으면 추가 비활성과 이유를 표시한다.
- 로컬 생성 transaction: provisional row+correlation, routine/session mirror, append outbox를 함께 저장한 뒤 UI에 성공을 알린다. ack transaction은 별개다: 권위 mapping을 draft(동시 실제 입력 포함)·performed outbox references·mirror·화면 위치 correlation에 한 번에 적용하고 append outbox를 ack한다. 어느 transaction이 실패해도 절반 상태가 남지 않으며 재전송 가능하다.
- 서버 idempotency에는 owner+client UUID+정규화 payload hash+source identity+결과 planned ID를 보존한다. 같은 UUID/다른 payload409. 존재하는 성공 row의 재전송은 날짜나 cap이 바뀌어도 같은 mapping을 반환한다(새 append guard보다 기존 성공 replay 확인이 우선).
- 운동 삭제 전 미적용 append가 삭제 후 도착하면 source ID/correlation 소멸로409이며 운동을 부활시키지 않는다. 삭제 후 같은 exercise_id 재추가도 새 source identity이므로 지연 요청409. 이미 성공했던 append row가 삭제된 후 재전송되면 tombstone/mutation 결과로409 `append_target_removed`를 반환하고 새 row를 만들지 않는다. idempotency 기록은 세트 삭제 cascade로 소멸시키지 않는다. 과거 mapping을 다른 신규 행으로 연결하지 않는다.
- append와 remove/complete 경합은 위 공통 잠금에서 결정한다. 당일 complete 뒤 append는 허용되므로 양 순서 모두 완료 시각/기록을 보존한다. 과거로 날짜가 바뀌거나 source가 사라진 경우409. 실패 시 draft/actual 입력을 버리지 않고 conflict 복구 대상으로 보존한다.

## R — 복원 계약 (Sprint03 소유)

- R01: principal+session별 마지막 명시 상호작용 exercise/planned-set ID 또는 correlation과 완료행 expanded 상태를 기존 syncMeta의 별도 namespace/value-version에 durable 저장한다. 새 Dexie schema/store·pixel scrollTop·미완료 입력 문자열 저장은 없다. input/focus·완료/취소·expanded toggle·append 성공만 위치를 갱신한다.
- R02: hydrate 후 유효한 마지막 행으로 한 번 이동한다. 삭제된 행은 같은 운동 첫 미완료→세션 첫 미완료→세션 요약 순서로 결정론적 fallback하며 다른 세션 위치를 재사용하지 않는다. 성공 종료는 position을 정리하고 summary가 기본이며 당일 명시 edit/append 진입에서 새 위치를 기록한다. loading/error를 authoritative empty로 오인하지 않는다.
- R03: provisional→server mapping ack transaction에서 위치 correlation도 함께 승격한다. late position/timer write는 alias를 확인한다. 삭제된 completed draft/old alias만으로 membership를 인정하지 않는다. draft/타이머는 기존 durable 저장 경계를 재사용하고 타이머 종료시각·실제 수행값을 위치 복원으로 덮지 않는다.
- R04: future swap 후 오늘 이동은 서버 today_session_id를 따르고 각 session의 저장 위치를 따로 유지한다. 현재 위치 기능이 swap API를 활성화하지 않는다. 사용자가 조작한 뒤 늦은 hydrate/ACK/refetch로 focus·화면을 반복해서 빼앗지 않는다.
- R05: 360~430px·keyboard/assistive focus·error/loading/removed-source·offline 재진입을 실제 React wiring/E2E에서 검증한다. helper-only 성공을 복원 완료로 보지 않는다.
- R06: 실제40초 background/route/reload와 소유 persistent origin/storage의 새 process 복원을 검사한다. 빈 isolated context는 별도 안전 fallback이다. IndexedDB snapshot 이식은 process 내구성 증거가 아니며 강제 종료 보장은 관측된 durable commit 뒤에 한정한다. 상세는 [위치 계약](SESSION_POSITION.md), ADR-76이다.
