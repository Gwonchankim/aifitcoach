-- M-AUTH+DEPLOY: single-owner authentication storage.
-- The existing local/dev users remain valid as role=user; a first real bootstrap creates role=admin.
-- This is schema-only: the approved Neon production database starts empty, so no profile/data backfill occurs.

CREATE TYPE "user_role" AS ENUM ('user', 'admin');

ALTER TABLE "users"
  ADD COLUMN "role" "user_role" NOT NULL DEFAULT 'user',
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_attempts" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "bucket_hash" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "locked_until" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "access_audits" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_auth_sessions_token_hash" ON "auth_sessions"("session_token_hash");
CREATE INDEX "ix_auth_sessions_user_expires" ON "auth_sessions"("user_id", "expires_at");
CREATE UNIQUE INDEX "ux_auth_attempts_scope_bucket" ON "auth_attempts"("scope", "bucket_hash");
CREATE INDEX "ix_auth_attempts_locked_until" ON "auth_attempts"("locked_until");
CREATE INDEX "ix_access_audits_user_occurred" ON "access_audits"("user_id", "occurred_at" DESC);

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "access_audits" ADD CONSTRAINT "access_audits_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
