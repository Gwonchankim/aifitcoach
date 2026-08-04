// `pnpm codegen`의 후처리: 생성물 상단에 "직접 수정 금지" 배너를 붙인다.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = join(import.meta.dirname, "..", "lib", "api-types.ts");
const banner = [
  "/**",
  " * 자동 생성물 — 직접 수정 금지. `pnpm codegen`으로 재생성한다.",
  " * 원본(Source of Truth): docs/specs/openapi.yaml",
  " */",
  "",
].join("\n");

writeFileSync(target, banner + readFileSync(target, "utf8"));
