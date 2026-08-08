/**
 * 실기기(폰) 검증용 HTTPS 개발 서버 — ADR-43. `pnpm --filter web dev:lan`
 *
 * 왜 래퍼가 필요한가(둘 다 실측으로 확인한 실패다):
 *  - 셸에서 `NEXT_PUBLIC_API_BASE_URL=/api/v1` 를 주면 Git Bash(MSYS)가 선행 슬래시를
 *    `C:/Program Files/Git/api/v1` 로 경로 변환해 조용히 깨진다.
 *  - next.config 에서 `process.argv` 로 `--experimental-https` 를 보려 해도, Next 15 는
 *    설정을 자식 프로세스에서 로드해서 CLI 플래그가 보이지 않는다.
 * 그래서 여기서 환경변수를 세팅하고 자식에 상속시킨다.
 */
/* global process, console */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const KEY = "./certificates/lan-key.pem";
const CERT = "./certificates/lan.pem";

if (!existsSync(KEY) || !existsSync(CERT)) {
  console.error(
    `인증서가 없다: ${CERT}\n` +
      `mkcert 로 폰이 접속할 LAN IP 를 SAN 에 넣어 생성해라(docs/DEVICE_WALKTHROUGH.md 참조).`,
  );
  process.exit(1);
}

spawn(
  "next",
  [
    "dev",
    "-H",
    "0.0.0.0",
    "--experimental-https",
    "--experimental-https-key",
    KEY,
    "--experimental-https-cert",
    CERT,
  ],
  {
    stdio: "inherit",
    shell: true,
    // 폰은 `https://<PC-IP>:3000` 을 보므로 `http://localhost:3001` 직통은 혼합 콘텐츠로 차단된다.
    // 같은 출처의 상대 경로만 부르게 하고, next.config 의 rewrites 가 API 로 넘긴다.
    env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: "/api/v1" },
  },
).on("exit", (code) => process.exit(code ?? 0));
