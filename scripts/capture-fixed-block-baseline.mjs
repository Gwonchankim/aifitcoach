// One-shot pre-change capture. Never invoked by the regression tests.
import console from "node:console";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const base = "1e1573747d08ee9817c7af29d05bfc97412cd4a5";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("rev-parse", "HEAD") !== base)
  throw new Error("Capture is only permitted at approved base");
const sources = [
  "packages/shared/src/session-plan.ts",
  "packages/shared/test/session-plan.test.ts",
  "apps/api/test/program-packer.spec.ts",
  "apps/api/src/programs/programs.service.ts",
  "apps/api/src/programs/planned-set.factory.ts",
  "docs/specs/exercises_seed.json",
  "apps/api/test/fixtures/v1-plan-225.json",
];
const sourceHashes = {};
for (const file of sources) {
  if (git("hash-object", file) !== git("rev-parse", `${base}:${file}`)) {
    throw new Error(`Source differs from approved base: ${file}`);
  }
  sourceHashes[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
}
const metadata = {
  capture_commit: base,
  captured_at: new Date().toISOString(),
  source_sha256: sourceHashes,
};
mkdirSync("packages/shared/test/fixtures", { recursive: true });
const output = "packages/shared/test/fixtures/session-plan-base-1e15737.json";
try {
  readFileSync(output);
  throw new Error("Refusing to regenerate captured baseline");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
writeFileSync(".mutation-snapshot/t06-s1/capture-metadata.json", JSON.stringify(metadata, null, 2));
const wrapper = `\nconst captured: unknown[] = [];\nfunction packSession(input: Parameters<typeof originalPackSession>[0]) {\n  const result = originalPackSession(input);\n  captured.push({ input, output: result });\n  return result;\n}\n`;
const footer = (name, path) =>
  `\nafterAll(() => { require("node:fs").writeFileSync(${JSON.stringify(path)}, JSON.stringify({ ...${JSON.stringify(metadata)}, suite: ${JSON.stringify(name)}, cases: captured }, null, 2) + "\\n"); });\n`;
let shared = readFileSync(sources[1], "utf8")
  .replace("import { describe, expect, it }", "import { afterAll, describe, expect, it }")
  .replace("  packSession,", "  packSession as originalPackSession,");
shared +=
  wrapper +
  footer("original shared session-plan tests", "test/fixtures/session-plan-base-1e15737.json");
writeFileSync("packages/shared/test/t06-capture-only.test.ts", shared);
let api = readFileSync(sources[2], "utf8").replace(
  "  packSession,",
  "  packSession as originalPackSession,",
);
api = api.replace(
  "const roles = assignRoles(prePack.map((e) => toPackCandidate(goal, e)));",
  `const packInput = { candidates: prePack.map((e) => toPackCandidate(goal, e)), minutesPerDay: minutes, restSec: restSecFor(goal) };\n              const packedBaseline = originalPackSession(packInput);\n              captured.push({ key: label + "/" + session.day, input: packInput, output: packedBaseline });\n              const roles = assignRoles(prePack.map((e) => toPackCandidate(goal, e)));`,
);
api +=
  wrapper +
  footer(
    "program-packer original 225 programs / 900 actual-catalog sessions",
    "../../packages/shared/test/fixtures/program-packer-base-1e15737.json",
  );
writeFileSync("apps/api/test/t06-capture-only.spec.ts", api);
console.log(JSON.stringify(metadata, null, 2));
