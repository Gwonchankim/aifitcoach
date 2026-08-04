# 데이터 모델 (핵심 엔티티)

PostgreSQL 단일 주 저장소. 관계 무결성 + 유연 필드(JSONB) + 시계열형 로그 인덱싱.
아래는 요약 DDL. Prisma 스키마로 옮길 때 이 구조를 따른다.

```
users(id uuid PK, sex, birth_year int, height_cm num, weight_kg num, body_fat_pct num NULL,
      goal enum, experience_level enum, constraints jsonb, created_at, updated_at)
consents(id PK, user_id FK, type, version, granted bool, granted_at)
programs(id PK, user_id FK, goal, days_per_week int, minutes_per_day int, split_type,
      rules_version, created_at, updated_at)
exercises(id PK, name_ko, name_en, movement_pattern, mechanic, region,
      primary_muscles text[], secondary_muscles text[], equipment, difficulty,
      metric, default_reps_low int, default_reps_high int, default_step_kg num NULL,
      unilateral bool, substitutions text[], media jsonb)   -- 시드: specs/exercises_seed.json
workout_sessions(id PK, program_id FK, scheduled_date date, status, completed_at,
      session_feedback jsonb, updated_at)
planned_sets(id PK, session_id FK, exercise_id FK, set_no int, target_reps_low int,
      target_reps_high int, target_rir int, rest_sec int, recommended_weight num,
      recommended_reps int, reason_code text, confidence num, rules_version, updated_at)
performed_sets(id PK, planned_set_id FK, actual_weight num, actual_reps int,
      actual_rir int NULL, pain_score int NULL, completed bool,
      client_id uuid UNIQUE, performed_at, updated_at)   -- client_id = 멱등 키
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
CREATE INDEX ix_planned_session ON planned_sets(session_id);
CREATE INDEX ix_sessions_prog_date ON workout_sessions(program_id, scheduled_date);
CREATE INDEX ix_e1rm_user_ex ON estimated_1rm(user_id, exercise_id, computed_at DESC);
CREATE INDEX ix_mwl_user_week ON muscle_weekly_load(user_id, week_start);
```

## 데일리 루틴·부분 수행 (FEATURES_UX.md)
- 데일리 루틴 = workout_sessions 1개. planned_sets를 세션 스코프로 add/remove/swap 가능(오늘 루틴 편집).
- 부분 수행: 완료 체크된 세트만 performed_sets 생성. 세션은 부분이어도 completed 가능.
- 휴식 추천값은 planned_sets.rest_sec. 휴식 타이머 증가/종료는 클라이언트 UI 상태(미저장).

## 민감정보
- body_fat_pct·pain_score·문진 등 건강 민감정보는 애플리케이션/컬럼 암호화 + 접근 감사 로깅(SECURITY_PIPA.md).
