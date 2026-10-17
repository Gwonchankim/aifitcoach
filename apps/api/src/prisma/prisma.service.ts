import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * 앱 전역 단일 Prisma 클라이언트. 접속 대상은 schema.prisma 의 `DATABASE_URL` 하나다
 * (migration 은 DIRECT_URL 을 우선하므로, 실행 환경이 둘을 같은 대상으로 맞춘다 — test/global-setup.ts).
 *
 * 모듈 초기화에서 연결하고 앱 종료(`app.close()`)에서 끊는다 — 앱을 닫은 시험·프로세스에 연결이 남지 않는다.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
