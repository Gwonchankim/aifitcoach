/** Production HTTPS server for physical-device PWA verification — `pnpm --filter web start:lan`. */
/* global process, console */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";

const HOST = "0.0.0.0";
const PORT = 3000;
const KEY = "./certificates/lan-key.pem";
const CERT = "./certificates/lan.pem";
const BUILD_ID = "./.next/BUILD_ID";

for (const file of [KEY, CERT]) {
  if (!existsSync(file)) {
    console.error(
      `인증서가 없다: ${file}\n` +
        "mkcert 로 폰이 접속할 LAN IP 를 SAN 에 넣어 생성해라(docs/DEVICE_WALKTHROUGH.md 참조).",
    );
    process.exit(1);
  }
}
if (!existsSync(BUILD_ID)) {
  console.error("프로덕션 빌드가 없다. 먼저 `pnpm --filter web build:lan` 을 실행해라.");
  process.exit(1);
}

process.env.NODE_ENV = "production";
const { default: next } = await import("next");
const app = next({ dev: false, dir: ".", hostname: HOST, port: PORT });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer(
  { key: readFileSync(KEY), cert: readFileSync(CERT) },
  (request, response) => {
    void handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Internal Server Error");
    });
  },
);

server.listen(PORT, HOST, () => {
  console.log(`AIFITCOACH production PWA: https://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
