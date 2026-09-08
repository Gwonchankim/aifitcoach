-- Nullable metadata on the existing owner ledger. No PlannedSet FK/cascade: deleted claims survive.
ALTER TABLE "sync_mutations"
  ADD COLUMN "request_hash" TEXT,
  ADD COLUMN "request_identity" JSONB,
  ADD COLUMN "result_identity" JSONB,
  ADD COLUMN "correlation_claims" JSONB,
  ADD COLUMN "dependency_identity" JSONB,
  ADD COLUMN "conflict_reason" TEXT,
  ADD COLUMN "tombstone_identity" JSONB;

CREATE INDEX "ix_sync_correlation_claims" ON "sync_mutations" USING GIN ("correlation_claims" jsonb_path_ops);
