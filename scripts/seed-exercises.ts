/**
 * 운동 시드 적재 진입점: `pnpm --filter api db:seed`
 *
 * 실제 로직은 DB 의존성(@prisma/client)을 소유한 apps/api 안에 둔다.
 * (pnpm 격리 설치라 루트 scripts/ 에서는 @prisma/client 가 해석되지 않는다.)
 */
import { main } from "../apps/api/prisma/seed-exercises";

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
