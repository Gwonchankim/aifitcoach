import fs from "node:fs";
import path from "node:path";

/** 실행마다 누적 결과 파일을 비운다(spec 은 append 만 한다 — 워커 재시작 대비). */
export default function globalSetup(): void {
  const metrics = path.resolve(process.cwd(), "e2e/.artifacts/metrics");
  fs.mkdirSync(metrics, { recursive: true });
  fs.rmSync(path.join(metrics, "axe-results.jsonl"), { force: true });
}
