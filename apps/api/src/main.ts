import "reflect-metadata";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";

/**
 * API 진입점(빌드 산출물 `apps/api/dist/main.js`).
 *
 * 환경변수는 레포 루트 `.env` 하나로 보충한다(ADR-36 — 시드·시험도 같은 파일을 읽는다). `__dirname`
 * (`src/` 또는 `dist/`) 기준 세 단계 위가 루트다. `override: false` — 프로세스에 이미 있는 값(배포·CI·
 * 실행 래퍼가 주입한 값)이 항상 이기고 `.env` 는 비어 있는 키만 채운다.
 */
loadDotenv({
  path: path.resolve(__dirname, "..", "..", "..", ".env"),
  override: false,
  quiet: true,
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // 인증 모드(production dev-user 거부 포함)·CORS·전역 prefix 는 configureApp 한 곳이 정한다.
  configureApp(app);
  await app.listen(process.env.PORT ?? 3001);
}

// 부팅 실패(설정 거부 포함)는 원인을 로그에 남기고 반드시 0 이 아닌 코드로 끝낸다.
bootstrap().catch((error: unknown) => {
  new Logger("Bootstrap").error(
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? error.stack : undefined,
  );
  process.exit(1);
});
