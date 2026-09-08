/** Remediated migration output / external adversarial wire fixture -> actual wire/UI recovery.
 * Neither mode proves public-API snapshot creation.
 * Existing 136-case IDs (session-set-assistance-wire.spec.ts:94-125,309-330,632-637):
 * external assisted ID e_assisted_pullup external snapshot sample0 (also sample1/2/3)
 * external assisted ID e_assisted_dips external snapshot sample0 (also sample1/2/3)
 * allowed assistance e_assisted_pullup remediated calibration null sample0 (also sample1/2/3)
 * allowed assistance e_assisted_dips remediated calibration null sample0 (also sample1/2/3)
 * Remediated prescription authority: migration 20260827180000 (b), lines 49-56,
 * preservation clause 113: null weight / ASSISTANCE_CALIBRATION_NEEDED / confidence 0.
 * Weight/reason match those 136 calibration cases; confidence deliberately differs from
 * their base 0.63 because the migration corrects it to 0. This projects load_calibration_needed.
 * The external minimum-reason combination is an adversarial 136 wire matrix item,
 * not an established historical-writer output (136:118 explicitly describes that guard).
 * INSERT metadata is validated by the matrix CHECK (migration:65-80). The immutable
 * trigger is BEFORE UPDATE only (100-103) and does not participate in INSERT validation.
 * All CHECKs/triggers remain enabled. The data module derives values from pinned source bytes.
 * Native history establishes the GET display gate only, not external recommendation evidence.
 * The target must remain scheduled, so this preparation cannot add a completed-session sample.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Prisma, PrismaClient } from "@prisma/client";
import { deriveAssistanceHistoricalData } from "./assistance-append-historical-data";

const EPIC = "94e4d6c6-1729-4f1a-8e1b-7baa84b487da";
const EVIDENCE = path.resolve("C:/Users/amole/.traycer/evidence", EPIC, "sprint-03-generator");
const IDS = ["e_assisted_pullup", "e_assisted_dips"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runFile = promisify(execFile);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type FailureCode =
  | "OWNERSHIP_ENV"
  | "OWNERSHIP_URL"
  | "OWNERSHIP_ROOT"
  | "OWNERSHIP_MANIFEST"
  | "OWNERSHIP_CONTAINER"
  | "OWNERSHIP_IO"
  | "PATH_SYMLINK"
  | "PATH_REDIRECT"
  | "SOURCE_DERIVATION"
  | "DATABASE_IO"
  | "DATABASE_IDENTITY"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_SCHEDULED"
  | "GROUP_EXISTS"
  | "CLAIM_EXISTS"
  | "INSERT_COUNT"
  | "DECIMAL_MISMATCH"
  | "RAW_MISMATCH"
  | "FINGERPRINT_DRIFT"
  | "DISCONNECT_AFTER_COMMIT";
class FixtureFailure extends Error {
  constructor(
    readonly code: FailureCode,
    prismaCode?: string,
  ) {
    super(`Historical fixture failed: ${code}${prismaCode ? ` (${prismaCode})` : ""}`);
  }
}
const refuse = (code: FailureCode) => new FixtureFailure(code);
function sanitized(error: unknown, fallback: FailureCode) {
  if (error instanceof FixtureFailure) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return new FixtureFailure(
    fallback,
    typeof code === "string" && /^P\d{4}$/.test(code) ? code : undefined,
  );
}
type Input = { sessionId: string; expectedOwnerId: string; mode: "external" | "remediated" };
type Manifest = {
  label: string;
  container: string;
  names: string[];
  dbPort: number;
  run: string;
  e2eUser: string;
};

async function plainPath(file: string) {
  for (let current = file; ; current = path.dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw refuse("PATH_SYMLINK");
    if (path.dirname(current) === current) break;
  }
  if ((await realpath(file)).toLowerCase() !== file.toLowerCase()) throw refuse("PATH_REDIRECT");
}

async function ownership(input: Input) {
  const urlText = process.env.E2E_DATABASE_URL;
  const run = process.env.AFC_TEST_RUN_ID;
  const profileRoot = process.env.AFC_POSITION_PROFILE_ROOT;
  if (
    !urlText ||
    urlText !== process.env.DATABASE_URL ||
    urlText !== process.env.DIRECT_URL ||
    !run ||
    !UUID.test(run) ||
    !profileRoot ||
    !UUID.test(input.sessionId) ||
    !UUID.test(input.expectedOwnerId) ||
    input.expectedOwnerId !== process.env.E2E_DEV_USER_ID ||
    !["external", "remediated"].includes(input.mode)
  )
    throw refuse("OWNERSHIP_ENV");
  const url = new URL(urlText);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !/^\/afc_(?:gen|eval)_s03_[a-z0-9_]{3,28}_e2e$/.test(url.pathname) ||
    !url.port ||
    url.search ||
    url.hash
  )
    throw refuse("OWNERSHIP_URL");
  const root = path.resolve(profileRoot);
  if (
    !root.startsWith(EVIDENCE + path.sep) ||
    !/^(chromium|webkit)-owned-profiles$/.test(path.basename(root))
  )
    throw refuse("OWNERSHIP_ROOT");
  const output = path.dirname(root);
  await plainPath(root);
  const manifestPaths = ["ownership.json", "container-ownership.json"].map((name) =>
    path.join(output, name),
  );
  for (const file of manifestPaths) await plainPath(file);
  const texts = await Promise.all(manifestPaths.map((file) => readFile(file, "utf8")));
  const owner = JSON.parse(texts[0]) as Manifest;
  const container = JSON.parse(texts[1]) as Pick<Manifest, "container" | "run" | "names"> & {
    containerId: string;
  };
  const names = [`afc_${owner.label}_test`, `afc_${owner.label}_e2e`];
  if (
    !/^(gen|eval)_s03_[a-z0-9_]{3,28}$/.test(owner.label) ||
    owner.container !== `afc_${owner.label}` ||
    container.container !== owner.container ||
    owner.run !== run ||
    container.run !== run ||
    owner.e2eUser !== input.expectedOwnerId ||
    !Number.isInteger(owner.dbPort) ||
    String(owner.dbPort) !== url.port ||
    JSON.stringify(owner.names) !== JSON.stringify(names) ||
    JSON.stringify(container.names) !== JSON.stringify(names) ||
    url.pathname !== `/${names[1]}` ||
    !/^[a-f0-9]{64}$/.test(container.containerId)
  )
    throw refuse("OWNERSHIP_MANIFEST");
  const inspect = await runFile(
    "docker",
    [
      "inspect",
      "--format",
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "afc.run"}}|{{.State.Running}}|{{json (index .NetworkSettings.Ports "5432/tcp")}}',
      container.containerId,
    ],
    { windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 8192 },
  );
  const [id, name, label, running, binding] = inspect.stdout.trim().split("|");
  const ports = JSON.parse(binding) as { HostIp: string; HostPort: string }[];
  if (
    id !== container.containerId ||
    name !== `/${owner.container}` ||
    label !== run ||
    running !== "true" ||
    ports.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== url.port
  )
    throw refuse("OWNERSHIP_CONTAINER");
  return {
    urlText,
    database: names[1],
    run,
    containerId: id,
    label: owner.label,
    manifestHashes: texts.map(sha),
  };
}

// Static names only; never interpolate request/environment identifiers into SQL.
const TABLES = [
  "planned_sets",
  "programs",
  "workout_sessions",
  "performed_sets",
  "sync_mutations",
  "assistance_audits",
  "access_audits",
  "user_rir_calibration",
  "calibration_set",
  "estimated_1rm",
  "muscle_weekly_load",
  "exercises",
] as const;
async function fingerprint(tx: Prisma.TransactionClient, excludedIds: string[]) {
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const table of TABLES) {
    const where = table === "planned_sets" ? 'WHERE NOT (t."id" = ANY($1::uuid[]))' : "";
    const [row] = await tx.$queryRawUnsafe<{ count: bigint; content: string }[]>(
      `SELECT count(*) AS count, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]') AS content FROM "public"."${table}" t ${where}`,
      ...(table === "planned_sets" ? [excludedIds] : []),
    );
    result[table] = { count: Number(row.count), sha256: sha(row.content) };
  }
  return result;
}

/** Inserts two snapshots with the mode-specific authorities cited above; no native snapshot UPDATE.
 * Public /me and API session creation happen in the caller before this fixture; this is not auth proof.
 */
export async function installAssistanceHistoricalSnapshot(input: Input) {
  let db: PrismaClient | undefined;
  let stage: FailureCode = "OWNERSHIP_IO";
  try {
    const guard = await ownership(input);
    stage = "SOURCE_DERIVATION";
    const data = deriveAssistanceHistoricalData(input.mode);
    stage = "DATABASE_IO";
    db = new PrismaClient({ datasources: { db: { url: guard.urlText } } });
    const result = await db.$transaction(
      async (tx) => {
        const [identity] = await tx.$queryRaw<
          { name: string }[]
        >`SELECT current_database() AS name`;
        if (identity.name !== guard.database) throw refuse("DATABASE_IDENTITY");
        const session = await tx.workoutSession.findFirst({
          where: {
            id: input.sessionId,
            program: { userId: input.expectedOwnerId },
          },
        });
        if (!session) throw refuse("SESSION_NOT_FOUND");
        // Same program -> session order as the product writers; no existing row is changed.
        await tx.$queryRaw`SELECT id FROM programs WHERE id = ${session.programId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM workout_sessions WHERE id = ${session.id}::uuid FOR UPDATE`;
        const current = await tx.workoutSession.findFirst({
          where: {
            id: input.sessionId,
            program: { userId: input.expectedOwnerId },
          },
          include: { plannedSets: true },
        });
        if (!current) throw refuse("SESSION_NOT_FOUND");
        if (current.status !== "scheduled") throw refuse("SESSION_NOT_SCHEDULED");
        if (current.plannedSets.some((row) => IDS.some((id) => id === row.exerciseId)))
          throw refuse("GROUP_EXISTS");
        const claims = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM sync_mutations m
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.correlation_claims, '[]'::jsonb)) c
        WHERE c->>'session_id' = ${current.id}
          AND c->>'exercise_id' IN ('e_assisted_pullup','e_assisted_dips')`;
        if (claims[0].count !== 0n) throw refuse("CLAIM_EXISTS");
        const before = await fingerprint(tx, []);
        const order =
          current.plannedSets.reduce((max, row) => Math.max(max, row.orderIndex), -1) + 1;
        // Raw comes from exact matrix item IDs + migration (b); only placement/identity is new.
        const raw = data.rows.map((snapshot, index) => ({
          ...snapshot,
          id: randomUUID(),
          sessionId: current.id,
          clientCorrelationId: null,
          orderIndex: order + index,
        }));
        const created = await tx.plannedSet.createMany({ data: raw });
        const insertedIds = raw.map((row) => row.id);
        const inserted = await tx.plannedSet.findMany({
          where: { id: { in: insertedIds } },
          orderBy: { orderIndex: "asc" },
        });
        if (created.count !== 2 || inserted.length !== 2) throw refuse("INSERT_COUNT");
        for (const [index, expected] of raw.entries()) {
          const actual = inserted[index];
          for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
            const value = actual[key];
            if (value instanceof Prisma.Decimal) {
              if (expected[key] === null || !value.equals(String(expected[key])))
                throw refuse("DECIMAL_MISMATCH");
            } else if (value !== expected[key]) throw refuse("RAW_MISMATCH");
          }
        }
        const after = await fingerprint(tx, insertedIds);
        if (JSON.stringify(before) !== JSON.stringify(after)) throw refuse("FINGERPRINT_DRIFT");
        return {
          sessionId: current.id,
          ownerId: input.expectedOwnerId,
          mode: input.mode,
          insertedIds,
          raw,
          sourceProvenance: data.provenance,
          inserted: JSON.parse(JSON.stringify(inserted)) as unknown,
          unchanged: { before, after },
          allowedDifference:
            "Exactly two new planned rows; all fingerprinted existing rows unchanged.",
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 10_000,
      },
    );
    const connection = db;
    db = undefined;
    stage = "DISCONNECT_AFTER_COMMIT";
    await connection.$disconnect();
    return {
      ...result,
      committed: true as const,
      ownership: {
        database: guard.database,
        run: guard.run,
        containerId: guard.containerId,
        label: guard.label,
        manifestHashes: guard.manifestHashes,
      },
    };
  } catch (error) {
    try {
      await db?.$disconnect();
    } catch {
      // Cleanup failure cannot turn an already-failed fixture into success.
    }
    // Prisma/process/URL errors can contain connection strings. Never emit their payloads.
    throw sanitized(error, stage);
  }
}
