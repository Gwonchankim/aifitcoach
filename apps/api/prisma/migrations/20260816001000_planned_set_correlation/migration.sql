-- D-31: client correlation is nullable for every pre-existing/server-created planned set.
-- A unique index makes a retried offline routine resolve to the original authoritative row.
ALTER TABLE "planned_sets"
  ADD COLUMN "client_correlation_id" UUID;

CREATE UNIQUE INDEX "ux_planned_correlation"
  ON "planned_sets"("client_correlation_id");
