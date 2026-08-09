/**
 * jest globalTeardown: 이 실행이 만든 사용자와 그 데이터를 지운다.
 *
 * 실행마다 사용자 id 가 달라지므로(support/users.ts) 안 지우면 `afc_test` 에 계속 쌓인다.
 * **다른 실행의 데이터는 절대 건드리지 않는다** — 이 실행의 `AFC_TEST_RUN_ID` 에서 파생된 id 만 지운다.
 * 정리 실패로 테스트 결과를 뒤집지 않는다(경고만 남기고 통과시킨다).
 */
import { PrismaClient } from "@prisma/client";
import { TEST_USER_SEEDS, testUserId } from "./support/users";

export default async function globalTeardown(): Promise<void> {
  const ids = TEST_USER_SEEDS.map((seed) => testUserId(seed));
  const prisma = new PrismaClient();
  const userId = { in: ids };
  try {
    // FK 는 RESTRICT 라 자식 → 부모 순서로 지운다(SECURITY_PIPA.md 퍼지 순서와 동일).
    await prisma.performedSet.deleteMany({
      where: { plannedSet: { session: { program: { userId } } } },
    });
    await prisma.plannedSet.deleteMany({ where: { session: { program: { userId } } } });
    await prisma.workoutSession.deleteMany({ where: { program: { userId } } });
    await prisma.program.deleteMany({ where: { userId } });
    await prisma.calibrationSet.deleteMany({ where: { userId } });
    await prisma.userRirCalibration.deleteMany({ where: { userId } });
    await prisma.estimated1rm.deleteMany({ where: { userId } });
    await prisma.muscleWeeklyLoad.deleteMany({ where: { userId } });
    await prisma.syncMutation.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { userId } });
    await prisma.consent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  } catch (error) {
    console.warn(`[globalTeardown] 테스트 사용자 정리 실패(무시): ${(error as Error).message}`);
  } finally {
    await prisma.$disconnect();
  }
}
