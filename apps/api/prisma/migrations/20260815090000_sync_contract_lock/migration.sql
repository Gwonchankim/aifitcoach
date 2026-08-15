-- STEP 6 Sprint 0: 동기화 계약을 DB 불변식으로 잠근다.
-- 자동으로 수행 기록을 버리지 않는다. 중복이 있으면 아래 preflight가 먼저 중단하고
-- docs/runbooks/STEP6_PERFORMED_SET_DEDUP.md의 검토 가능한 절차를 요구한다.

-- Prisma가 preflight 예외 자체를 그대로 보고하게 transaction 시작 전에 검사한다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "performed_sets"
    GROUP BY "planned_set_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'performed_sets.planned_set_id 중복 때문에 STEP 6 UNIQUE를 만들 수 없다'
      USING HINT = 'docs/runbooks/STEP6_PERFORMED_SET_DEDUP.md에서 충돌 값을 검토·백업한 뒤 migration을 다시 실행하라';
  END IF;
END $$;

BEGIN;

-- profile은 ADR-33에 따라 공개 sync 계약에서 제외하지만 기존 enum 값은 파괴적으로 제거하지 않는다.
ALTER TYPE "sync_entity_type" ADD VALUE IF NOT EXISTS 'session_routine';

DROP INDEX "ix_performed_planned";
CREATE UNIQUE INDEX "ux_performed_planned" ON "performed_sets"("planned_set_id");

-- pull의 since는 클라이언트 시각이 아니라 서버가 부여하는 단조 증가 순서를 가리킨다.
ALTER TABLE "sync_mutations" ADD COLUMN "server_seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "sync_mutations_server_seq_key" ON "sync_mutations"("server_seq");
CREATE INDEX "ix_sync_user_seq" ON "sync_mutations"("user_id", "server_seq");

COMMIT;
