# STEP 6 `performed_sets.planned_set_id` 중복 정리

STEP 6 migration은 같은 `planned_set_id`의 수행 기록을 자동 삭제하지 않는다. 중복이 있으면 migration이
먼저 실패한다. 아래 절차는 **개발·E2E DB용**이며, 운영 데이터에는 제품 오너의 값 충돌 검토 없이 실행하지
않는다.

## 1. 읽기 전용 확인

```sql
SELECT planned_set_id, COUNT(*) AS rows, ARRAY_AGG(id ORDER BY updated_at DESC, id DESC) AS ids
FROM performed_sets
GROUP BY planned_set_id
HAVING COUNT(*) > 1
ORDER BY rows DESC, planned_set_id;
```

결과가 없으면 정리하지 않고 migration을 다시 실행한다.

## 2. 트랜잭션 안에서 백업·검토·정리

`updated_at`이 최신인 행을 우선하고 동률이면 UUID가 큰 행을 남긴다. 값이 다른 행은 transport 중복이
아닐 수 있으므로, `DELETE` 전의 두 `SELECT` 결과를 반드시 검토한다.

```sql
BEGIN;

CREATE TEMP TABLE step6_performed_set_duplicates_backup ON COMMIT DROP AS
SELECT ps.*
FROM performed_sets ps
JOIN (
  SELECT planned_set_id
  FROM performed_sets
  GROUP BY planned_set_id
  HAVING COUNT(*) > 1
) duplicate USING (planned_set_id);

SELECT *
FROM step6_performed_set_duplicates_backup
ORDER BY planned_set_id, updated_at DESC, id DESC;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY planned_set_id
           ORDER BY updated_at DESC, id DESC
         ) AS rank
  FROM performed_sets
)
DELETE FROM performed_sets ps
USING ranked
WHERE ps.id = ranked.id AND ranked.rank > 1
RETURNING ps.*;

SELECT planned_set_id, COUNT(*)
FROM performed_sets
GROUP BY planned_set_id
HAVING COUNT(*) > 1;

-- 위 결과가 0행이고 삭제된 값을 검토했을 때만 COMMIT한다.
COMMIT;
-- 문제가 있으면 COMMIT 대신 ROLLBACK;
```

실패한 migration 시도가 `_prisma_migrations`에 남았다면 먼저 아래처럼 **그 migration 하나만**
rolled-back으로 표시한다.

```powershell
pnpm --filter api exec prisma migrate resolve --rolled-back 20260815090000_sync_contract_lock --schema prisma/schema.prisma
```

정리 후 `pnpm --filter api db:migrate`를 다시 실행한다. migration 성공 뒤에는 같은
`planned_set_id`의 두 번째 행이 PostgreSQL unique violation으로 거절되는지 통합 테스트로 확인한다.
