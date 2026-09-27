-- S2 additive domain. No existing Program/PlannedSet/PerformedSet row is rewritten.
ALTER TYPE "equipment" ADD VALUE 'stationary_bike';
CREATE TYPE "prescription_kind" AS ENUM ('resistance', 'steady_cardio', 'interval_cardio');
ALTER TABLE "exercises"
 ADD COLUMN "cardio_movement_regions" "region"[] NOT NULL DEFAULT ARRAY[]::"region"[],
 ADD COLUMN "prescription_kinds_supported" "prescription_kind"[] NOT NULL DEFAULT ARRAY[]::"prescription_kind"[],
 ADD COLUMN "blocked_reported_pain_areas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "planned_sets"
 ADD COLUMN "prescription_kind" "prescription_kind",
 ADD COLUMN "duration_sec" INTEGER,
 ADD COLUMN "rpe_scale_id" TEXT,
 ADD COLUMN "target_rpe_low" INTEGER,
 ADD COLUMN "target_rpe_high" INTEGER,
 ADD COLUMN "work_sec" INTEGER,
 ADD COLUMN "recovery_sec" INTEGER,
 ADD COLUMN "rounds" INTEGER,
 ADD COLUMN "recovery_rpe_low" INTEGER,
 ADD COLUMN "recovery_rpe_high" INTEGER,
 ADD COLUMN "final_recovery_included" BOOLEAN,
 ADD COLUMN "long_session_flag" BOOLEAN,
 ADD COLUMN "progression_axis" TEXT,
 ADD COLUMN "source_day" TEXT,
 ADD COLUMN "source_ordinal" INTEGER,
 ADD COLUMN "intensity_seconds" JSONB,
 ADD COLUMN "cardio_fallback" JSONB,
 ALTER COLUMN "rest_sec" DROP NOT NULL,
 ALTER COLUMN "reason_code" DROP NOT NULL,
 ALTER COLUMN "confidence" DROP NOT NULL,
 ALTER COLUMN "load_semantics" DROP NOT NULL;

ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_kind_payload" CHECK (
 (("prescription_kind" IS NULL OR "prescription_kind" = 'resistance')
  AND "duration_sec" IS NULL AND "rpe_scale_id" IS NULL AND "target_rpe_low" IS NULL AND "target_rpe_high" IS NULL AND "work_sec" IS NULL AND "recovery_sec" IS NULL AND "rounds" IS NULL AND "recovery_rpe_low" IS NULL AND "recovery_rpe_high" IS NULL AND "final_recovery_included" IS NULL AND "long_session_flag" IS NULL AND "progression_axis" IS NULL AND "source_day" IS NULL AND "source_ordinal" IS NULL AND "intensity_seconds" IS NULL AND "cardio_fallback" IS NULL
  AND "rest_sec" IS NOT NULL AND "reason_code" IS NOT NULL AND "confidence" IS NOT NULL AND "load_semantics" IS NOT NULL)
 OR ("prescription_kind" IS NOT NULL AND "prescription_kind" IN ('steady_cardio', 'interval_cardio')
  AND "target_reps_low" IS NULL AND "target_reps_high" IS NULL AND "target_rir" IS NULL AND "rest_sec" IS NULL AND "target_time_low_sec" IS NULL AND "target_time_high_sec" IS NULL AND "recommended_weight" IS NULL AND "recommended_reps" IS NULL AND "reason_code" IS NULL AND "confidence" IS NULL AND "load_semantics" IS NULL AND "assistance_step_kg" IS NULL AND "assistance_provenance" IS NULL
  AND "duration_sec" IS NOT NULL AND "rpe_scale_id" IS NOT NULL AND "target_rpe_low" IS NOT NULL AND "target_rpe_high" IS NOT NULL AND "long_session_flag" IS NOT NULL AND "progression_axis" IS NOT NULL AND "source_day" IS NOT NULL AND "source_ordinal" IS NOT NULL AND "intensity_seconds" IS NOT NULL
  AND "source_day" IN ('MON','TUE','WED','THU','FRI','SAT','SUN') AND "source_ordinal" >= 1)
);
ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_cardio_duration" CHECK (
 "prescription_kind" IS NULL OR "prescription_kind" = 'resistance'
 OR ("prescription_kind" = 'steady_cardio' AND "duration_sec" > 0
  AND "work_sec" IS NULL AND "recovery_sec" IS NULL AND "rounds" IS NULL AND "recovery_rpe_low" IS NULL AND "recovery_rpe_high" IS NULL AND "final_recovery_included" IS NULL)
 OR ("prescription_kind" = 'interval_cardio'
  AND "work_sec" IS NOT NULL AND "recovery_sec" IS NOT NULL AND "rounds" IS NOT NULL AND "final_recovery_included" IS NOT NULL
  AND "work_sec" > 0 AND "recovery_sec" > 0 AND "rounds" BETWEEN 1 AND 12
  AND "duration_sec" > 0 AND "duration_sec"::bigint = ("work_sec"::bigint + "recovery_sec"::bigint) * "rounds"::bigint
  AND "final_recovery_included" = true)
);
ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_cardio_rpe" CHECK (
 "prescription_kind" IS NULL OR "prescription_kind" = 'resistance'
 OR ("rpe_scale_id" = 'relative_effort_0_10_v1'
  AND "target_rpe_low" BETWEEN 0 AND 10 AND "target_rpe_high" BETWEEN "target_rpe_low" AND 10
  AND ("prescription_kind" = 'steady_cardio' OR ("recovery_rpe_low" IS NOT NULL AND "recovery_rpe_high" IS NOT NULL
   AND "recovery_rpe_low" BETWEEN 0 AND 10 AND "recovery_rpe_high" BETWEEN "recovery_rpe_low" AND 10)))
);
ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_cardio_axis" CHECK (
 "prescription_kind" IS NULL OR "prescription_kind" = 'resistance'
 OR ("prescription_kind" = 'steady_cardio' AND "progression_axis" = 'duration_sec')
 OR ("prescription_kind" = 'interval_cardio' AND "progression_axis" = 'rounds' AND "long_session_flag" = false)
);
-- Preserve the legacy assistance predicate verbatim and add only the strict cardio branch.
ALTER TABLE "planned_sets" DROP CONSTRAINT "ck_planned_assistance_matches_semantics";
ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_assistance_matches_semantics" CHECK (
 ("load_semantics" = 'assistance' AND "assistance_provenance" IS NOT NULL)
 OR ("load_semantics" <> 'assistance' AND "assistance_provenance" IS NULL)
 OR ("prescription_kind" IS NOT NULL AND "prescription_kind" IN ('steady_cardio', 'interval_cardio') AND "load_semantics" IS NULL
     AND "assistance_step_kg" IS NULL AND "assistance_provenance" IS NULL)
);
ALTER TABLE "exercises" ADD CONSTRAINT "ck_exercise_cardio_metadata" CHECK (
 "modality" IS DISTINCT FROM 'cardio' OR (
 "id" = 'e_stationary_bike' AND "equipment"::text = 'stationary_bike'
 AND "cardio_movement_regions" = ARRAY['lower']::"region"[]
 AND "prescription_kinds_supported" = ARRAY['steady_cardio','interval_cardio']::"prescription_kind"[]
 AND "blocked_reported_pain_areas" = ARRAY['knee','lower_back','shoulder','elbow','wrist','hip','neck','ankle']::TEXT[]
 ));

ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_cardio_intensity" CHECK (
 "prescription_kind" IS NULL OR "prescription_kind" = 'resistance'
 OR ("prescription_kind" = 'steady_cardio' AND "intensity_seconds" = jsonb_build_object('moderate', "duration_sec", 'high', 0, 'recovery', 0))
 OR ("prescription_kind" = 'interval_cardio' AND "intensity_seconds" = jsonb_build_object('moderate', 0, 'high', "work_sec"::bigint * "rounds"::bigint, 'recovery', "recovery_sec"::bigint * "rounds"::bigint))
);
ALTER TABLE "planned_sets" ADD CONSTRAINT "ck_planned_cardio_fallback" CHECK (
 "cardio_fallback" IS NULL OR (
 jsonb_typeof("cardio_fallback") = 'object'
 AND "cardio_fallback" ?& ARRAY['cause','source_day','source_ordinal','original_descriptor','effective_descriptor']
 AND jsonb_typeof("cardio_fallback"->'cause') = 'string'
 AND jsonb_typeof("cardio_fallback"->'source_day') = 'string'
 AND "cardio_fallback"->>'cause' IN ('source_eligibility_fallback','redesign_recovery')
 AND "cardio_fallback"->>'source_day' = "source_day"
 AND "cardio_fallback"->'source_ordinal' = to_jsonb("source_ordinal")
 AND jsonb_typeof("cardio_fallback"->'original_descriptor') = 'object'
 AND jsonb_typeof("cardio_fallback"->'effective_descriptor') = 'object'
 ));

