import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/**
 * PrismaService 를 앱 전체에 인스턴스 하나로 공급한다. `@Global()` 이라 도메인 모듈은 이 모듈을
 * import 하지 않고 PrismaService 를 주입받는다(AppModule 이 한 번만 import 한다).
 */
@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
