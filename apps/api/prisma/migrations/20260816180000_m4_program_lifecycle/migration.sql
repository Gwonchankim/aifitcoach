CREATE TYPE "program_status" AS ENUM ('active', 'completed');

ALTER TABLE "programs"
  ADD COLUMN "started_at" DATE,
  ADD COLUMN "total_weeks" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN "status" "program_status" NOT NULL DEFAULT 'active',
  ADD COLUMN "generation_input" JSONB;

-- D-37 legacy backfill: an existing program starts in the week of its earliest materialized
-- session. Programs without sessions fall back to their creation week. Generation input stays
-- null because experience/equipment/avoid inputs cannot be reconstructed safely.
UPDATE "programs" AS p
SET "started_at" = date_trunc(
  'week',
  COALESCE(
    (SELECT MIN(ws."scheduled_date")::timestamp FROM "workout_sessions" AS ws WHERE ws."program_id" = p."id"),
    p."created_at" AT TIME ZONE 'UTC'
  )
)::date;

ALTER TABLE "programs" ALTER COLUMN "started_at" SET NOT NULL;

ALTER TABLE "programs" ADD CONSTRAINT "program_total_weeks_12" CHECK ("total_weeks" = 12);
