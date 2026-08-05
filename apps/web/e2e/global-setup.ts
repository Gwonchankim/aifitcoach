import fs from "node:fs";
import path from "node:path";

/** 실행마다 누적 결과 파일을 비운다(spec 은 append 만 한다 — 워커 재시작 대비). */
export default function globalSetup(): void {
  fs.rmSync(path.resolve(process.cwd(), "e2e/axe-results.jsonl"), { force: true });
}
