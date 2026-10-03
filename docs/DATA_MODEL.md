# 데이터 모델 (핵심 엔티티)

PostgreSQL 단일 주 저장소. 관계 무결성 + 유연 필드(JSONB) + 시계열형 로그 인덱싱.
아래는 요약 DDL. Prisma 스키마로 옮길 때 이 구조를 따른다.

```
users(id uuid PK, role user|admin DEFAULT user, sex, birth_year int, height_cm num, weight_kg num,
      body_fat_pct text NULL, goal enum, experience_level enum, split_preference enum NULL, constraints jsonb,
      deleted_at timestamptz NULL, created_at, updated_at)
consents(id PK, user_id FK, type, version, granted bool, granted_at)
auth_sessions(id uuid PK, user_id FK, session_token_hash UNIQUE, csrf_token_hash,
      created_at, last_seen_at, expires_at, revoked_at NULL)
      -- 원문 sid/CSRF 토큰은 저장하지 않고 해시만 저장한다. DELETE /me·logout은 revoked_at을 기록한다.
auth_attempts(id uuid PK, scope, bucket_hash, attempt_count, window_started_at,
      locked_until NULL, updated_at, UNIQUE(scope, bucket_hash))
      -- bucket_hash = 원문 IP 등의 HMAC. 원문 코드·IP는 보관하지 않는다.
access_audits(id uuid PK, user_id FK, action, metadata jsonb, occurred_at)
      -- metadata에는 건강정보·소유자 코드·원문 IP를 넣지 않는다.
programs(id PK, user_id FK, goal, days_per_week int, minutes_per_day int, split_type,
      rules_version, template jsonb, generation_input jsonb NULL, started_at date,
      total_weeks int DEFAULT 12, status active|completed, excluded_exercises jsonb, created_at, updated_at)
      -- template = 생성 시점의 주간 템플릿(openapi Program.sessions). 세션 편집(F5)은 세션 스코프라 여기 반영되지 않는다.
      -- 12주 세션을 사전 생성하지 않는다. started_at+오늘로 현재 주차를 계산하고 template/generation_input으로 가까운 주만 lazy 생성한다.
      -- 레거시 generation_input은 복구 불가능한 필드를 추측하지 않고 기존 template snapshot을 fallback으로 쓴다(D-37).
      -- excluded_exercises = pain_areas 로 뺀 운동과 사유(openapi Program.excluded_exercises, SAFETY_PAIN_MAPPING.md 규칙 3)
      --   추가로 **제외가 0건인 부위도 마커 항목으로 저장**한다(exercise_id·movement_pattern 을 빈 문자열로).
      --   이유: 통증 부위를 따로 저장하지 않으므로(PIPA) 즉석 세션이 이 필드에서 부위를 역산하는데,
      --   wrist 처럼 제외 패턴이 0건인 부위는 흔적이 안 남아 "머신/케이블 우선" 배려가 사라졌다.
      --   마커는 **저장 전용**이고 toResponse()에서 걸러낸다(계약상 excluded_exercises 는 "제외된 운동 목록"이다).
exercises(id PK, name_ko, name_en, modality NULL, movement_pattern NULL, mechanic NULL, region NULL,
      primary_muscles text[], secondary_muscles text[], equipment, difficulty,
      metric, default_reps_low int NULL, default_reps_high int NULL,
      default_time_low_sec int NULL, default_time_high_sec int NULL, default_step_kg num NULL,
      unilateral bool, substitutions text[], cues text[], media jsonb)   -- 시드: specs/exercises_seed.json
      -- metric=reps 는 default_reps_*, metric=time(e_plank)은 default_time_*_sec 를 채운다(배타적)
      -- default_step_kg NULL = 맨몸(자체중량). 0 이 아니다 — 0 은 엔진에서 INVALID_INPUT 이다.
workout_sessions(id PK, program_id FK, scheduled_date date, status, focus text, origin, completed_at,
      session_feedback jsonb, updated_at)   -- focus: openapi Program.sessions[].focus / DashboardSummary
      -- origin: planned | ad_hoc (기본 planned). ad_hoc = 휴식일 즉석 세션(F8-1, POST /sessions/ad-hoc).
      --   스트릭의 "계획된 날"과 weekly_completion_rate(계획 준수율)는 planned 만 센다 —
      --   계획에 없던 운동을 시도한 것이 지표를 깎으면 안 된다. API 응답에는 노출하지 않는다.
planned_sets(id PK, session_id FK, exercise_id FK, set_no int, order_index int,
      target_reps_low int NULL, target_reps_high int NULL, target_rir int NULL, rest_sec int,
      target_time_low_sec int NULL, target_time_high_sec int NULL,
      recommended_weight num NULL, recommended_reps int NULL,
      reason_code text, confidence num, rules_version, updated_at)
      -- set_no = 운동 내 세트 번호(FEATURES_UX "세트 = 운동 × set_no"), order_index = 세션 내 운동 순서(F5 추가/교체 position)
      -- recommended_weight NULL = 자체중량(맨몸·시간 종목). metric=time 은 반복·RIR 축이 없어 target_reps_*/target_rir 가 NULL 이고 target_time_*_sec 를 쓴다.
performed_sets(id PK, planned_set_id FK, actual_weight num NULL, actual_reps int NULL,
      actual_rir int NULL, actual_time_sec int NULL, pain_score int NULL, completed bool,
      client_id uuid UNIQUE, performed_at, updated_at,
      UNIQUE(planned_set_id))   -- client_id = 최초 생성 mutation, 논리 ID = planned_set_id
      -- metric=reps 는 actual_weight/actual_reps, metric=time 은 actual_time_sec 를 채운다(배타적)
estimated_1rm(user_id, exercise_id, session_id FK, e1rm num, method, computed_at,
      PRIMARY KEY(user_id, exercise_id, session_id))
muscle_weekly_load(user_id, week_start date, muscle, hard_sets int, volume_load num,
      avg_rir num NULL, updated_at, PRIMARY KEY(user_id, week_start, muscle))
subscriptions(user_id PK, tier, provider, billing_key_ref, status,
      started_at, renews_at, trial_ends_at, updated_at)
sync_mutations(id uuid PK, server_seq bigserial UNIQUE, user_id, entity_type, entity_id, op,
      payload jsonb, client_updated_at, applied_at, status)
      -- id = mutation client_id, server_seq = 누락 없는 pull cursor 순서
      -- 공개 entity_type = performed_set | session_routine | session. profile은 ADR-33으로 미지원.
-- RIR 캘리브레이션(P1)
user_rir_calibration(user_id PK, bias_overall num, bias_by_region jsonb,
      confidence num, samples int, last_calibrated_at, status)  -- not_started|in_progress|graduated|stale
calibration_set(id PK, user_id, exercise_id, session_day, predicted_rir int,
      amrap_extra_reps int, actual_rir int, bias_sample num, created_at)
```

## Exercise domain 기반 (T06 S1)

`Exercise.modality`는 nullable `resistance | cardio | mobility | warmup`이다. 기존 canonical 110 ID만 명시 목록으로 resistance backfill한다. DB에 목록 밖 ID가 있으면 migration은 명시 오류로 실패한다. `WHERE modality IS NULL` 갱신은 멱등이며 기존 종목 속성·Program/template·WorkoutSession·PlannedSet·PerformedSet은 변경하지 않는다. S1 seed는 110개 resistance만 포함하며 새 cardio 종목·장비 vocabulary는 S2 범위다.

| modality 분기 | mechanic / movement_pattern / region / load_semantics | default_reps / default_time / default_step | metric |
| --- | --- | --- | --- |
| NULL 또는 resistance | 기존 필수 non-null 조건 유지 | 기존 저항 종목 속성 유지 | 기존 reps/time (플랭크도 resistance) |
| cardio | 모두 NULL | 모두 NULL | time 필수 |
| mobility | 모두 NULL | 모두 NULL | 기존 reps/time enum 유지 |
| warmup | 모두 NULL | 모두 NULL | 기존 reps/time enum 유지 |

SQL `ck_exercise_domain`은 각 필수값에 `IS NOT NULL`을 사용해 CHECK의 UNKNOWN 통과를 막는다. 배포된 `20260912000000` migration이 제거한 `load_semantics` default는 복원하지 않는다. resistance writer는 명시 값을, non-resistance writer는 **명시 NULL**을 전달해야 한다. nullable 타입을 저항 planner에 넘기기 전 공통 narrowing guard로 분류를 검증한다. 미확인·모순 속성을 resistance로 추정하지 않는다.

Prisma `Goal`은 기존 세 값에 `general_fitness | endurance`를 additive로 추가한다. 내부 generation과 `Program.goal` 응답은 5종을 표현하지만 공개 GenerateProgramDto·Profile·UI 선택은 기존 3종이다. 활성 `.08.1` 포인터는 유지하며 S1이 신규 목표 공개 생성이나 `.09.1` 활성화를 의미하지 않는다.

## 인덱스
```
CREATE UNIQUE INDEX ux_performed_client ON performed_sets(client_id);
-- 조회 hot path와 다중 탭 중복 방지를 한 인덱스로 강제한다.
CREATE UNIQUE INDEX ux_performed_planned ON performed_sets(planned_set_id);
CREATE INDEX ix_planned_session ON planned_sets(session_id);
-- 한 세션에 같은 운동 중복 금지(F5 편집의 동시 요청 가드). planned_sets 는 "세트 1행"이라 set_no 를 포함한다.
CREATE UNIQUE INDEX ux_planned_session_exercise_set ON planned_sets(session_id, exercise_id, set_no);
CREATE INDEX ix_sessions_prog_date ON workout_sessions(program_id, scheduled_date);
-- 프로그램 조회(GET /programs/current)와 테넌시 경계는 전부 user_id 를 탄다.
CREATE INDEX ix_programs_user ON programs(user_id);
CREATE INDEX ix_e1rm_user_ex ON estimated_1rm(user_id, exercise_id, computed_at DESC);
CREATE INDEX ix_mwl_user_week ON muscle_weekly_load(user_id, week_start);
CREATE UNIQUE INDEX sync_mutations_server_seq_key ON sync_mutations(server_seq);
CREATE INDEX ix_sync_user_seq ON sync_mutations(user_id, server_seq);
CREATE UNIQUE INDEX ux_auth_sessions_token_hash ON auth_sessions(session_token_hash);
CREATE INDEX ix_auth_sessions_user_expires ON auth_sessions(user_id, expires_at);
CREATE UNIQUE INDEX ux_auth_attempts_scope_bucket ON auth_attempts(scope, bucket_hash);
CREATE INDEX ix_auth_attempts_locked_until ON auth_attempts(locked_until);
CREATE INDEX ix_access_audits_user_occurred ON access_audits(user_id, occurred_at DESC);
```

## 데일리 루틴·부분 수행 (FEATURES_UX.md)
- 데일리 루틴 = workout_sessions 1개. planned_sets를 세션 스코프로 add/remove/swap 가능(오늘 루틴 편집).
- 부분 수행: 완료 체크된 세트만 performed_sets 생성. 세션은 부분이어도 completed 가능.
- 휴식 추천값은 planned_sets.rest_sec. 휴식 타이머는 기존 IndexedDB syncMeta에 종료 절대시각/총 초/세트 identity를 저장하며 서버 planned 처방을 바꾸지 않는다.

## 로컬 세션 위치 (ADR-76)

기존 IndexedDB syncMeta의 별도 namespace/value-version에 principal+session별 active exercise/planned ID 또는 correlation 및 완료행 expanded 상태를 둔다. 새 Dexie store/schema 또는 Prisma 테이블을 만들지 않는다. 위치에는 scrollTop·건강값·미완료 입력 문자열을 넣지 않는다. ACK mapping은 위치·draft·timer alias와 같은 transaction에서 canonical ID를 적용하며, late write도 alias를 확인한다. 성공 완료 시 position을 정리하고 삭제 membership에 따른 fallback을 사용한다. [SESSION_POSITION.md](SESSION_POSITION.md)가 복원·새 process·빈 context의 검증 경계를 정의한다.

## 민감정보
- body_fat_pct·pain_score·문진 등 건강 민감정보는 애플리케이션/컬럼 암호화 + 접근 감사 로깅(SECURITY_PIPA.md).
- 구현(ADR-16): `users.body_fat_pct`·`performed_sets.pain_score`는 **text 컬럼에 `v1:iv:tag:ciphertext`(AES-256-GCM)** 로 저장하고,
  `workout_sessions.session_feedback`의 `pain` 값도 같은 형식으로 암호화한다. 암복호는 서비스 레이어 한 곳에서만 한다.
  → 이 필드로는 DB 정렬·범위검색·집계가 불가능하다(디로드 "통증↑" 신호는 앱 레이어 계산, 범위 검증은 DTO).

## 기능개선 예약 계약 (2026-09-05)

T05는 `week_swap_receipts(id, user_id FK RESTRICT, client_id, request_hash, request JSON, result JSON)`를 추가한다. `(user_id, client_id)`는 유일하며 테이블 자체가 week_swap operation namespace다. request는 정규화 5필드, result는 최초 WeekSwapResult 구조 식별자·날짜·status·origin·revision·운동/계획세트 ID·개수뿐이다. 처방·performed·건강값은 저장하지 않는다. 기존 session/planned/performed ID와 내용은 날짜 교환으로 바뀌지 않는다. 서버 sync receipt와 분리하며 owner 삭제는 기존 명시 cutoff 퍼지에 연결한다(사용자 리뷰 필요).

[기능개선 계약](FEATURE_IMPROVEMENTS_CONTRACT.md) 중 append와 T05 실제 주 조회/swap은 활성 스키마로 승격됐다. split snapshot·forward-only 전환은 각 소유 Sprint의 후속 계약이며 현재 runtime 지원 선언이 아니다.

### T06 S2 cardio 저장 경계

`Exercise.modality`는 `resistance | cardio | mobility | warmup | null`이다. 기존 110종은 resistance이며 S2는 `e_stationary_bike` 한 종만 추가한다. `equipment=stationary_bike`를 명시해야 하며 일반 `machine` 장비를 보유했다고 자전거를 보유한 것으로 추정하지 않는다. 자전거는 `metric=time`, 저항 분류·부하·기본 반복/시간/step이 모두 NULL이다. `cardio_movement_regions=[lower]`는 동작 분류이며 N07 저항 노출로 세지 않는다. `prescription_kinds_supported`와 `blocked_reported_pain_areas`는 승인된 종목 정책이며 사용자 건강 정보를 저장하지 않는다.

PlannedSet은 한 cardio 블록당 한 행이다. `prescription_kind`의 raw NULL은 기존 저항 행에만 허용한다. 기존 행을 backfill하지 않으며 V1 wire에 새 kind를 덧붙이지 않는다. 새 V2 writer는 `resistance | steady_cardio | interval_cardio`를 명시한다. 모든 descriptor 스칼라와 `source_day`(MON~SUN), `source_ordinal`(1부터), `intensity_seconds={moderate,high,recovery}`를 저장한다. `cardio_fallback`은 `{cause,source_day,source_ordinal,original_descriptor,effective_descriptor}`이며 cause는 `source_eligibility_fallback | redesign_recovery`이다.

| CHECK | 저항/legacy | steady | interval |
| --- | --- | --- | --- |
| kind payload | 기존 rest/reason/confidence/load NOT NULL 유지, 새 cardio 필드 NULL | 저항 필드 모두 NULL, descriptor·source·intensity 필수 | steady와 동일 |
| duration | 새 필드 NULL | 양수, interval 필드 NULL | work/recovery 양수, rounds 1~12, bigint 총초 일치, final recovery true |
| RPE | 새 필드 NULL | 고정 scale, 0≤low≤high≤10 | target와 recovery 양쪽 필수 |
| axis | 새 필드 NULL | duration_sec, long boolean | rounds, long false |
| intensity | NULL | moderate=duration, high/recovery=0 | high=work×rounds, recovery=recovery×rounds, moderate=0 |
| assistance | 기존 predicate·immutable trigger 그대로 | load/step/provenance 모두 NULL | 동일 |

모든 필수값은 `IS NOT NULL`로 검사한다. 다른 테이블을 조회하는 CHECK는 만들지 않으며 Exercise FK와 modality-kind 일치는 writer/reader가 검증한다. Program template·GET·sync·offline reader가 같은 union을 사용하고 cardio는 resistance Recommendation 객체나 rounds만큼의 working sets를 생성하지 않는다. 기존 저항 데이터 및 수행 기록은 migration에서 갱신하지 않는다.

## T06 S3 split preference

users.split_preference는 balanced/upper_priority/lower_priority의 nullable enum이며 additive migration에 기본값·backfill이 없다. Program.generation_input.split_preference_snapshot은 생성 시 고정된 요청·실효값과 실제 U/L 횟수를 담는다. Profile.split_preference_supported는 활성 규칙 묶음에서 파생하며 DB 컬럼이나 버전 문자열은 노출하지 않는다. 기존 Program의 missing snapshot은 읽기에서 legacy_input으로 파생하고 저장행을 수정하지 않는다. [6필드 의미](S3_SPLIT_PREFERENCE.md).
