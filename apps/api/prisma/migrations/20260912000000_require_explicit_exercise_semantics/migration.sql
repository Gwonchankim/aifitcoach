-- Preserve every existing value and NOT NULL; writers must supply the canonical semantics.
-- Forward-only release correction. Do not edit the previously applied F3 migration.
ALTER TABLE "exercises" ALTER COLUMN "load_semantics" DROP DEFAULT;
