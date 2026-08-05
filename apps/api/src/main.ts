import "reflect-metadata";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";

/**
 * 환경변수는 레포 루트 `.env` 하나로 관리한다(시드·테스트도 같은 파일을 읽는다).
 * 이걸 로드하지 않으면 `pnpm --filter api start:dev` 가 부팅 중 죽는다
 * (`Environment variable not found: DATABASE_URL`).
 * `override: false` 라 실제 환경변수(배포·CI)가 항상 우선한다.
 */
loadDotenv({ path: path.resolve(__dirname, "..", "..", "..", ".env"), quiet: true });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
