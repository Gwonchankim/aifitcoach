-- F-3: 어시스트 load semantics · immutable snapshot · provenance · audit.
--
-- 순서가 계약이다: nullable 컬럼 → backfill + audit → CHECK.
-- CHECK 를 먼저 걸면 기존 행이 조건을 만족하지 못해 migration 자체가 막힌다.
--
-- **수행된 행(performed fact)은 값을 하나도 바꾸지 않는다.** 처방 보정은 미수행 행만 대상이다.
-- **통증(pain_score)은 읽지 않는다** — provenance 판정은 performed fact 유무만 본다.

-- ---------------------------------------------------------------- 1) enum
CREATE TYPE "load_semantics" AS ENUM ('external_load', 'assistance');
CREATE TYPE "assistance_provenance" AS ENUM ('native', 'remediated', 'legacy_performed');

-- ------------------------------------------------------ 2) nullable columns
ALTER TABLE "exercises"
  ADD COLUMN "load_semantics" "load_semantics";

ALTER TABLE "planned_sets"
  ADD COLUMN "assistance_step_kg" DECIMAL(6,2),
  ADD COLUMN "assistance_provenance" "assistance_provenance";

CREATE TABLE "assistance_audits" (
    "id" UUID NOT NULL,
    "planned_set_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assistance_audits_pkey" PRIMARY KEY ("id")
);

-- 재실행해도 중복이 쌓이지 않게 하는 것이 목적이다.
CREATE UNIQUE INDEX "ux_assistance_audit_planned_action"
  ON "assistance_audits" ("planned_set_id", "action");

ALTER TABLE "assistance_audits"
  ADD CONSTRAINT "assistance_audits_planned_set_id_fkey"
  FOREIGN KEY ("planned_set_id") REFERENCES "planned_sets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------------------- 3) backfill
-- 카탈로그: 어시스트 머신만 assistance, 나머지는 external_load 로 확정한다.
-- 지금은 `e_assisted_pullup` 하나지만 목록이 늘어도 여기서만 바뀐다.
UPDATE "exercises" SET "load_semantics" = 'assistance'
  WHERE "id" IN ('e_assisted_pullup');
UPDATE "exercises" SET "load_semantics" = 'external_load'
  WHERE "load_semantics" IS NULL;

-- backfill 이 끝났으므로 canonical 로 잠근다. 이후 시드·import 가 조용히 빠뜨릴 수 없다.
ALTER TABLE "exercises"
  ALTER COLUMN "load_semantics" SET NOT NULL,
  ALTER COLUMN "load_semantics" SET DEFAULT 'external_load';

-- 어시스트 planned 행에 snapshot 을 굳힌다. 카탈로그가 나중에 바뀌어도 과거 해석이 흔들리지 않는다.
UPDATE "planned_sets" ps
   SET "assistance_step_kg" = COALESCE(e."default_step_kg", 2.5)
  FROM "exercises" e
 WHERE e."id" = ps."exercise_id"
   AND e."load_semantics" = 'assistance'
   AND ps."assistance_step_kg" IS NULL;

-- provenance: performed fact 유무 × rules_version.
--   assistance-capable(.08.2/.09.0/.09.1) 신규 → native
--   legacy(.08.1) + 수행됨                    → legacy_performed  (raw fact 보존)
--   legacy(.08.1) + 미수행                    → remediated        (처방만 보정)
UPDATE "planned_sets" ps
   SET "assistance_provenance" = CASE
         WHEN ps."rules_version" <> '2026.08.1' THEN 'native'::"assistance_provenance"
         WHEN EXISTS (SELECT 1 FROM "performed_sets" pf WHERE pf."planned_set_id" = ps."id")
           THEN 'legacy_performed'::"assistance_provenance"
         ELSE 'remediated'::"assistance_provenance"
       END
  FROM "exercises" e
 WHERE e."id" = ps."exercise_id"
   AND e."load_semantics" = 'assistance'
   AND ps."assistance_provenance" IS NULL;

-- 미수행 legacy 행만 assistance-capable bundle 로 올린다. 수행된 행은 건드리지 않는다.
UPDATE "planned_sets"
   SET "rules_version" = '2026.08.2'
 WHERE "assistance_provenance" = 'remediated'
   AND "rules_version" = '2026.08.1';

-- audit — 멱등. 이미 있는 (planned_set_id, action) 은 건너뛴다.
INSERT INTO "assistance_audits" ("id", "planned_set_id", "action", "metadata")
SELECT gen_random_uuid(), ps."id", ps."assistance_provenance"::text, '{}'::jsonb
  FROM "planned_sets" ps
 WHERE ps."assistance_provenance" IS NOT NULL
ON CONFLICT ("planned_set_id", "action") DO NOTHING;

-- ------------------------------------------------------------------ 4) CHECK
-- nullable 조건부 불변식: non-assisted 는 반드시 NULL, assisted 는 반드시 non-NULL.
-- Prisma 로는 표현할 수 없어 raw SQL 이 원천이다(service guard·integration test 와 3중).
ALTER TABLE "planned_sets"
  ADD CONSTRAINT "ck_planned_assistance_snapshot"
  CHECK (
    ("assistance_provenance" IS NULL AND "assistance_step_kg" IS NULL)
    OR ("assistance_provenance" IS NOT NULL AND "assistance_step_kg" IS NOT NULL)
  );

-- 어시스트 종목이면 provenance 가 있어야 하고, 아니면 없어야 한다.
-- 트리거 없이 강제하기 위해 exercise 의 semantics 를 planned 행에 함께 굳힌다.
ALTER TABLE "planned_sets"
  ADD COLUMN "load_semantics" "load_semantics";

UPDATE "planned_sets" ps
   SET "load_semantics" = e."load_semantics"
  FROM "exercises" e
 WHERE e."id" = ps."exercise_id";

ALTER TABLE "planned_sets"
  ALTER COLUMN "load_semantics" SET NOT NULL;

ALTER TABLE "planned_sets"
  ADD CONSTRAINT "ck_planned_assistance_matches_semantics"
  CHECK (
    ("load_semantics" = 'assistance' AND "assistance_provenance" IS NOT NULL)
    OR ("load_semantics" <> 'assistance' AND "assistance_provenance" IS NULL)
  );

-- ----------------------------------------------------------------- rollback
--
-- **적용 전**: 이 파일과 생성된 Prisma 타입을 되돌리면 끝이다(DB 변경 없음).
--
-- **적용 후에는 destructive down migration 을 금지한다.**
-- 컬럼을 drop 하면 잘못된 처방과 "이 행을 어느 규칙으로 읽어야 하는가"라는 해석을 함께 잃는다.
-- 허용되는 것은 둘뿐이다:
--   1. additive schema 를 유지한 **compatibility rollback** — 읽기 경로만 이전 동작으로 되돌리고
--      컬럼·audit 은 그대로 둔다.
--   2. **후속 forward-fix** migration.
--
-- 보존 대상(되돌리지 않는다):
--   - `assistance_audits` 전체 — 감사 근거다.
--   - row-level `rules_version = 2026.08.2` + snapshot + provenance —
--     미수행 legacy 행의 안전 보정이고, 되돌리면 틀린 처방이 다시 살아난다.
--   - `Program.rules_version` 의 `2026.08.1` provenance — 프로그램 단위 출처는 그대로다.
