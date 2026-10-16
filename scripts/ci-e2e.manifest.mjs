/** Independent expected cases, real Playwright discovery, and owned execution evidence. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { URL, fileURLToPath } from "node:url";

export const MANIFEST_PATH = "apps/web/e2e/ci-manifest.json";
const CONFIGS = [
  "playwright.config.ts",
  "playwright.v2-split.config.ts",
  "playwright.fact-window.config.ts",
];
const BROWSERS = ["chromium-mobile", "webkit-ios"];
const slash = (value) => value.replaceAll("\\", "/");
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code, detail = "") {
  const error = new Error(`${code}${detail ? `: ${detail}` : ""}`);
  error.code = code;
  throw error;
}
export const caseKey = (row) =>
  JSON.stringify([row.file, row.case, row.browser, row.repeatEachIndex]);
const discoveryKey = (row) => JSON.stringify([row.config, caseKey(row)]);
export function requiredCases(manifest, stage) {
  if (!["product", "m0"].includes(stage)) fail("UNKNOWN_STAGE");
  const rows = manifest.cases.filter((row) => stage === "product" || row.stage === stage);
  if (!rows.length) fail("EMPTY_STAGE", stage);
  return rows;
}

/** Filesystem, not git index: a newly authored untracked spec must fail mapping too. */
export function inventorySpecs(readDirectory) {
  const result = [];
  function walk(dir) {
    for (const entry of readDirectory(dir)) {
      if (
        ["node_modules", "profiles", "profile"].includes(entry.name) ||
        entry.name.startsWith(".")
      )
        continue;
      const file = `${dir}/${entry.name}`;
      if (entry.directory) walk(file);
      else if (entry.name.endsWith(".spec.ts")) result.push(file);
    }
  }
  walk("apps/web/e2e");
  return result.sort();
}
export function readInventory(root) {
  return inventorySpecs((dir) =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).map((e) => ({
      name: e.name,
      directory: e.isDirectory(),
    })),
  );
}

export function validateManifest(manifest, files, phases, stage) {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.cases) ||
    !Array.isArray(manifest.exclusions)
  )
    fail("MANIFEST_SCHEMA");
  const required = requiredCases(manifest, stage);
  const seen = new Set();
  for (const row of [...manifest.cases, ...manifest.exclusions]) {
    if (
      !/^apps\/web\/e2e\/(?!.*(?:\.\.|\\)).+\.spec\.ts$/.test(row.file) ||
      !Array.isArray(row.case) ||
      !row.case.length ||
      row.case.some((t) => typeof t !== "string" || !t) ||
      !["product", "m0"].includes(row.stage) ||
      !row.requirement ||
      !BROWSERS.includes(row.browser) ||
      !CONFIGS.includes(row.config) ||
      !Number.isInteger(row.repeatEachIndex) ||
      row.repeatEachIndex < 0 ||
      row.principalScope !== "fresh-per-phase" ||
      row.requiredOutcome !== "passed"
    )
      fail("MANIFEST_SCHEMA");
    if (!files.includes(row.file)) fail("MISSING_FILE", row.file);
    const key = caseKey(row);
    if (seen.has(key)) fail("DUPLICATE_CASE", key);
    seen.add(key);
  }
  for (const row of manifest.exclusions) {
    if (
      row.browser !== "webkit-ios" ||
      !row.case.join(" ").includes("@chromium-only") ||
      row.condition !== "webkit-chromium-only" ||
      !row.reason ||
      !manifest.cases.some(
        (c) =>
          c.browser === "chromium-mobile" &&
          c.config === row.config &&
          caseKey({ ...c, browser: row.browser }) === caseKey(row),
      )
    )
      fail("EXCLUSION_POLICY");
  }
  for (const row of manifest.conditional ?? []) {
    if (
      !row.reason ||
      !["default-friday-fixture", "chromium-project"].includes(row.condition) ||
      row.requiredOutcome !== "passed" ||
      !manifest.cases.some(
        (c) =>
          c.file === row.file &&
          c.browser === row.browser &&
          JSON.stringify(c.case) === JSON.stringify(row.case),
      )
    )
      fail("CONDITIONAL_POLICY");
  }
  const mapped = new Set(manifest.cases.map((row) => row.file));
  for (const file of files) if (!mapped.has(file)) fail("UNMAPPED_FILE", file);
  const names = phases.map((p) => p.name);
  if (new Set(names).size !== names.length) fail("DUPLICATE_PHASE");
  for (const row of manifest.cases) {
    const phase = phases.find((p) => p.name === row.phase);
    if (!phase || phase.project !== row.browser) fail("PHASE_PROVENANCE", row.phase);
    if (phaseConfig(phase) !== row.config) fail("CONFIG_PROVENANCE", row.phase);
  }
  for (const phase of phases)
    if (!manifest.cases.some((r) => r.phase === phase.name)) fail("EMPTY_PHASE", phase.name);
  return required;
}

function sameSet(expected, actual, key, code) {
  const e = new Set(expected.map(key));
  const a = new Set(actual.map(key));
  if (
    a.size !== actual.length ||
    e.size !== expected.length ||
    e.size !== a.size ||
    [...e].some((k) => !a.has(k))
  )
    fail(code);
}
export function validateDiscovery(manifest, discovered, stage) {
  sameSet(requiredCases(manifest, stage), discovered, discoveryKey, "DISCOVERY_MISMATCH");
}
export function phaseConfig(phase) {
  const i = phase.args.indexOf("--config");
  return i < 0 ? "playwright.config.ts" : phase.args[i + 1];
}
export function validateSelections(manifest, selections, phases, stage) {
  const required = requiredCases(manifest, stage);
  const all = phases.flatMap((p) => selections[p.name] ?? []);
  for (const phase of phases)
    for (const r of selections[phase.name] ?? []) {
      if (r.config !== phaseConfig(phase)) fail("CONFIG_PROVENANCE", phase.name);
      if (r.browser !== phase.project) fail("PHASE_PROVENANCE", phase.name);
    }
  if (new Set(all.map(caseKey)).size !== all.length) fail("DUPLICATE_SELECTION");
  for (const phase of phases) {
    const rows = selections[phase.name];
    if (!rows?.length) {
      if (required.some((r) => r.phase === phase.name)) fail("SELECTION_MISMATCH", phase.name);
      fail("EMPTY_PHASE", phase.name);
    }
    sameSet(
      required.filter((r) => r.phase === phase.name),
      rows,
      caseKey,
      "SELECTION_MISMATCH",
    );
  }
  sameSet(required, all, caseKey, "SELECTION_MISMATCH");
}

/** JSON reporter v1.63: file suites precede describe suites; repeats share title/location. */
export function reportCases(report, root, config) {
  if (!Array.isArray(report?.suites) || !report.config?.rootDir || report.errors?.length)
    fail("REPORT_SCHEMA");
  if (
    typeof report.config.configFile !== "string" ||
    path.resolve(report.config.configFile) !== path.resolve(root, "apps/web", config)
  )
    fail("CONFIG_PROVENANCE");
  const rows = [];
  const repeats = new Map();
  function visit(suite, titles) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const file = slash(path.relative(root, path.resolve(report.config.rootDir, spec.file)));
        const row = { file, case: [...titles, spec.title], browser: test.projectName, config };
        const base = JSON.stringify([file, row.case, row.browser]);
        row.repeatEachIndex = repeats.get(base) ?? 0;
        repeats.set(base, row.repeatEachIndex + 1);
        rows.push({ ...row, spec, test });
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
  }
  for (const suite of report.suites) visit(suite, []);
  return rows;
}

export function discoveryEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (key.startsWith("PLAYWRIGHT_JSON_") || key.startsWith("PLAYWRIGHT_HTML_")) delete env[key];
  delete env.AFC_TEST_TODAY; // Default comes from e2e/test-today.ts, not a second date constant.
  delete env.AFC_E2E_CONTROL_TOKEN;
  const url = "postgresql://discovery:synthetic@127.0.0.1:1/afc_discovery_e2e";
  return { ...env, DATABASE_URL: url, DIRECT_URL: url, E2E_DATABASE_URL: url };
}
function launchDiscovery(request) {
  // Use the installed Playwright CLI directly on Windows: no cmd.exe argument interpolation.
  const require = createRequire(path.join(request.cwd, "package.json"));
  return spawnSync(
    process.execPath,
    [require.resolve("@playwright/test/cli"), "test", ...request.args],
    {
      cwd: request.cwd,
      env: request.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      shell: false,
    },
  );
}
export function discover(root, args, launch = launchDiscovery) {
  const actual = [...args, "--list", "--reporter=json", "--forbid-only"];
  const result = launch({ cwd: path.join(root, "apps/web"), args: actual, env: discoveryEnv() });
  if (result.error || result.signal || result.status !== 0) fail("DISCOVERY_CHILD");
  let report;
  try {
    // Existing base config prints its redacted database label before the reporter JSON.
    const stdout = String(result.stdout);
    report = JSON.parse(stdout.slice(stdout.search(/^\{/m)));
  } catch {
    fail("DISCOVERY_JSON");
  }
  const i = args.indexOf("--config");
  return reportCases(report, root, i < 0 ? "playwright.config.ts" : args[i + 1]);
}

export function preflight({
  root,
  manifest,
  phases,
  phaseArgs,
  stage = "product",
  launch,
  files = readInventory(root),
}) {
  const required = validateManifest(manifest, files, phases, stage);
  const configs = [...new Set(required.map((row) => row.config))];
  const discovered = configs.flatMap((config) => discover(root, ["--config", config], launch));
  // Check full configs before selecting stage phases; m0 smoke must not hide product cases.
  validateDiscovery(
    { ...manifest, cases: manifest.cases.filter((r) => configs.includes(r.config)) },
    discovered,
    "product",
  );
  const selectedPhases = phases.filter((p) => required.some((r) => r.phase === p.name));
  const selected = {};
  for (const phase of selectedPhases) {
    // phaseArgs returns the existing pnpm exec Playwright argv; keep its selectors intact.
    selected[phase.name] = discover(root, phaseArgs(phase).slice(3), launch);
  }
  validateSelections(manifest, selected, selectedPhases, stage);
  return {
    stage,
    files: files.length,
    cases: required.length,
    configs,
    phases: selectedPhases.map((p) => ({
      name: p.name,
      browser: p.project,
      config: phaseConfig(p),
      cases: selected[p.name].length,
    })),
    selectionHash: digest(required.map((row) => [row.phase, discoveryKey(row)]).sort()),
  };
}

export function validateExecution(evidence, context, expected) {
  if (!evidence?.report) fail("REPORT_MISSING");
  for (const key of ["sha", "run", "phase", "selectionHash", "root", "reportPath", "startedAt"])
    if (evidence.provenance?.[key] !== context[key]) fail("REPORT_PROVENANCE", key);
  const report = evidence.report;
  if (
    !Number.isFinite(Date.parse(report.stats?.startTime)) ||
    Date.parse(report.stats.startTime) < Date.parse(context.startedAt)
  )
    fail("STALE_REPORT");
  const actual = reportCases(report, context.root, expected[0]?.config);
  sameSet(expected, actual, caseKey, "EXECUTION_MISMATCH");
  if (!expected.length) fail("EMPTY_STAGE");
  if (report.config.projects.some((p) => p.retries !== 0 || (p.repeatEach ?? 1) !== 1))
    fail("REQUIRED_OUTCOME");
  for (const { spec, test } of actual) {
    if (
      !spec.ok ||
      spec.only ||
      test.expectedStatus !== "passed" ||
      test.status !== "expected" ||
      test.annotations?.some((a) => ["skip", "fixme", "only", "fail"].includes(a.type)) ||
      test.results?.length !== 1 ||
      test.results[0].status !== "passed" ||
      test.results[0].retry !== 0 ||
      test.results[0].error ||
      test.results[0].errors?.length ||
      test.results[0].annotations?.some((a) => ["skip", "fixme", "only", "fail"].includes(a.type))
    )
      fail("REQUIRED_OUTCOME");
  }
}

/** Validate the exact env the launcher will inherit before migration/server spawn. */
export function validateAllocation(owner, env, inspect, previous) {
  let db;
  try {
    db = new URL(env.DATABASE_URL);
  } catch {
    fail("OWNERSHIP");
  }
  const binding = inspect?.NetworkSettings?.Ports?.["5432/tcp"];
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    db.hostname !== "127.0.0.1" ||
    Number(db.port) !== owner.dbPort ||
    !owner.names.includes(db.pathname.slice(1)) ||
    !db.pathname.endsWith("_e2e") ||
    env.DATABASE_URL !== env.DIRECT_URL ||
    env.DATABASE_URL !== env.E2E_DATABASE_URL ||
    env.E2E_DEV_USER_ID !== owner.e2eUser ||
    env.AFC_TEST_RUN_ID !== owner.run ||
    env.AFC_POSITION_PROFILE_ROOT !== owner.profiles ||
    inspect.Id !== owner.containerId ||
    inspect.Name !== `/${owner.container}` ||
    inspect.Config?.Labels?.["afc.run"] !== owner.run ||
    binding?.length !== 1 ||
    binding[0].HostIp !== "127.0.0.1" ||
    Number(binding[0].HostPort) !== owner.dbPort
  )
    fail("OWNERSHIP");
  for (const key of ["run", "containerId", "container", "e2eUser", "profiles", "output"])
    if (!owner[key] || previous.some((p) => p[key] === owner[key])) fail("ALLOCATION_REUSE", key);
}

export function parseStage(args) {
  if (!args.length) return "product";
  if (args.length !== 2 || args[0] !== "--stage" || !["product", "m0"].includes(args[1]))
    fail("UNKNOWN_STAGE");
  return args[1];
}
export function loadManifest(root) {
  return JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { phases, phaseArgs } = await import("./ci-e2e.mjs");
  const summary = preflight({
    root,
    manifest: loadManifest(root),
    phases,
    phaseArgs,
    stage: parseStage(process.argv.slice(2)),
  });
  const ledger = JSON.parse(readFileSync(path.join(root, "regression/ledger.json"), "utf8"));
  console.log(
    JSON.stringify(
      {
        ...summary,
        preservedUnported: ledger.rows.filter((r) => r.status === "preserved-unported").length,
        scope: "discovery-only; no servers/DB; not m0-final/product execution",
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Complete this module's evaluation before the runner imports it back.
  // Top-level await here would deadlock that cycle (Node exits 13).
  main().catch((error) => {
    console.error(error.code ?? "MANIFEST_FAILED");
    process.exitCode = 1;
  });
}
