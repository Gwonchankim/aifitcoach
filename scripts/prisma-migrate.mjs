/**
 * Migration is a separate operational action. Runtime keeps DATABASE_URL on Neon pooler;
 * this script switches only the migration process to DIRECT_URL when present.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DIRECT_URL 또는 DATABASE_URL 이 필요하다.");
}

const result = spawnSync(
  "pnpm",
  ["--filter", "api", "exec", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
  {
    cwd: repositoryRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    // Windows .cmd shims need a shell; Linux Cloud Run invokes the binary directly.
    shell: process.platform === "win32",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
