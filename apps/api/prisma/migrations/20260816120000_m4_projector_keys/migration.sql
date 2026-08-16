-- M-4′ derived rows are rebuilt from performed_sets/workout_sessions. Old rows use
-- a timestamp key and a raw formula, so they cannot be safely retained.
DROP TABLE "estimated_1rm";

CREATE TABLE "estimated_1rm" (
    "user_id" UUID NOT NULL,
    "exercise_id" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "e1rm" DECIMAL(6,2) NOT NULL,
    "method" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "estimated_1rm_pkey" PRIMARY KEY ("user_id", "exercise_id", "session_id")
);

CREATE INDEX "ix_e1rm_user_ex" ON "estimated_1rm"("user_id", "exercise_id", "computed_at" DESC);

ALTER TABLE "estimated_1rm" ADD CONSTRAINT "estimated_1rm_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "estimated_1rm" ADD CONSTRAINT "estimated_1rm_exercise_id_fkey"
  FOREIGN KEY ("exercise_id") REFERENCES "exercises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "estimated_1rm" ADD CONSTRAINT "estimated_1rm_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "workout_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "muscle_weekly_load" ALTER COLUMN "avg_rir" DROP NOT NULL;
