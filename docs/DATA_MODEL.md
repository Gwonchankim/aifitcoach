# 데이터 모델 (핵심 엔티티)

PostgreSQL 단일 주 저장소. 관계 무결성 + 유연 필드(JSONB) + 시계열형 로그 인덱싱.
아래는 요약 DDL. Prisma 스키마로 옮길 때 이 구조를 따른다.

```
users(id uuid PK, sex, birth_year int, height_cm num, weight_kg num, body_fat_pct num NULL,
      goal enum, experience_level enum, constraints jsonb, created_at, updated_at)
consents(id PK, user_id FK, type, version, granted bool, granted_at)
programs(id PK, user_id FK, goal, days_per_week int, minutes_per_day int, split_type,
      rules_version, template jsonb, excluded_exercises jsonb, created_at, updated_at)
      -- template = 생성 시점의 주간 템플릿(openapi Program.sessions). 세션 편집(F5)은 세션 스코프라 여기 반영되지 않는다.
      -- excluded_exercises = pain_areas 로 뺀 운동과 사유(openapi Program.excluded_exercises, SAFETY_PAIN_MAPPING.md 규칙 3)
exercises(id PK, name_ko, name_en, movement_pattern, mechanic, region,
      primary_muscles text[], secondary_muscles text[], equipment, difficulty,
      metric, default_reps_low int NULL, default_reps_high int NULL,
      default_time_low_sec int NULL, default_time_high_sec int NULL, default_step_kg num NULL,
      unilateral bool, substitutions text[], cues text[], media jsonb)   -- 시드: specs/exercises_seed.json
      -- metric=reps 는 default_reps_*, metric=time(e_plank)은 default_time_*_sec 를 채운다(배타적)
      -- default_step_kg NULL = 맨몸(자체중량). 0 이 아니다 — 0 은 엔진에서 INVALID_INPUT 이다.
workout_sessions(id PK, program_id FK, scheduled_date date, status, focus text, completed_at,
      session_feedback jsonb, updated_at)   -- focus: openapi Program.sessions[].focus / DashboardSummary
planned_sets(id PK, session_id FK, exercise_id FK, set_no int, order_index int,
      target_reps_low int NULL, target_reps_high int NULL, target_rir int NULL, rest_sec int,
      target_time_low_sec int NULL, target_time_high_sec int NULL,
      recommended_weight num NULL, recommended_reps int NULL,
      reason_code text, confidence num, rules_version, updated_at)
      -- set_no = 운동 내 세트 번호(FEATURES_UX "세트 = 운동 × set_no"), order_index = 세션 내 운동 순서(F5 추가/교체 position)
      -- recommended_weight NULL = 자체중량(맨몸·시간 종목). metric=time 은 반복·RIR 축이 없어 target_reps_*/target_rir 가 NULL 이고 target_time_*_sec 를 쓴다.
performed_sets(id PK, planned_set_id FK, actual_weight num NULL, actual_reps int NULL,
      actual_rir int NULL, actual_time_sec int NULL, pain_score int NULL, completed bool,
      client_id uuid UNIQUE, performed_at, updated_at)   -- client_id = 멱등 키
      -- metric=reps 는 actual_weight/actual_reps, metric=time 은 actual_time_sec 를 채운다(배타적)
estimated_1rm(user_id, exercise_id, e1rm num, method, computed_at,
      PRIMARY KEY(user_id, exercise_id, computed_at))
muscle_weekly_load(user_id, week_start date, muscle, hard_sets int, volume_load num,
      avg_rir num, PRIMARY KEY(user_id, week_start, muscle))
subscriptions(user_id PK, tier, provider, billing_key_ref, status,
      started_at, renews_at, trial_ends_at, updated_at)
sync_mutations(id uuid PK, user_id, entity_type, entity_id, op, payload jsonb,
      client_updated_at, applied_at, status)
-- RIR 캘리브레이션(P1)
user_rir_calibration(user_id PK, bias_overall num, bias_by_region jsonb,
      confidence num, samples int, last_calibrated_at, status)  -- not_started|in_progress|graduated|stale
calibration_set(id PK, user_id, exercise_id, session_day, predicted_rir int,
      amrap_extra_reps int, actual_rir int, bias_sample num, created_at)
```

## 인덱스
```
CREATE UNIQUE INDEX ux_performed_client ON performed_sets(client_id);
-- performed_sets 는 가장 빨리 커지는 테이블이고 조회는 항상 planned_set_id 로 들어온다
-- (historyFor / 세션 완료 / 루틴 편집의 수행기록 가드). 없으면 전부 Seq Scan 이다.
CREATE INDEX ix_performed_planned ON performed_sets(planned_set_id);
CREATE INDEX ix_planned_session ON planned_sets(session_id);
-- 한 세션에 같은 운동 중복 금지(F5 편집의 동시 요청 가드). planned_sets 는 "세트 1행"이라 set_no 를 포함한다.
CREATE UNIQUE INDEX ux_planned_session_exercise_set ON planned_sets(session_id, exercise_id, set_no);
CREATE INDEX ix_sessions_prog_date ON workout_sessions(program_id, scheduled_date);
-- 프로그램 조회(GET /programs/current)와 테넌시 경계는 전부 user_id 를 탄다.
CREATE INDEX ix_programs_user ON programs(user_id);
CREATE INDEX ix_e1rm_user_ex ON estimated_1rm(user_id, exercise_id, computed_at DESC);
CREATE INDEX ix_mwl_user_week ON muscle_weekly_load(user_id, week_start);
```

## 데일리 루틴·부분 수행 (FEATURES_UX.md)
- 데일리 루틴 = workout_sessions 1개. planned_sets를 세션 스코프로 add/remove/swap 가능(오늘 루틴 편집).
- 부분 수행: 완료 체크된 세트만 performed_sets 생성. 세션은 부분이어도 completed 가능.
- 휴식 추천값은 planned_sets.rest_sec. 휴식 타이머 증가/종료는 클라이언트 UI 상태(미저장).

## 민감정보
- body_fat_pct·pain_score·문진 등 건강 민감정보는 애플리케이션/컬럼 암호화 + 접근 감사 로깅(SECURITY_PIPA.md).
- 구현(ADR-16): `users.body_fat_pct`·`performed_sets.pain_score`는 **text 컬럼에 `v1:iv:tag:ciphertext`(AES-256-GCM)** 로 저장하고,
  `workout_sessions.session_feedback`의 `pain` 값도 같은 형식으로 암호화한다. 암복호는 서비스 레이어 한 곳에서만 한다.
  → 이 필드로는 DB 정렬·범위검색·집계가 불가능하다(디로드 "통증↑" 신호는 앱 레이어 계산, 범위 검증은 DTO).
