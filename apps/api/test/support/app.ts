import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.setup";
import { PrismaService } from "../../src/prisma/prisma.service";

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return app;
}

/**
 * 지정한 사용자들의 운동 데이터만 지운다(운동 카탈로그·시드는 유지).
 * FK 는 RESTRICT 라 자식 → 부모 순서로 지운다(SECURITY_PIPA.md 퍼지 순서와 동일).
 * 테넌시 테스트처럼 두 번째 사용자를 만드는 spec 은 그 id 도 같이 넘긴다.
 */
export async function resetUserData(prisma: PrismaService, ...userIds: string[]): Promise<void> {
  const userId = { in: userIds };
  await prisma.syncMutation.deleteMany({ where: { userId } });
  await prisma.performedSet.deleteMany({
    where: { plannedSet: { session: { program: { userId } } } },
  });
  await prisma.plannedSet.deleteMany({ where: { session: { program: { userId } } } });
  await prisma.workoutSession.deleteMany({ where: { program: { userId } } });
  await prisma.program.deleteMany({ where: { userId } });
  await prisma.userRirCalibration.deleteMany({ where: { userId } });
}
