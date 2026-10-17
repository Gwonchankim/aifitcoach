/** GitHub's disposable Linux runner only. Preserve the existing observer boundaries. */
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout, setImmediate } from "node:timers";
import {
  loadManifest,
  parseStage,
  preflight,
  requiredCases,
  validateAllocation,
  validateExecution,
  executionProjection,
  reportCases,
  digest,
  safeCode,
  makeProfile,
  profileEnv,
} from "./ci-e2e.manifest.mjs";
const { AbortController } = globalThis;

export const phases = [
  {
    name: "core-c",
    project: "chromium-mobile",
    args: ["--grep-invert", "owned persistent process"],
    core: true,
  },
  {
    name: "persistent-c",
    project: "chromium-mobile",
    args: ["16-session-position.spec.ts", "--grep", "owned persistent process"],
  },
  { name: "core-w", project: "webkit-ios", args: [], core: true },
  { name: "native-c", project: "chromium-mobile", args: ["18-assistance-append.spec.ts"] },
  { name: "historical-c", project: "chromium-mobile", args: ["19-assistance-historical.spec.ts"] },
  { name: "native-w", project: "webkit-ios", args: ["18-assistance-append.spec.ts"] },
  { name: "historical-w", project: "webkit-ios", args: ["19-assistance-historical.spec.ts"] },
  { name: "similar-c", project: "chromium-mobile", args: ["20-similar-init.spec.ts"] },
  { name: "weekly-focus-c", project: "chromium-mobile", args: ["21-weekly-focus-swap.spec.ts"] },
  { name: "weekly-focus-w", project: "webkit-ios", args: ["21-weekly-focus-swap.spec.ts"] },
  {
    name: "split-c",
    project: "chromium-mobile",
    args: ["22-split-preference.spec.ts", "--config", "playwright.v2-split.config.ts"],
  },
  {
    name: "split-w",
    project: "webkit-ios",
    args: ["22-split-preference.spec.ts", "--config", "playwright.v2-split.config.ts"],
  },
  {
    name: "cardio-c",
    project: "chromium-mobile",
    args: ["23-cardio-prescription-read.spec.ts", "--config", "playwright.v2-split.config.ts"],
  },
  {
    name: "cardio-w",
    project: "webkit-ios",
    args: ["23-cardio-prescription-read.spec.ts", "--config", "playwright.v2-split.config.ts"],
  },
  // BUG-10: the server's UTC "today" moves only through the fact-window harness bootstrap.
  {
    name: "fact-window-c",
    project: "chromium-mobile",
    args: ["24-fact-window.spec.ts", "--config", "playwright.fact-window.config.ts"],
  },
  {
    name: "fact-window-w",
    project: "webkit-ios",
    args: ["24-fact-window.spec.ts", "--config", "playwright.fact-window.config.ts"],
  },
  {
    name: "m0-direct-c",
    project: "chromium-mobile",
    args: ["m0-06-shell-api.spec.ts", "--grep", "M0-06 direct"],
    mode: "direct",
  },
  {
    name: "m0-direct-w",
    project: "webkit-ios",
    args: ["m0-06-shell-api.spec.ts", "--grep", "M0-06 direct"],
    mode: "direct",
  },
  {
    name: "m0-proxy-c",
    project: "chromium-mobile",
    args: ["m0-06-shell-api.spec.ts", "--grep", "M0-06 proxy"],
    mode: "proxy",
  },
  {
    name: "m0-proxy-w",
    project: "webkit-ios",
    args: ["m0-06-shell-api.spec.ts", "--grep", "M0-06 proxy"],
    mode: "proxy",
  },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const epic = "94e4d6c6-1729-4f1a-8e1b-7baa84b487da";
// Existing observers resolve this literal relative to apps/web on Linux. It is a
// disposable directory inside the checkout, NOT a Windows user directory.
const ownedBase = path.resolve(web, "C:/Users/amole/.traycer");
const outputBase = path.join(web, "e2e/.artifacts-ci");
const json = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
const privateRoot = path.join(tmpdir(), `afc-ci-private-${randomUUID()}`);
function privateFile(name, value) {
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(privateRoot, `${randomUUID()}-${name}`), value, {
    flag: "wx",
    mode: 0o600,
  });
}
function coded(code) {
  return Object.assign(new Error(code), { code });
}
const docker = (...args) => {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
    shell: false,
  });
  privateFile("docker-stdout", result.stdout ?? "");
  privateFile("docker-stderr", result.stderr ?? "");
  if (result.error || result.signal || result.status !== 0) throw coded("OPERATION_FAILED");
  return result.stdout.trim();
};

/** Bind both localhost address families; never reuse a listener or silently change a port. */
export async function freePort(port = 0, forbidden = []) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(coded("PORT_OCCUPIED")));
    server.listen({ host: "::", port, ipv6Only: false }, resolve);
  });
  const actual = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((e) => (e ? reject(coded("PORT_OCCUPIED")) : resolve())),
  );
  if (forbidden.includes(actual)) throw coded("PORT_OCCUPIED");
  return actual;
}

export function phaseArgs(phase) {
  const args = ["exec", "playwright", "test", ...phase.args];
  if (phase.core)
    args.push(
      ...Array.from(
        { length: 18 },
        (_, i) => `^.*[/\\\\]${String(i).padStart(2, "0")}-.*\\.spec\\.ts$`,
      ),
    );
  args.push("--project", phase.project, "--output", path.join(outputBase, phase.name));
  return args;
}

export function cleanContainer(id, container, run, command = docker) {
  const info = JSON.parse(command("inspect", id))[0];
  if (
    info.Id !== id ||
    info.Name !== `/${container}` ||
    info.Config.Labels["afc.run"] !== run ||
    info.Config.Labels["afc.owner"] !== "automation-m0-06" ||
    info.Config.Labels["afc.purpose"] !== "owned-e2e"
  )
    throw new Error("Refusing cleanup: container ownership mismatch");
  command("stop", id);
  command("rm", "-v", id);
  if (command("ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}") !== "")
    throw coded("CLEANUP_FAILED");
  return { exactContainerAbsent: true };
}

// Private identity marker: preserve the original Error without trusting/mutating its fields.
const cleanupFailures = new WeakSet();

/** Keep the original failure even when owned-resource cleanup also fails. */
export async function withCleanup(operation, cleanup) {
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  try {
    await cleanup();
  } catch (caught) {
    if (error) throw new AggregateError([error, caught], "Phase and owned cleanup failed");
    if (caught instanceof Error) cleanupFailures.add(caught);
    throw caught;
  }
  if (error) throw error;
}

/** The same boundary is used by the real runner and fake launchers (no DB in unit tests). */
export function privateLaunch(command, args, options, onSpawn = () => {}) {
  return new Promise((resolve) => {
    const { signal: abortSignal, timeout, ...spawnOptions } = options;
    if (abortSignal?.aborted) {
      resolve({ status: null, error: abortSignal.reason ?? coded("CHILD_FAILED") });
      return;
    }
    let child;
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let error;
    let status = null;
    let signal = null;
    let settled = false;
    let stopping = false;
    let deadline;
    let killTimer;
    let drainTimer;
    let timeoutTimer;
    try {
      // Own cancellation: Node's PID-only timeout/abort cannot close inherited stdio.
      child = spawn(command, args, spawnOptions);
    } catch (caught) {
      resolve({ status: null, error: caught });
      return;
    }
    const ownedPid =
      spawnOptions.detached === true && Number.isInteger(child.pid) && child.pid > 1
        ? child.pid
        : undefined;
    const finish = (closed = false) => {
      if (settled) return;
      settled = true;
      for (const timer of [deadline, killTimer, drainTimer, timeoutTimer]) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      if (!closed) {
        error ??= coded("CHILD_FAILED");
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve({
        status,
        signal,
        error,
        pid: ownedPid,
        closed,
        stdout: Buffer.concat(chunks.stdout),
        stderr: Buffer.concat(chunks.stderr),
      });
    };
    const send = (kind) => {
      if (!ownedPid) return;
      try {
        if (process.platform === "linux") process.kill(-ownedPid, kind);
        else child.kill(kind);
      } catch {
        // Preserve the initiating failure; cleanup independently verifies group absence.
      }
    };
    const stop = (caught) => {
      if (settled) return;
      error ??= caught;
      if (stopping) return;
      stopping = true;
      clearTimeout(drainTimer);
      send("SIGTERM");
      killTimer = setTimeout(() => send("SIGKILL"), 2000);
      // Even an ignored TERM or an open descendant pipe cannot prevent cleanup entry.
      deadline = setTimeout(() => finish(false), 4000);
    };
    const abort = () => stop(abortSignal.reason ?? coded("CHILD_FAILED"));
    for (const channel of ["stdout", "stderr"]) {
      child[channel].on("data", (data) => {
        if (settled) return;
        bytes += data.length;
        if (bytes <= 32 * 1024 * 1024) chunks[channel].push(data);
        else stop(coded("OUTPUT_LIMIT"));
      });
      child[channel].on("error", () => stop(coded("PRIVATE_IO")));
    }
    child.on("error", stop);
    child.on("exit", (code, kind) => {
      status = code;
      signal = kind;
      if (!settled && !stopping) drainTimer = setTimeout(() => stop(coded("CHILD_FAILED")), 2000);
    });
    child.on("close", (code, kind) => {
      status = code;
      signal = kind;
      finish(true);
    });
    if (timeout > 0)
      timeoutTimer = setTimeout(
        () => stop(Object.assign(new Error("Owned child timed out"), { code: "ETIMEDOUT" })),
        timeout,
      );
    abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      if (ownedPid) onSpawn(ownedPid);
    } catch (caught) {
      stop(caught);
    }
    if (abortSignal?.aborted) abort();
  });
}

/** Runner-local G3: only exact, independently expected identities and counts leave private evidence. */
const M0_FILE = "apps/web/e2e/m0-06-shell-api.spec.ts";
export function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  )
    throw coded("REPORT_SCHEMA");
}
const natural = (n) => Number.isInteger(n) && n >= 0;
function networkKind(row) {
  if (
    row.file !== M0_FILE ||
    row.case?.length !== 2 ||
    !["M0-06 direct", "M0-06 proxy"].includes(row.case[0]) ||
    !["chromium-mobile", "webkit-ios"].includes(row.browser) ||
    !natural(row.repeatEachIndex)
  )
    throw coded("REPORT_SCHEMA");
  if (
    ["shell consumes real API contract", "fresh principal renders empty program"].includes(
      row.case[1],
    )
  )
    return { endpoint: "programs-current", minimum: 1 };
  if (row.case[1] === "real missing session renders recoverable error")
    return { endpoint: "session", minimum: 2 };
  throw coded("REPORT_SCHEMA");
}
export function networkProjection(raw, row, profile) {
  exactKeys(raw, ["unexpected", "expectedNetwork", "responses"]);
  const kind = networkKind(row);
  if (raw.unexpected !== 0 || !Array.isArray(raw.expectedNetwork) || !Array.isArray(raw.responses))
    throw coded("REPORT_SCHEMA");
  const base = new URL(profile.apiBase, profile.webOrigin).href;
  const validUrl = (url) =>
    typeof url === "string" &&
    (kind.endpoint === "programs-current"
      ? url === `${base}/programs/current`
      : url.startsWith(`${base}/sessions/`) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          url.slice(`${base}/sessions/`.length),
        ));
  if (row.case[0] !== `M0-06 ${profile.mode}`) throw coded("REPORT_PROVENANCE");
  for (const response of raw.responses) {
    exactKeys(response, ["url", "method", "status"]);
    if (!validUrl(response.url) || response.method !== "GET" || response.status !== 404)
      throw coded("REPORT_SCHEMA");
  }
  if (raw.responses.length < kind.minimum || new Set(raw.responses.map((r) => r.url)).size !== 1)
    throw coded("REPORT_SCHEMA");
  const seen = new Set();
  for (const item of raw.expectedNetwork) {
    exactKeys(item, ["url", "count"]);
    if (
      !validUrl(item.url) ||
      seen.has(item.url) ||
      !Number.isInteger(item.count) ||
      item.count < 1 ||
      item.count > raw.responses.filter((r) => r.url === item.url).length
    )
      throw coded("REPORT_SCHEMA");
    seen.add(item.url);
  }
  return {
    file: M0_FILE,
    case: [...row.case],
    browser: row.browser,
    repeatEachIndex: row.repeatEachIndex,
    endpoint: kind.endpoint,
    observed404: raw.expectedNetwork.reduce((n, r) => n + r.count, 0),
    responses404: raw.responses.length,
    unexpected: 0,
    attachmentDigest: digest(raw),
  };
}
export function validateNetworkProjection(rows, expected) {
  const required = expected.filter((r) => r.file === M0_FILE);
  if (!Array.isArray(rows) || rows.length !== required.length) throw coded("REPORT_SCHEMA");
  const key = (r) => JSON.stringify([r.file, r.case, r.browser, r.repeatEachIndex]);
  const seen = new Set();
  for (const row of rows) {
    exactKeys(row, [
      "file",
      "case",
      "browser",
      "repeatEachIndex",
      "endpoint",
      "observed404",
      "responses404",
      "unexpected",
      "attachmentDigest",
    ]);
    const identity = key(row),
      kind = networkKind(row);
    if (
      !required.some((r) => key(r) === identity) ||
      seen.has(identity) ||
      row.endpoint !== kind.endpoint ||
      !natural(row.observed404) ||
      !natural(row.responses404) ||
      row.responses404 < kind.minimum ||
      row.responses404 < row.observed404 ||
      row.unexpected !== 0 ||
      typeof row.attachmentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.attachmentDigest)
    )
      throw coded("REPORT_SCHEMA");
    seen.add(identity);
  }
  return rows;
}
function attachmentBytes(attachment, output) {
  if (typeof attachment.body === "string") {
    if (attachment.body.trimStart().startsWith("{")) return Buffer.from(attachment.body);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.body))
      throw coded("REPORT_SCHEMA");
    return Buffer.from(attachment.body, "base64");
  }
  if (typeof attachment.path !== "string" || attachment.path.split(/[\\/]/).includes(".."))
    throw coded("REPORT_SCHEMA");
  const parent = path.resolve(output),
    file = path.resolve(attachment.path);
  if (!file.startsWith(parent + path.sep) || realpathSync(parent) !== parent)
    throw coded("REPORT_PROVENANCE");
  let current = parent;
  for (const name of path.relative(parent, file).split(path.sep)) {
    current = path.join(current, name);
    if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)
      throw coded("REPORT_PROVENANCE");
  }
  return readFileSync(file);
}
export function collectNetworkDiagnostics(evidence, owner, context, expected) {
  validateExecution(evidence, context, expected);
  const actual = reportCases(evidence.report, context.root, expected[0]?.config);
  const result = actual
    .filter((r) => r.file === M0_FILE)
    .map((row) => {
      const attachments =
        row.test.results[0].attachments?.filter((a) => a.name === "m0-network-diagnostics") ?? [];
      if (attachments.length !== 1 || attachments[0].contentType !== "application/json")
        throw coded("REPORT_SCHEMA");
      let raw;
      try {
        raw = JSON.parse(attachmentBytes(attachments[0], owner.output).toString("utf8"));
      } catch {
        throw coded("REPORT_SCHEMA");
      }
      return networkProjection(raw, row, owner.profile);
    });
  return validateNetworkProjection(result, expected);
}

export const emptyInspection = (state = "notGenerated") => ({
  state,
  inputDigest: null,
  inputBytes: null,
  bytesInspected: null,
  entryCount: null,
});
const secretPatterns = (secrets) =>
  [
    ...new Set(
      secrets
        .filter((s) => typeof s === "string" && s)
        .flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]),
    ),
  ].map((s) => Buffer.from(s));
export function inspectBytes(value, secrets = []) {
  try {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return {
      inspection: {
        state: "inspected",
        inputDigest: createHash("sha256").update(input).digest("hex"),
        inputBytes: input.length,
        bytesInspected: input.length,
        entryCount: null,
      },
      detected: secretPatterns(secrets).some((pattern) => input.includes(pattern)),
    };
  } catch {
    return { inspection: emptyInspection("error"), detected: false };
  }
}
export function validateInspection(value, trace = false) {
  exactKeys(value, ["state", "inputDigest", "inputBytes", "bytesInspected", "entryCount"]);
  if (
    !["inspected", "notGenerated", "notInspected", "error"].includes(value.state) ||
    !(
      value.inputDigest === null ||
      (typeof value.inputDigest === "string" && /^[a-f0-9]{64}$/.test(value.inputDigest))
    ) ||
    ![value.inputBytes, value.bytesInspected].every((n) => n === null || natural(n)) ||
    (trace ? !(value.entryCount === null || natural(value.entryCount)) : value.entryCount !== null)
  )
    throw coded("REPORT_SCHEMA");
  if (
    value.state === "inspected" &&
    (value.inputDigest === null ||
      value.inputBytes === null ||
      value.bytesInspected === null ||
      (trace ? value.entryCount === null : value.inputBytes !== value.bytesInspected))
  )
    throw coded("REPORT_SCHEMA");
  if (
    ["notGenerated", "notInspected"].includes(value.state) &&
    [value.inputDigest, value.inputBytes, value.bytesInspected, value.entryCount].some(
      (v) => v !== null,
    )
  )
    throw coded("REPORT_SCHEMA");
  return value;
}
/** Read every inflated entry; neither ZIP bytes nor a partial/failed close proves inspection. */
export function playwrightUtils() {
  const fromWeb = createRequire(path.join(web, "package.json"));
  const fromTest = createRequire(fromWeb.resolve("@playwright/test/package.json"));
  const fromPlaywright = createRequire(fromTest.resolve("playwright/package.json"));
  return fromPlaywright("playwright-core/lib/utilsBundle");
}
export async function inspectTrace(file, secrets = [], adapters = {}) {
  let input;
  try {
    input = Buffer.isBuffer(file) ? file : readFileSync(file);
  } catch {
    return { inspection: emptyInspection("error"), detected: false };
  }
  const inspection = {
    state: "error",
    inputDigest: createHash("sha256").update(input).digest("hex"),
    inputBytes: input.length,
    bytesInspected: 0,
    entryCount: 0,
  };
  const patterns = secretPatterns(secrets);
  const carrySize = Math.max(0, ...patterns.map((p) => p.length)) - 1;
  let detected = false;
  try {
    const open =
      adapters.open ??
      ((buffer, callback) =>
        playwrightUtils().yauzl.fromBuffer(
          buffer,
          { lazyEntries: true, autoClose: false, validateEntrySizes: true },
          callback,
        ));
    await new Promise((resolve, reject) =>
      open(input, (error, zip) => {
        if (error || !zip) {
          reject(error ?? coded("PRIVATE_IO"));
          return;
        }
        let ended = false,
          failed = false;
        const fail = () => {
          if (failed) return;
          failed = true;
          try {
            zip.close();
          } catch {
            // The inspection remains error even when closing the invalid ZIP also fails.
          }
          reject(coded("PRIVATE_IO"));
        };
        zip.on("error", fail);
        zip.on("close", () => {
          if (!ended || failed) fail();
          else resolve();
        });
        zip.on("end", () => {
          ended = true;
          try {
            zip.close();
            if (zip.isOpen !== false) {
              fail();
              return;
            }
            setImmediate(() => {
              if (!failed) resolve();
            });
          } catch {
            fail();
          }
        });
        zip.on("entry", (entry) => {
          inspection.entryCount++;
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              fail();
              return;
            }
            let carry = Buffer.alloc(0),
              bytes = 0,
              streamEnded = false;
            stream.on("error", fail);
            stream.on("close", () => {
              if (!streamEnded) fail();
            });
            stream.on("data", (chunk) => {
              const data = Buffer.from(chunk);
              bytes += data.length;
              inspection.bytesInspected += data.length;
              const combined = Buffer.concat([carry, data]);
              if (patterns.some((p) => combined.includes(p))) detected = true;
              carry = carrySize > 0 ? combined.subarray(-carrySize) : Buffer.alloc(0);
            });
            stream.on("end", () => {
              streamEnded = true;
              if (failed) return;
              if (bytes !== entry.uncompressedSize) {
                fail();
                return;
              }
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      }),
    );
    inspection.state = "inspected";
  } catch {
    inspection.state = "error";
  }
  return { inspection, detected };
}

export async function executeOwnedPhase(
  { phase, owner, env, inspect, previous, context, expected },
  {
    launch = privateLaunch,
    writeProvenance = (c) => json(path.join(owner.output, "execution-provenance.json"), c),
    readEvidence = () => {
      const rawReport = readFileSync(context.reportPath);
      return {
        provenance: JSON.parse(
          readFileSync(path.join(owner.output, "execution-provenance.json"), "utf8"),
        ),
        report: JSON.parse(rawReport.toString("utf8")),
        rawReport,
      };
    },
    reportExists = existsSync,
    writePrivate = (name, data) =>
      writeFileSync(path.join(owner.output, name), data, { flag: "wx", mode: 0o600 }),
  } = {},
) {
  validateAllocation(owner, env, inspect, previous);
  if (
    !expected.length ||
    context.phase !== phase.name ||
    context.run !== owner.run ||
    env.PLAYWRIGHT_JSON_OUTPUT_NAME !== context.reportPath ||
    env.PLAYWRIGHT_JSON_OUTPUT_FILE !== context.reportPath ||
    path.dirname(context.reportPath) !== owner.output ||
    reportExists(context.reportPath)
  )
    throw new Error("Refusing empty or reused phase evidence");
  previous.push(owner);
  writeProvenance(context);
  let result;
  context.launchCount = (context.launchCount ?? 0) + 1;
  try {
    result = await launch(
      "pnpm",
      [...phaseArgs(phase), "--reporter=json", "--forbid-only"],
      {
        cwd: path.join(context.root, "apps/web"),
        stdio: "pipe",
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 3_600_000,
        detached: true,
        signal: context.abortSignal,
        shell: false,
        env,
      },
      (pid) => {
        context.childPid = pid;
      },
    );
  } catch (error) {
    writePrivate("spawn-error.txt", String(error?.stack ?? error));
    throw coded("CHILD_FAILED");
  }
  writePrivate("stdout.txt", result.stdout ?? "");
  writePrivate("stderr.txt", result.stderr ?? "");
  writePrivate(
    "launcher-state.json",
    JSON.stringify({
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      closed: result.closed,
    }),
  );
  if (result.error) writePrivate("spawn-error.txt", String(result.error.stack ?? result.error));
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`CI E2E child failed: ${phase.name}`);
  let evidence;
  try {
    evidence = readEvidence();
  } catch {
    throw new Error(`CI E2E report missing: ${phase.name}`);
  }
  validateExecution(evidence, context, expected);
  const proof = executionProjection(evidence, context, expected);
  proof.networkDiagnostics = collectNetworkDiagnostics(evidence, owner, context, expected);
  const secrets = [
    new URL(env.DATABASE_URL).password,
    env.FIELD_ENCRYPTION_KEY,
    env.AFC_N01_SENTINEL,
  ];
  const materials = {
    reporter: evidence.rawReport ?? JSON.stringify(evidence.report),
    config: JSON.stringify(evidence.report.config),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  proof.inspection = {};
  const matches = {};
  for (const [name, data] of Object.entries(materials)) {
    const checked = inspectBytes(data, secrets);
    proof.inspection[name] = validateInspection(checked.inspection);
    matches[name] = checked.detected;
    if (checked.inspection.state !== "inspected") throw coded("PRIVATE_IO");
  }
  proof.inspection.trace = emptyInspection();
  writePrivate("inspection-matches.json", JSON.stringify(matches));
  validateNetworkProjection(proof.networkDiagnostics, expected);
  return proof;
}

export async function runPhaseSeries(selectedPhases, execute) {
  if (!selectedPhases.length) throw new Error("Empty phase run");
  const results = [];
  for (const phase of selectedPhases) {
    try {
      await execute(phase);
      results.push({
        phase: phases.some((p) => p.name === phase.name) ? phase.name : "unknown",
        status: "passed",
      });
    } catch (error) {
      const cleanupOnly = cleanupFailures.delete(error);
      results.push({
        phase: phases.some((p) => p.name === phase.name) ? phase.name : "unknown",
        status: "failed",
        error: cleanupOnly ? "CLEANUP_FAILED" : safeCode(error),
        // Docker execFile errors can contain credentials in argv; preserve boundaries, not raw text.
        failures: cleanupOnly
          ? [{ boundary: "cleanup", code: "CLEANUP_FAILED" }]
          : error instanceof AggregateError
            ? error.errors.map((e, i) => ({
                boundary: i === 0 ? "phase" : "cleanup",
                code: safeCode(e, "OPERATION_FAILED"),
              }))
            : [{ boundary: "phase", code: safeCode(error, "OPERATION_FAILED") }],
      });
    }
  }
  return { results, exitCode: results.some((r) => r.status !== "passed") ? 1 : 0 };
}

export function publishSummary(result, output = (value) => console.log(value)) {
  const results = result.results.map((row) => ({
    phase: phases.some((p) => p.name === row.phase) ? row.phase : "unknown",
    status: row.status === "passed" ? "passed" : "failed",
    ...(row.status === "passed"
      ? {}
      : {
          error: safeCode({ code: row.error }),
          failures: (row.failures ?? []).map((f) => ({
            boundary: f.boundary === "cleanup" ? "cleanup" : "phase",
            code: safeCode(f, "OPERATION_FAILED"),
          })),
        }),
  }));
  output(JSON.stringify({ results, exitCode: results.some((r) => r.status !== "passed") ? 1 : 0 }));
}

export async function closeOwnedGroup(pid, signal = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 1) return { processGroupAbsent: true };
  const alive = () => {
    try {
      signal(-pid, 0);
      return true;
    } catch (e) {
      if (e.code === "ESRCH") return false;
      throw coded("CLEANUP_FAILED");
    }
  };
  const forced = alive();
  if (forced) {
    try {
      signal(-pid, "SIGTERM");
    } catch (e) {
      if (e.code !== "ESRCH") throw coded("CLEANUP_FAILED");
    }
    for (let i = 0; i < 20 && alive(); i++) await delay(100);
    if (alive())
      try {
        signal(-pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") throw coded("CLEANUP_FAILED");
      }
    for (let i = 0; i < 20 && alive(); i++) await delay(100);
  }
  if (alive()) throw coded("CLEANUP_FAILED");
  return { processGroupAbsent: true, forced };
}

export function cleanPhysical(physical, descriptor) {
  const parent = path.join(ownedBase, "p");
  const descriptorPath = path.join(physical, ".afc-position-root.json");
  if (
    path.dirname(physical) !== parent ||
    !/^[0-9a-f]{8}$/.test(path.basename(physical)) ||
    lstatSync(physical).isSymbolicLink() ||
    realpathSync(physical) !== physical ||
    lstatSync(descriptorPath).isSymbolicLink() ||
    realpathSync(descriptorPath) !== descriptorPath ||
    JSON.stringify(JSON.parse(readFileSync(descriptorPath, "utf8"))) !== JSON.stringify(descriptor)
  )
    throw coded("CLEANUP_FAILED");
  for (const entry of readdirSync(physical)) {
    if (entry === ".afc-position-root.json") continue;
    const child = path.join(physical, entry);
    if (
      !/^p-[a-zA-Z0-9]{6}$/.test(entry) ||
      lstatSync(child).isSymbolicLink() ||
      realpathSync(child) !== child
    )
      throw coded("CLEANUP_FAILED");
    const markerPath = path.join(child, "position-owner.json");
    if (lstatSync(markerPath).isSymbolicLink() || realpathSync(markerPath) !== markerPath)
      throw coded("CLEANUP_FAILED");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker.profile !== child || !marker.token) throw coded("CLEANUP_FAILED");
  }
  rmSync(physical, { recursive: true });
  if (existsSync(physical)) throw coded("CLEANUP_FAILED");
  return { physicalProfileAbsent: true };
}

const allocationOperations = new WeakMap();
const releasedAllocations = new WeakSet();
const failedAllocations = new WeakMap();
export const allocationFailure = (error) => failedAllocations.get(error);

/** Preparation owns rollback until it successfully transfers this handle to its caller. */
export async function allocateOwnedPhase(
  { phaseName, mode = "direct", usedPorts = [], fixedPorts, previous = [], abortSignal },
  adapters = {},
) {
  if (
    typeof phaseName !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phaseName) ||
    !["direct", "proxy"].includes(mode)
  )
    throw coded("OWNERSHIP");
  const ops = {
    base: ownedBase,
    command: docker,
    port: freePort,
    wait: delay,
    group: closeOwnedGroup,
    mkdir: mkdirSync,
    writeJson: json,
    physicalCleanup: cleanPhysical,
    ready: (id) =>
      spawnSync("docker", ["exec", id, "pg_isready", "-U", "postgres"], {
        stdio: "ignore",
        timeout: 5000,
      }).status === 0,
    git: () => {
      const r = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      });
      if (r.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(r.stdout)) throw coded("OWNERSHIP");
      return r.stdout.trim();
    },
    ...adapters,
  };
  const run = randomUUID(),
    token = randomBytes(4).toString("hex"),
    label = `gen_s03_ci_${token}`;
  const output = path.join(
    ops.base,
    "evidence",
    epic,
    "sprint-03-generator",
    `${phaseName}-${token}`,
  );
  const profiles = path.join(
    output,
    `${phaseName.endsWith("-w") ? "webkit" : "chromium"}-owned-profiles`,
  );
  const physical = path.join(ops.base, "p", token);
  const descriptor = { v: 1, epic, manifestRoot: profiles, physicalRoot: physical, token: run };
  const handle = {
    run,
    token,
    label,
    container: `afc_${label}`,
    names: [`afc_${label}_test`, `afc_${label}_e2e`],
    user: randomUUID(),
    output,
    profiles,
    physical,
    descriptor,
    physicalCreated: false,
    physicalMarked: false,
    containerAttempted: false,
    id: undefined,
    ports: [],
    owner: undefined,
    env: undefined,
    context: {
      run,
      phase: phaseName,
      root,
      reportPath: path.join(output, "playwright-results.json"),
      startedAt: new Date().toISOString(),
      abortSignal,
      launchCount: 0,
    },
  };
  allocationOperations.set(handle, ops);
  let cleanup;
  try {
    if (abortSignal?.aborted) throw coded("CHILD_FAILED");
    ops.mkdir(profiles, { recursive: true, mode: 0o700 });
    ops.mkdir(path.dirname(physical), { recursive: true });
    ops.mkdir(physical, { mode: 0o700 });
    handle.physicalCreated = true;
    ops.writeJson(path.join(profiles, "physical-root.json"), descriptor);
    ops.writeJson(path.join(physical, ".afc-position-root.json"), descriptor);
    handle.physicalMarked = true;
    const password = randomBytes(24).toString("hex");
    handle.containerAttempted = true;
    handle.id = ops.command(
      "run",
      "-d",
      "--name",
      handle.container,
      "--label",
      `afc.run=${run}`,
      "--label",
      "afc.owner=automation-m0-06",
      "--label",
      "afc.purpose=owned-e2e",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    );
    if (!/^[a-f0-9]{64}$/.test(handle.id ?? "")) throw coded("OWNERSHIP");
    const info = JSON.parse(ops.command("inspect", handle.id))[0];
    const port = Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      if (ops.ready(handle.id)) {
        ready = true;
        break;
      }
      await ops.wait(1000);
    }
    if (!ready) throw coded("OPERATION_FAILED");
    const apiPort = await ops.port(fixedPorts?.api ?? 0, [...usedPorts, port]);
    handle.ports.push(apiPort);
    const webPort = await ops.port(0, [...usedPorts, port, apiPort]);
    handle.ports.push(webPort);
    const profile = makeProfile(mode, apiPort, webPort);
    handle.owner = {
      label,
      container: handle.container,
      names: handle.names,
      dbPort: port,
      run,
      e2eUser: handle.user,
      containerId: handle.id,
      profiles,
      output,
      profile,
    };
    ops.writeJson(path.join(output, "ownership.json"), handle.owner);
    ops.writeJson(path.join(output, "container-ownership.json"), {
      container: handle.container,
      names: handle.names,
      run,
      containerId: handle.id,
    });
    handle.context.sha = ops.git();
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/${handle.names[1]}`;
    handle.env = {
      ...process.env,
      ...profileEnv(profile),
      NODE_ENV: "test",
      AUTH_MODE: "dev-user",
      DATABASE_URL: url,
      DIRECT_URL: url,
      E2E_DATABASE_URL: url,
      E2E_DEV_USER_ID: handle.user,
      AFC_TEST_RUN_ID: run,
      AFC_POSITION_PROFILE_ROOT: profiles,
      AFC_POSITION_PROFILE_ALLOCATION: path.join(profiles, "physical-root.json"),
      FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(output, "html-private"),
      PLAYWRIGHT_JSON_OUTPUT_NAME: handle.context.reportPath,
      PLAYWRIGHT_JSON_OUTPUT_FILE: handle.context.reportPath,
    };
    await ops.port(apiPort);
    await ops.port(webPort);
    // Normal executeOwnedPhase performs validation; named diagnostics validate immediately after allocation.
    handle.previous = previous;
    return handle;
  } catch (error) {
    let failure = error;
    try {
      cleanup = await releaseOwnedPhase(handle);
    } catch (cleanupError) {
      cleanup = handle.cleanup;
      failure = new AggregateError([error, cleanupError], "Allocation and owned cleanup failed");
    }
    failedAllocations.set(failure, { handle, cleanup, launchCount: handle.context.launchCount });
    throw failure;
  }
}
export function validateOwnedPhaseAllocation(handle) {
  const ops = allocationOperations.get(handle);
  if (!ops || releasedAllocations.has(handle)) throw coded("OWNERSHIP");
  validateAllocation(
    handle.owner,
    handle.env,
    JSON.parse(ops.command("inspect", handle.id))[0],
    handle.previous,
  );
}

/** Partial handles distinguish never allocated resources from verified absence. No caller retries rollback. */
export async function releaseOwnedPhase(handle) {
  const ops = allocationOperations.get(handle);
  if (!ops || releasedAllocations.has(handle)) throw coded("CLEANUP_FAILED");
  releasedAllocations.add(handle);
  const cleanup = {
    processGroupAbsent: "notAllocated",
    exactContainerAbsent: "notAllocated",
    physicalProfileAbsent: "notAllocated",
    portsAbsent: "notAllocated",
  };
  handle.cleanup = cleanup;
  const issues = [];
  if (handle.context.childPid) {
    try {
      Object.assign(cleanup, await ops.group(handle.context.childPid));
    } catch {
      cleanup.processGroupAbsent = "unknown";
      issues.push("process");
    }
  } else if (handle.context.launchCount > 0) {
    cleanup.processGroupAbsent = "unknown";
    issues.push("process");
  }
  if (handle.containerAttempted) {
    if (!handle.id || !/^[a-f0-9]{64}$/.test(handle.id))
      try {
        const found = ops.command(
          "ps",
          "-a",
          "--no-trunc",
          "--filter",
          `name=^/${handle.container}$`,
          "--filter",
          `label=afc.run=${handle.run}`,
          "--filter",
          "label=afc.owner=automation-m0-06",
          "--filter",
          "label=afc.purpose=owned-e2e",
          "--format",
          "{{.ID}}",
        );
        if (/^[a-f0-9]{64}$/.test(found)) handle.id = found;
        else throw coded("CLEANUP_FAILED");
      } catch {
        cleanup.exactContainerAbsent = "unknown";
        issues.push("lookup");
      }
    if (/^[a-f0-9]{64}$/.test(handle.id ?? ""))
      try {
        Object.assign(
          cleanup,
          cleanContainer(handle.id, handle.container, handle.run, ops.command),
        );
      } catch {
        cleanup.exactContainerAbsent = "unknown";
        issues.push("container");
      }
  }
  if (handle.physicalCreated && cleanup.processGroupAbsent === "unknown")
    cleanup.physicalProfileAbsent = "unknown";
  if (handle.physicalCreated && cleanup.processGroupAbsent !== "unknown")
    try {
      if (handle.physicalMarked)
        Object.assign(cleanup, ops.physicalCleanup(handle.physical, handle.descriptor));
      else {
        if (
          path.dirname(handle.physical) !== path.join(ops.base, "p") ||
          path.basename(handle.physical) !== handle.token ||
          lstatSync(handle.physical).isSymbolicLink() ||
          realpathSync(handle.physical) !== handle.physical ||
          readdirSync(handle.physical).some((n) => n !== ".afc-position-root.json")
        )
          throw coded("CLEANUP_FAILED");
        const marker = path.join(handle.physical, ".afc-position-root.json");
        if (existsSync(marker) && lstatSync(marker).isSymbolicLink()) throw coded("CLEANUP_FAILED");
        rmSync(handle.physical, { recursive: true });
        cleanup.physicalProfileAbsent = !existsSync(handle.physical);
      }
    } catch {
      cleanup.physicalProfileAbsent = "unknown";
      issues.push("profile");
    }
  if (handle.ports.length) {
    cleanup.portsAbsent = true;
    for (const port of handle.ports)
      try {
        await ops.port(port);
      } catch {
        cleanup.portsAbsent = false;
        issues.push("port");
      }
  }
  if (issues.length) throw coded("CLEANUP_FAILED");
  return cleanup;
}

async function runPhase(phase, expected, selectionHash, previous, stage, abortSignal) {
  let allocation, proof, failure;
  let cleanup = {};
  try {
    allocation = await allocateOwnedPhase({
      phaseName: phase.name,
      mode: phase.mode ?? "direct",
      usedPorts: previous.flatMap((p) => [p.dbPort, p.profile.apiPort, p.profile.webPort]),
      previous,
      abortSignal,
    });
    Object.assign(allocation.context, { stage, selectionHash });
    await withCleanup(
      async () => {
        proof = await executeOwnedPhase({
          phase,
          owner: allocation.owner,
          env: allocation.env,
          inspect: JSON.parse(docker("inspect", allocation.id))[0],
          previous,
          context: allocation.context,
          expected,
        });
      },
      async () => {
        cleanup = await releaseOwnedPhase(allocation);
      },
    );
  } catch (error) {
    failure = error;
    const partial = allocationFailure(error);
    if (partial) {
      allocation = partial.handle;
      cleanup = partial.cleanup;
    } else if (allocation?.cleanup) cleanup = allocation.cleanup;
  }
  if (proof) {
    validateNetworkProjection(proof.networkDiagnostics, expected);
    exactKeys(proof.inspection, ["reporter", "config", "stdout", "stderr", "trace"]);
    for (const [name, record] of Object.entries(proof.inspection))
      validateInspection(record, name === "trace");
  }
  const safe = {
    phase: phase.name,
    run: allocation?.run,
    stage,
    profile: allocation?.owner?.profile,
    containerId: /^[0-9a-f]{64}$/.test(allocation?.id ?? "") ? allocation.id : null,
    database: allocation?.names[1],
    principal: allocation?.user,
    owner: "automation-m0-06",
    purpose: "owned-e2e",
    childPid: allocation?.context.childPid,
    status: failure ? "failed" : "passed",
    error: failure ? safeCode(failure) : undefined,
    execution: proof,
    cleanup,
    finishedAt: new Date().toISOString(),
  };
  mkdirSync(path.join(outputBase, stage), { recursive: true });
  json(path.join(outputBase, stage, `${phase.name}-${allocation?.run ?? randomUUID()}.json`), safe);
  if (failure) throw failure;
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux")
    throw coded("UNSUPPORTED_RUNNER");
  const stage = parseStage(process.argv.slice(2));
  const manifest = loadManifest(root);
  const selection = preflight({ root, manifest, phases, phaseArgs, stage });
  const expected = requiredCases(manifest, stage);
  mkdirSync(outputBase, { recursive: true });
  const previous = [];
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const selectedPhases = phases.filter((p) => expected.some((r) => r.phase === p.name));
  const result = await runPhaseSeries(selectedPhases, (phase) =>
    runPhase(
      phase,
      expected.filter((r) => r.phase === phase.name),
      selection.selectionHash,
      previous,
      stage,
      controller.signal,
    ),
  );
  mkdirSync(path.join(outputBase, stage), { recursive: true });
  const requireWeb = createRequire(path.join(web, "package.json"));
  const requireTest = createRequire(requireWeb.resolve("@playwright/test/package.json"));
  const requirePlaywright = createRequire(requireTest.resolve("playwright/package.json"));
  const core = path.dirname(requirePlaywright.resolve("playwright-core/package.json"));
  const browsers = JSON.parse(readFileSync(path.join(core, "browsers.json"), "utf8"))
    .browsers.filter((b) => ["chromium", "webkit"].includes(b.name))
    .map((b) => ({ name: b.name, revision: b.revision, browserVersion: b.browserVersion }));
  const hash = (file) =>
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex");
  const githubRunId = /^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? "")
    ? process.env.GITHUB_RUN_ID
    : null;
  const pnpmVersion = spawnSync("pnpm", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10_000,
  });
  privateFile("pnpm-version-stdout", pnpmVersion.stdout ?? "");
  privateFile("pnpm-version-stderr", pnpmVersion.stderr ?? "");
  if (pnpmVersion.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(pnpmVersion.stdout))
    throw coded("OPERATION_FAILED");
  json(path.join(outputBase, stage, `execution-${randomUUID()}.json`), {
    selection,
    ...result,
    manifestHash: hash("apps/web/e2e/ci-manifest.json"),
    lockHash: hash("pnpm-lock.yaml"),
    invocation: `xvfb-run --auto-servernum node scripts/ci-e2e.mjs --stage ${stage}`,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pnpmDeclared: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
        .packageManager,
      pnpm: pnpmVersion.stdout.trim(),
      playwright: JSON.parse(readFileSync(path.join(core, "package.json"), "utf8")).version,
      browsers,
      githubRunId,
      runUrl:
        githubRunId && process.env.GITHUB_REPOSITORY === "Gwonchankim/aifitcoach"
          ? `https://github.com/Gwonchankim/aifitcoach/actions/runs/${githubRunId}`
          : null,
    },
  });
  publishSummary(result);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("PHASE_FAILED");
    process.exitCode = 1;
  });
}
