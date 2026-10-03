-- S1: additive exercise domain and internal program goals; active bundle unchanged.
CREATE TYPE "exercise_modality" AS ENUM ('resistance', 'cardio', 'mobility', 'warmup');
ALTER TYPE "goal" ADD VALUE 'general_fitness';
ALTER TYPE "goal" ADD VALUE 'endurance';
ALTER TABLE "exercises" ADD COLUMN "modality" "exercise_modality";
ALTER TABLE "exercises"
  ALTER COLUMN "movement_pattern" DROP NOT NULL,
  ALTER COLUMN "mechanic" DROP NOT NULL,
  ALTER COLUMN "region" DROP NOT NULL,
  ALTER COLUMN "load_semantics" DROP NOT NULL;

-- This exact block is idempotent. The manifest never infers from other attributes.
DO $backfill$
DECLARE
  canonical_ids text[] := ARRAY[
    'e_back_squat',
    'e_leg_press',
    'e_goblet_squat',
    'e_rdl',
    'e_deadlift',
    'e_hip_thrust',
    'e_walking_lunge',
    'e_leg_extension',
    'e_leg_curl',
    'e_calf_raise',
    'e_bench_press',
    'e_incline_db_press',
    'e_chest_press_machine',
    'e_ohp',
    'e_db_shoulder_press',
    'e_dips',
    'e_triceps_pushdown',
    'e_overhead_triceps_ext',
    'e_lateral_raise',
    'e_lat_pulldown',
    'e_pullup',
    'e_barbell_row',
    'e_seated_cable_row',
    'e_one_arm_db_row',
    'e_face_pull',
    'e_barbell_curl',
    'e_db_curl',
    'e_hammer_curl',
    'e_plank',
    'e_cable_crunch',
    'e_front_squat',
    'e_hack_squat',
    'e_smith_squat',
    'e_bulgarian_split_squat',
    'e_split_squat',
    'e_reverse_lunge',
    'e_step_up',
    'e_belt_squat',
    'e_sissy_squat',
    'e_sumo_deadlift',
    'e_trap_bar_deadlift',
    'e_single_leg_rdl',
    'e_good_morning',
    'e_cable_pull_through',
    'e_glute_bridge',
    'e_back_extension',
    'e_hip_abduction',
    'e_kettlebell_swing',
    'e_seated_leg_curl',
    'e_nordic_curl',
    'e_seated_calf_raise',
    'e_leg_press_calf_raise',
    'e_adduction_machine',
    'e_incline_bench_press',
    'e_decline_bench_press',
    'e_flat_db_press',
    'e_smith_bench_press',
    'e_smith_incline_bench_press',
    'e_pushup',
    'e_cable_fly',
    'e_pec_deck',
    'e_db_fly',
    'e_seated_db_shoulder_press',
    'e_shoulder_press_machine',
    'e_arnold_press',
    'e_push_press',
    'e_pike_pushup',
    'e_chinup',
    'e_neutral_grip_pulldown',
    'e_assisted_pullup',
    'e_straight_arm_pulldown',
    'e_chest_supported_row',
    'e_t_bar_row',
    'e_pendlay_row',
    'e_inverted_row',
    'e_machine_row',
    'e_shrug',
    'e_barbell_shrug',
    'e_cable_lateral_raise',
    'e_machine_lateral_raise',
    'e_rear_delt_fly',
    'e_reverse_pec_deck',
    'e_front_raise',
    'e_upright_row',
    'e_close_grip_bench',
    'e_skull_crusher',
    'e_rope_pushdown',
    'e_bench_dip',
    'e_kickback',
    'e_incline_db_curl',
    'e_preacher_curl',
    'e_cable_curl',
    'e_concentration_curl',
    'e_reverse_curl',
    'e_wrist_curl',
    'e_farmer_walk',
    'e_hanging_leg_raise',
    'e_lying_leg_raise',
    'e_crunch',
    'e_ab_wheel',
    'e_russian_twist',
    'e_cable_woodchop',
    'e_dead_bug',
    'e_bird_dog',
    'e_side_plank',
    'e_hollow_hold',
    'e_low_row_machine',
    'e_high_row_machine',
    'e_incline_chest_press_machine',
    'e_assisted_dips'
  ];
  unknown_id text;
BEGIN
  SELECT id INTO unknown_id FROM exercises WHERE NOT (id = ANY(canonical_ids)) ORDER BY id LIMIT 1;
  IF unknown_id IS NOT NULL THEN
    RAISE EXCEPTION 'unknown exercise ID in modality backfill: %', unknown_id;
  END IF;
  UPDATE exercises SET modality = 'resistance' WHERE modality IS NULL AND id = ANY(canonical_ids);
END
$backfill$;

-- Explicit IS NOT NULL terms prevent PostgreSQL UNKNOWN from accepting incomplete legacy rows.
-- Keep the pre-existing load_semantics default for legacy writers; non-resistance must supply NULL.
ALTER TABLE "exercises" ADD CONSTRAINT "ck_exercise_domain" CHECK (
  ((modality IS NULL OR modality = 'resistance')
    AND movement_pattern IS NOT NULL AND mechanic IS NOT NULL
    AND region IS NOT NULL AND load_semantics IS NOT NULL)
  OR
  (modality IS NOT NULL AND modality IN ('cardio', 'mobility', 'warmup')
    AND movement_pattern IS NULL AND mechanic IS NULL AND region IS NULL
    AND load_semantics IS NULL AND default_reps_low IS NULL AND default_reps_high IS NULL
    AND default_time_low_sec IS NULL AND default_time_high_sec IS NULL AND default_step_kg IS NULL
    AND (modality <> 'cardio' OR metric = 'time'))
);
-- No UPDATE of programs, workout_sessions, planned_sets, or performed_sets.
