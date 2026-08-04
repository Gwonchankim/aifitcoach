-- CreateEnum
CREATE TYPE "sex" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "goal" AS ENUM ('diet', 'hypertrophy', 'strength');

-- CreateEnum
CREATE TYPE "experience_level" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "movement_pattern" AS ENUM ('squat', 'hinge', 'lunge', 'knee_extension', 'knee_flexion', 'calf', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull', 'elbow_extension', 'elbow_flexion', 'shoulder_isolation', 'core');

-- CreateEnum
CREATE TYPE "mechanic" AS ENUM ('compound', 'isolation');

-- CreateEnum
CREATE TYPE "region" AS ENUM ('upper', 'lower', 'core');

-- CreateEnum
CREATE TYPE "equipment" AS ENUM ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'ez_bar');

-- CreateEnum
CREATE TYPE "difficulty" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "metric" AS ENUM ('reps', 'time');

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('scheduled', 'in_progress', 'completed');

-- CreateEnum
CREATE TYPE "plan_tier" AS ENUM ('free', 'pro');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('trial', 'active', 'grace', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "sync_entity_type" AS ENUM ('performed_set', 'session', 'profile');

-- CreateEnum
CREATE TYPE "sync_op" AS ENUM ('upsert', 'delete');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('pending', 'applied', 'conflict');

-- CreateEnum
CREATE TYPE "calibration_status" AS ENUM ('not_started', 'in_progress', 'graduated', 'stale');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "sex" "sex" NOT NULL,
    "birth_year" INTEGER NOT NULL,
    "height_cm" DECIMAL(5,1) NOT NULL,
    "weight_kg" DECIMAL(5,1) NOT NULL,
    "body_fat_pct" DECIMAL(4,1),
    "goal" "goal" NOT NULL,
    "experience_level" "experience_level" NOT NULL,
    "constraints" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal" "goal" NOT NULL,
    "days_per_week" INTEGER NOT NULL,
    "minutes_per_day" INTEGER NOT NULL,
    "split_type" TEXT NOT NULL,
    "rules_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercises" (
    "id" TEXT NOT NULL,
    "name_ko" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "movement_pattern" "movement_pattern" NOT NULL,
    "mechanic" "mechanic" NOT NULL,
    "region" "region" NOT NULL,
    "primary_muscles" TEXT[],
    "secondary_muscles" TEXT[],
    "equipment" "equipment" NOT NULL,
    "difficulty" "difficulty" NOT NULL,
    "metric" "metric" NOT NULL,
    "default_reps_low" INTEGER,
    "default_reps_high" INTEGER,
    "default_time_low_sec" INTEGER,
    "default_time_high_sec" INTEGER,
    "default_step_kg" DECIMAL(5,2),
    "unilateral" BOOLEAN NOT NULL,
    "substitutions" TEXT[],
    "cues" TEXT[],
    "media" JSONB NOT NULL,

    CONSTRAINT "exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_sessions" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "scheduled_date" DATE NOT NULL,
    "status" "session_status" NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "session_feedback" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planned_sets" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "exercise_id" TEXT NOT NULL,
    "set_no" INTEGER NOT NULL,
    "target_reps_low" INTEGER NOT NULL,
    "target_reps_high" INTEGER NOT NULL,
    "target_rir" INTEGER NOT NULL,
    "rest_sec" INTEGER NOT NULL,
    "recommended_weight" DECIMAL(6,2) NOT NULL,
    "recommended_reps" INTEGER NOT NULL,
    "reason_code" TEXT NOT NULL,
    "confidence" DECIMAL(3,2) NOT NULL,
    "rules_version" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "planned_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performed_sets" (
    "id" UUID NOT NULL,
    "planned_set_id" UUID NOT NULL,
    "actual_weight" DECIMAL(6,2) NOT NULL,
    "actual_reps" INTEGER NOT NULL,
    "actual_rir" INTEGER,
    "pain_score" INTEGER,
    "completed" BOOLEAN NOT NULL,
    "client_id" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "performed_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimated_1rm" (
    "user_id" UUID NOT NULL,
    "exercise_id" TEXT NOT NULL,
    "e1rm" DECIMAL(6,2) NOT NULL,
    "method" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "estimated_1rm_pkey" PRIMARY KEY ("user_id","exercise_id","computed_at")
);

-- CreateTable
CREATE TABLE "muscle_weekly_load" (
    "user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "muscle" TEXT NOT NULL,
    "hard_sets" INTEGER NOT NULL,
    "volume_load" DECIMAL(10,2) NOT NULL,
    "avg_rir" DECIMAL(3,1) NOT NULL,

    CONSTRAINT "muscle_weekly_load_pkey" PRIMARY KEY ("user_id","week_start","muscle")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "user_id" UUID NOT NULL,
    "tier" "plan_tier" NOT NULL,
    "provider" TEXT NOT NULL,
    "billing_key_ref" TEXT,
    "status" "subscription_status" NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "renews_at" TIMESTAMPTZ(3),
    "trial_ends_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sync_mutations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "entity_type" "sync_entity_type" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "op" "sync_op" NOT NULL,
    "payload" JSONB NOT NULL,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "status" "sync_status" NOT NULL,

    CONSTRAINT "sync_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_rir_calibration" (
    "user_id" UUID NOT NULL,
    "bias_overall" DECIMAL(3,2) NOT NULL,
    "bias_by_region" JSONB NOT NULL,
    "confidence" DECIMAL(3,2) NOT NULL,
    "samples" INTEGER NOT NULL,
    "last_calibrated_at" TIMESTAMPTZ(3),
    "status" "calibration_status" NOT NULL,

    CONSTRAINT "user_rir_calibration_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "calibration_set" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "exercise_id" TEXT NOT NULL,
    "session_day" INTEGER NOT NULL,
    "predicted_rir" INTEGER NOT NULL,
    "amrap_extra_reps" INTEGER NOT NULL,
    "actual_rir" INTEGER NOT NULL,
    "bias_sample" DECIMAL(3,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calibration_set_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_sessions_prog_date" ON "workout_sessions"("program_id", "scheduled_date");

-- CreateIndex
CREATE INDEX "ix_planned_session" ON "planned_sets"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_performed_client" ON "performed_sets"("client_id");

-- CreateIndex
CREATE INDEX "ix_e1rm_user_ex" ON "estimated_1rm"("user_id", "exercise_id", "computed_at" DESC);

-- CreateIndex
CREATE INDEX "ix_mwl_user_week" ON "muscle_weekly_load"("user_id", "week_start");

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_sessions" ADD CONSTRAINT "workout_sessions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_sets" ADD CONSTRAINT "planned_sets_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "workout_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planned_sets" ADD CONSTRAINT "planned_sets_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performed_sets" ADD CONSTRAINT "performed_sets_planned_set_id_fkey" FOREIGN KEY ("planned_set_id") REFERENCES "planned_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimated_1rm" ADD CONSTRAINT "estimated_1rm_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimated_1rm" ADD CONSTRAINT "estimated_1rm_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "muscle_weekly_load" ADD CONSTRAINT "muscle_weekly_load_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_mutations" ADD CONSTRAINT "sync_mutations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_rir_calibration" ADD CONSTRAINT "user_rir_calibration_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_set" ADD CONSTRAINT "calibration_set_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calibration_set" ADD CONSTRAINT "calibration_set_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
