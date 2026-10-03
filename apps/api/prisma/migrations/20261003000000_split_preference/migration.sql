-- Additive preference storage only. Existing users remain NULL; no program is rewritten.
CREATE TYPE "split_preference" AS ENUM ('balanced', 'upper_priority', 'lower_priority');
ALTER TABLE "users" ADD COLUMN "split_preference" "split_preference";
