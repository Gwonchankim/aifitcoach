/**
 * F-3 forward migration 을 **실제로 실행해 보는** 일회용 DB harness.
 *
 * 왜 필요한가: `.08.1/native` 는 forward migration 이 만든 matrix CHECK 때문에 **적용 후 DB 에서는
 * 삽입 자체가 불가능**하다. 그래서 preflight 와 두 재분류 UPDATE 는 post-migration fixture 로
 * 검증할 수 없다 — SQL 문자열 존재 검사는 조건 완화·반전·누락을 못 잡는다.
 *
 * 방식: **일회용 DB** 를 만들어 original migration 까지만 올린 pre-fixup 상태를 재현하고,
 * 그 위에 **실제 forward SQL 파일**을 그대로 적용한다.
 *
 * 안전 경계:
 *   - 공유 dev(`afc`)·test(`afc_test`) DB 에는 invalid fixture 를 만들지 않는다.
 *   - 이 harness 가 만든 **정확한 이름의 DB 만** `finally` 에서 지운다.
 *   - **repo 의 migration 파일을 수정하지 않는다.** mutation 은 파일 내용을 읽어 변형한 뒤
 *     임시 디렉터리 사본에만 쓴다 — 원본을 고치면 jest globalSetup 의 `migrate deploy` 가
 *     `afc_test` 에서 checksum 불일치로 전부 깨진다.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

export const FORWARD_MIGRATION = "20260827180000_f3_fixup_assistance_lifecycle";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const SCHEMA_FILE = join(__dirname, "..", "..", "prisma", "schema.prisma");

/** 실제 forward migration SQL. mutation 은 이 문자열을 변형해 사본에만 쓴다. */
export function forwardMigrationSql(): string {
  return readFileSync(join(MIGRATIONS_DIR, FORWARD_MIGRATION, "migration.sql"), "utf8");
}

function adminUrl(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

function probeUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdmin(base: string, sql: string): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl(base) } } });
  try {
    await admin.$executeRawUnsafe(sql);
  } finally {
    await admin.$disconnect();
  }
}

export interface ProbeResult {
  /** forward migration 적용이 성공했는가. preflight 가 막으면 false. */
  forwardApplied: boolean;
  /** 실패했다면 그 출력(자격증명은 담기지 않는다 — prisma 는 DB 이름만 찍는다). */
  failure?: string;
}

export interface ProbeHandle {
  prisma: PrismaClient;
  /** 실제 forward SQL(또는 변형본)을 migration 으로 적용한다. */
  applyForward(sql: string): ProbeResult;
}

/**
 * original migration 까지만 올린 일회용 DB 를 만들고 `body` 를 실행한다.
 * DB 와 임시 디렉터리는 이 함수가 만든 것만 `finally` 에서 지운다.
 */
export async function withPreFixupDatabase<T>(
  baseUrl: string,
  label: string,
  body: (handle: ProbeHandle) => Promise<T>,
): Promise<T> {
  const database = `afc_f3_probe_${label}`;
  const workdir = mkdtempSync(join(tmpdir(), "afc-f3-probe-"));
  const url = probeUrl(baseUrl, database);
  let prisma: PrismaClient | undefined;

  // 이전 실행이 비정상 종료했을 수 있다. 같은 이름만 지운다.
  await withAdmin(baseUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await withAdmin(baseUrl, `CREATE DATABASE "${database}"`);

  try {
    // migrations 사본에서 forward 만 뺀다 → original 까지의 pre-fixup 상태.
    const migrations = join(workdir, "migrations");
    cpSync(MIGRATIONS_DIR, migrations, { recursive: true });
    rmSync(join(migrations, FORWARD_MIGRATION), { recursive: true, force: true });
    const schema = join(workdir, "schema.prisma");
    cpSync(SCHEMA_FILE, schema);

    const deploy = (): ProbeResult => {
      try {
        execFileSync(
          "pnpm",
          ["--filter", "api", "exec", "prisma", "migrate", "deploy", "--schema", schema],
          {
            cwd: join(__dirname, "..", "..", "..", ".."),
            env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
            stdio: "pipe",
            shell: process.platform === "win32",
          },
        );
        return { forwardApplied: true };
      } catch (error) {
        const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
        return {
          forwardApplied: false,
          failure: `${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`,
        };
      }
    };

    const original = deploy();
    if (!original.forwardApplied) {
      throw new Error(`pre-fixup 상태를 만들지 못했다:\n${original.failure}`);
    }

    prisma = new PrismaClient({ datasources: { db: { url } } });
    return await body({
      prisma,
      applyForward(sql: string): ProbeResult {
        const dir = join(migrations, FORWARD_MIGRATION);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "migration.sql"), sql, "utf8");
        return deploy();
      },
    });
  } finally {
    await prisma?.$disconnect();
    rmSync(workdir, { recursive: true, force: true });
    await withAdmin(baseUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }
}
