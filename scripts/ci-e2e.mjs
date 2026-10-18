/** GitHub's disposable Linux runner only. Preserve the existing observer boundaries. */
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
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
  phaseConfig,
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
    if (error) throw ownedAggregate(error, caught, "Phase and owned cleanup failed");
    if (caught instanceof Error) cleanupFailures.add(caught);
    throw caught;
  }
  if (error) throw error;
}

/** The same boundary is used by the real runner and fake launchers (no DB in unit tests). */
export function privateLaunch(
  command,
  args,
  options,
  onSpawn = () => {},
  markAbort = (result) => result,
) {
  return new Promise((resolve) => {
    const { signal: abortSignal, timeout, ...spawnOptions } = options;
    if (abortSignal?.aborted) {
      resolve(markAbort({ status: null, error: abortSignal.reason ?? coded("CHILD_FAILED") }));
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
    let abortAdopted = false;
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
      const result = {
        status,
        signal,
        error,
        pid: ownedPid,
        closed,
        stdout: Buffer.concat(chunks.stdout),
        stderr: Buffer.concat(chunks.stderr),
      };
      resolve(abortAdopted ? markAbort(result) : result);
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
    const abort = () => {
      if (!settled && !error) abortAdopted = true;
      stop(abortSignal.reason ?? coded("CHILD_FAILED"));
    };
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

// Failure-only diagnostics. Every public string is an enum or an independently expected identity.
const failureRecords = new WeakMap();
const resultTrust = new WeakMap();
const ownedAbortResults = new WeakSet();
const SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGPIPE",
  "SIGXCPU",
  "SIGXFSZ",
];
const FAILURE_AT = [
  "allocation",
  "spawn",
  "launcher",
  "private-io",
  "report-missing",
  "report-parse",
  "report-validate",
  "diagnosis",
  "cleanup",
];
const REPORT_STATES = [
  "unread",
  "missing",
  "unreadable",
  "oversize",
  "invalid-json",
  "invalid-shape",
  "wrong-provenance",
  "stale",
  "limit-exceeded",
  "parsed",
];
const OBSERVED = ["passed", "failed", "timedOut", "interrupted", "skipped", "missing"];
const CONFIGS = [
  "playwright.config.ts",
  "playwright.v2-split.config.ts",
  "playwright.fact-window.config.ts",
];
const MAX_REPORT = 32 * 1024 * 1024;
const hex64 = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid4 = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
function data(value, key) {
  if (value === null || !["object", "function"].includes(typeof value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw new Error("Diagnostic accessor");
  return descriptor.value;
}
function check(condition) {
  if (!condition) throw new Error("Invalid diagnostic");
}
function keys(value, expected) {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const ownKeys = Reflect.ownKeys(value);
  check(ownKeys.length === expected.length && ownKeys.every((key) => expected.includes(key)));
  return Object.fromEntries(expected.map((key) => [key, data(value, key)]));
}
function array(value) {
  check(Array.isArray(value));
  const length = data(value, "length");
  if (length > 20000) throw new RangeError("Diagnostic limit");
  return Array.from({ length }, (_, i) => data(value, String(i)));
}
export function failureContext(stage, phase, selectionHash) {
  const definition = phases.find((p) => p.name === phase);
  check(["product", "m0"].includes(stage) && definition && hex64(selectionHash));
  return Object.freeze({
    sha: null,
    phaseRun: null,
    stage,
    phase,
    selectionHash,
    config: phaseConfig(definition),
  });
}
function captureContext(base, context, owner) {
  const out = { ...base };
  let complete = true;
  for (const [name, object, key, valid] of [
    ["sha", context, "sha", (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v)],
    ["phaseRun", owner, "run", uuid4],
  ]) {
    try {
      const value = data(object, key);
      out[name] = valid(value) ? value : null;
      if (out[name] === null) complete = false;
    } catch {
      out[name] = null;
      complete = false;
    }
  }
  return { context: Object.freeze(out), complete };
}
export function canonicalFailure(context, failureAt = "diagnosis") {
  return {
    context: { ...context },
    failureAt,
    launcher: null,
    report: { state: "unread", bytes: null, digest: null },
    globalErrors: null,
    cases: null,
    unknownCases: 0,
    duplicateCases: 0,
    diagnosisComplete: false,
  };
}
// A result marker, not an Error property or a late AbortSignal flag. Identity/return shape stay intact.
export function rememberAbortedLaunch(result) {
  ownedAbortResults.add(result);
  return result;
}
export function launcherSnapshot(result) {
  check(result !== null && typeof result === "object");
  let complete = true;
  const nullable = (key, valid, project = (v) => v) => {
    try {
      const v = data(result, key);
      if (v === undefined) return null;
      if (!valid(v)) {
        complete = false;
        return null;
      }
      return project(v);
    } catch {
      complete = false;
      return null;
    }
  };
  const status = nullable("status", (v) => v === null || Number.isSafeInteger(v));
  const signal = nullable(
    "signal",
    (v) => v === null || typeof v === "string",
    (v) => (v === null ? "none" : SIGNALS.includes(v) ? v : "unknown"),
  );
  const closed = nullable("closed", (v) => v === null || typeof v === "boolean");
  const error = data(result, "error");
  const code = data(error, "code"),
    syscall = data(error, "syscall");
  const errorKind = !error
    ? "none"
    : code === "ETIMEDOUT"
      ? "timeout"
      : code === "OUTPUT_LIMIT"
        ? "output-limit"
        : code === "PRIVATE_IO"
          ? "private-io"
          : typeof syscall === "string" && syscall.startsWith("spawn")
            ? "spawn"
            : ownedAbortResults.has(result)
              ? "abort"
              : "other";
  return { launcher: { status, signal, closed, errorKind }, complete };
}
function identity(row) {
  return {
    file: data(row, "file"),
    case: array(data(row, "case")),
    browser: data(row, "browser"),
    repeatEachIndex: data(row, "repeatEachIndex"),
  };
}
const identityKey = (r) => JSON.stringify([r.file, r.case, r.browser, r.repeatEachIndex]);
function expectedIdentities(expected) {
  return array(expected).map((row) => {
    const r = identity(row);
    check(
      typeof r.file === "string" && /^apps\/web\/e2e\/(?!.*(?:\.\.|\\)).+\.spec\.ts$/.test(r.file),
    );
    check(r.case.length > 0 && r.case.every((t) => typeof t === "string" && t.length > 0));
    check(["chromium-mobile", "webkit-ios"].includes(r.browser) && natural(r.repeatEachIndex));
    return r;
  });
}
function boundedFile(file, directory) {
  const base = path.resolve(directory),
    target = path.resolve(file);
  check(
    path.dirname(target) === base &&
      realpathSync(base) === base &&
      !lstatSync(base).isSymbolicLink(),
  );
  const before = lstatSync(target);
  check(before.isFile() && !before.isSymbolicLink() && realpathSync(target) === target);
  check(Number.isSafeInteger(before.size) && before.size >= 0);
  if (before.size > MAX_REPORT) return { oversized: before.size };
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = fstatSync(fd);
    check(
      current.isFile() &&
        current.size === before.size &&
        current.ino === before.ino &&
        current.dev === before.dev,
    );
    const bytes = Buffer.alloc(current.size);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      check(count > 0);
      total += count;
    }
    check(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0 && fstatSync(fd).size === current.size);
    return { bytes };
  } finally {
    closeSync(fd);
  }
}
function emptyReport(state = "unread", bytes = null, reportDigest = null) {
  return {
    report: { state, bytes, digest: reportDigest },
    globalErrors: null,
    cases: null,
    unknownCases: 0,
    duplicateCases: 0,
    diagnosisComplete: false,
  };
}
export function decodeFailureReport(report, expected, context, provenance, raw) {
  const result = emptyReport(
    "invalid-shape",
    raw.length,
    createHash("sha256").update(raw).digest("hex"),
  );
  const state = (value) => ({
    ...result,
    report: { ...result.report, state: value },
    cases: null,
    diagnosisComplete: false,
  });
  try {
    const expectedRows = expectedIdentities(expected);
    if (expectedRows.length > 128) return state("limit-exceeded");
    for (const key of ["sha", "run", "phase", "selectionHash", "root", "reportPath", "startedAt"])
      if (data(provenance, key) !== data(context, key)) return state("wrong-provenance");
    const config = data(report, "config");
    const configFile = data(config, "configFile"),
      rootDir = data(config, "rootDir");
    const expectedConfig = data(data(expected, "0"), "config");
    if (
      typeof configFile !== "string" ||
      !CONFIGS.includes(expectedConfig) ||
      path.resolve(configFile) !== path.resolve(data(context, "root"), "apps/web", expectedConfig)
    )
      return state("wrong-provenance");
    if (typeof rootDir !== "string") return state("invalid-shape");
    const start = Date.parse(data(data(report, "stats"), "startTime"));
    if (!Number.isFinite(start) || start < Date.parse(data(context, "startedAt")))
      return state("stale");
    let complete = true,
      nodes = 0,
      rows = 0;
    const errors = data(report, "errors");
    if (errors === undefined) complete = false;
    else {
      check(Array.isArray(errors));
      const count = data(errors, "length");
      result.globalErrors = count <= 1000 ? count : null;
      if (count > 1000) complete = false;
    }
    const visitNode = () => {
      if (++nodes > 20000) throw new RangeError("Diagnostic limit");
    };
    const expectedMap = new Map(expectedRows.map((r) => [identityKey(r), r]));
    check(expectedMap.size === expectedRows.length);
    const seen = new Map(),
      repeats = new Map(),
      duplicates = new Set();
    function visit(suite, titles, depth) {
      if (depth > 16) throw new RangeError("Diagnostic limit");
      visitNode();
      for (const spec of array(data(suite, "specs"))) {
        visitNode();
        const title = data(spec, "title"),
          sourceFile = data(spec, "file");
        check(typeof title === "string" && typeof sourceFile === "string");
        for (const test of array(data(spec, "tests"))) {
          visitNode();
          if (++rows > 4096) throw new RangeError("Diagnostic limit");
          const browser = data(test, "projectName");
          check(typeof browser === "string");
          const file = path
            .relative(data(context, "root"), path.resolve(rootDir, sourceFile))
            .replaceAll("\\", "/");
          const parts = [...titles, title],
            repeatKey = JSON.stringify([file, parts, browser]),
            index = repeats.get(repeatKey) ?? 0;
          repeats.set(repeatKey, index + 1);
          const key = identityKey({ file, case: parts, browser, repeatEachIndex: index });
          const results = array(data(test, "results"));
          // Count every result node, even for unknown cases and attempts beyond the display bound.
          for (const entry of results) {
            visitNode();
            check(entry !== null && typeof entry === "object");
          }
          if (!expectedMap.has(key)) {
            result.unknownCases++;
            complete = false;
            continue;
          }
          if (seen.has(key)) {
            result.duplicateCases++;
            duplicates.add(key);
            seen.delete(key);
            complete = false;
            continue;
          }
          let observed = "missing";
          const attempts = results.length > 10 ? null : results.length;
          if (attempts === null) complete = false;
          if (results.length) {
            const last = data(results.at(-1), "status");
            if (OBSERVED.includes(last) && last !== "missing") observed = last;
            else complete = false;
          }
          seen.set(key, { observed, attempts });
        }
      }
      const children = data(suite, "suites");
      for (const child of Object.hasOwn(suite, "suites") ? array(children) : []) {
        const title = data(child, "title");
        check(typeof title === "string");
        visit(child, [...titles, title], depth + 1);
      }
    }
    for (const suite of array(data(report, "suites"))) visit(suite, [], 1);
    result.cases = expectedRows.map((r) => ({
      file: r.file,
      case: [...r.case],
      browser: r.browser,
      repeatEachIndex: r.repeatEachIndex,
      ...(duplicates.has(identityKey(r))
        ? { observed: "missing", attempts: null }
        : (seen.get(identityKey(r)) ?? { observed: "missing", attempts: 0 })),
    }));
    result.report.state = "parsed";
    result.diagnosisComplete = complete;
    return result;
  } catch (error) {
    return state(error instanceof RangeError ? "limit-exceeded" : "invalid-shape");
  }
}
export function readFailureReport(owner, context, expected) {
  let input;
  try {
    input = boundedFile(data(context, "reportPath"), data(owner, "output"));
  } catch (error) {
    return emptyReport(data(error, "code") === "ENOENT" ? "missing" : "unreadable");
  }
  if (input.oversized !== undefined) return emptyReport("oversize", input.oversized);
  const raw = input.bytes,
    reportDigest = createHash("sha256").update(raw).digest("hex");
  let report;
  try {
    report = JSON.parse(raw.toString("utf8"));
  } catch {
    return emptyReport("invalid-json", raw.length, reportDigest);
  }
  let provenance;
  try {
    const p = boundedFile(
      path.join(data(owner, "output"), "execution-provenance.json"),
      data(owner, "output"),
    );
    check(p.bytes);
    provenance = JSON.parse(p.bytes.toString("utf8"));
  } catch {
    return emptyReport("wrong-provenance", raw.length, reportDigest);
  }
  return decodeFailureReport(report, expected, context, provenance, raw);
}
export function validateFailureEvidence(value, trustedContext, expected) {
  value = keys(value, [
    "context",
    "failureAt",
    "launcher",
    "report",
    "globalErrors",
    "cases",
    "unknownCases",
    "duplicateCases",
    "diagnosisComplete",
  ]);
  const c = keys(data(value, "context"), [
    "sha",
    "phaseRun",
    "stage",
    "phase",
    "selectionHash",
    "config",
  ]);
  check(c.sha === null || (typeof c.sha === "string" && /^[a-f0-9]{40}$/.test(c.sha)));
  check(c.phaseRun === null || uuid4(c.phaseRun));
  check(
    ["m0", "product"].includes(c.stage) &&
      phases.some((p) => p.name === c.phase) &&
      hex64(c.selectionHash) &&
      CONFIGS.includes(c.config),
  );
  for (const key of Object.keys(c)) check(c[key] === data(trustedContext, key));
  const at = data(value, "failureAt"),
    l =
      data(value, "launcher") === null
        ? null
        : keys(data(value, "launcher"), ["status", "signal", "closed", "errorKind"]),
    r = keys(data(value, "report"), ["state", "bytes", "digest"]);
  check(FAILURE_AT.includes(at));
  if (l !== null) {
    check(l.status === null || Number.isSafeInteger(l.status));
    check(l.signal === null || ["none", "unknown", ...SIGNALS].includes(l.signal));
    check(l.closed === null || typeof l.closed === "boolean");
    check(
      ["timeout", "abort", "spawn", "output-limit", "private-io", "other", "none"].includes(
        l.errorKind,
      ),
    );
  }
  check(REPORT_STATES.includes(r.state));
  check(r.bytes === null || (Number.isSafeInteger(r.bytes) && r.bytes >= 0));
  check(r.digest === null || hex64(r.digest));
  if (["unread", "missing", "unreadable"].includes(r.state))
    check(r.bytes === null && r.digest === null);
  else if (r.state === "oversize") check(r.bytes > MAX_REPORT && r.digest === null);
  else check(r.bytes !== null && r.bytes <= MAX_REPORT && r.digest !== null);
  check(value.globalErrors === null || (natural(value.globalErrors) && value.globalErrors <= 1000));
  for (const key of ["unknownCases", "duplicateCases"])
    check(natural(value[key]) && value[key] <= 4096);
  check(typeof value.diagnosisComplete === "boolean");
  let publicCases = null;
  if (value.cases !== null) {
    const rows = array(value.cases),
      wanted = expectedIdentities(expected);
    check(rows.length <= 128 && rows.length === wanted.length && r.state === "parsed");
    const seen = new Set();
    publicCases = rows.map((row, i) => {
      row = keys(row, ["file", "case", "browser", "repeatEachIndex", "observed", "attempts"]);
      const id = identity(row),
        key = identityKey(id);
      check(key === identityKey(wanted[i]) && !seen.has(key));
      seen.add(key);
      check(OBSERVED.includes(row.observed));
      check(row.attempts === null || (natural(row.attempts) && row.attempts <= 10));
      if (value.diagnosisComplete)
        check(row.attempts !== null && (row.observed !== "missing" || row.attempts === 0));
      return {
        file: id.file,
        case: id.case,
        browser: id.browser,
        repeatEachIndex: id.repeatEachIndex,
        observed: row.observed,
        attempts: row.attempts,
      };
    });
  } else check(r.state !== "parsed");
  if (value.diagnosisComplete)
    check(
      r.state === "parsed" &&
        value.cases !== null &&
        value.globalErrors !== null &&
        value.unknownCases === 0 &&
        value.duplicateCases === 0,
    );
  // Construct literals: even an inherited toJSON hook must never reach either public sink.
  return {
    context: {
      sha: c.sha,
      phaseRun: c.phaseRun,
      stage: c.stage,
      phase: c.phase,
      selectionHash: c.selectionHash,
      config: c.config,
    },
    failureAt: at,
    launcher:
      l === null
        ? null
        : { status: l.status, signal: l.signal, closed: l.closed, errorKind: l.errorKind },
    report: { state: r.state, bytes: r.bytes, digest: r.digest },
    globalErrors: value.globalErrors,
    cases: publicCases,
    unknownCases: value.unknownCases,
    duplicateCases: value.duplicateCases,
    diagnosisComplete: value.diagnosisComplete,
  };
}
function rememberFailure(error, evidence, context, expected) {
  if (error !== null && ["object", "function"].includes(typeof error))
    failureRecords.set(error, { evidence, context, expected });
}
function ownedAggregate(error, cleanup, message) {
  const wrapper = new AggregateError([error, cleanup], message),
    record = failureRecords.get(error);
  if (record) failureRecords.set(wrapper, record);
  return wrapper;
}
function evidenceFor(error, base, cleanupOnly = false) {
  const record = failureRecords.get(error);
  try {
    check(record);
    for (const key of ["stage", "phase", "selectionHash", "config"])
      check(record.context[key] === base[key]);
    return {
      ...record,
      evidence: validateFailureEvidence(record.evidence, record.context, record.expected),
    };
  } catch {
    return {
      evidence: canonicalFailure(base, cleanupOnly ? "cleanup" : "diagnosis"),
      context: base,
      expected: [],
    };
  }
}
function publicResult(result, trust = resultTrust.get(result)) {
  const rows = result.results.map((row) => {
    const phase = phases.some((p) => p.name === row.phase) ? row.phase : "unknown";
    const base = trust?.get(phase);
    if (row.status === "passed" && !Object.hasOwn(row, "failureEvidence"))
      return { phase, status: "passed" };
    const invalidSuccess = row.status === "passed";
    const out = {
      phase,
      status: "failed",
      error: invalidSuccess ? "OPERATION_FAILED" : safeCode({ code: row.error }),
      failures: invalidSuccess
        ? [{ boundary: "phase", code: "OPERATION_FAILED" }]
        : (row.failures ?? []).map((f) => ({
            boundary: f.boundary === "cleanup" ? "cleanup" : "phase",
            code: safeCode(f, "OPERATION_FAILED"),
          })),
    };
    if (base) {
      let record = rowTrust.get(row);
      try {
        check(!invalidSuccess && record);
        out.failureEvidence = validateFailureEvidence(
          data(row, "failureEvidence"),
          record.context,
          record.expected,
        );
        for (const key of ["stage", "phase", "selectionHash", "config"])
          check(out.failureEvidence.context[key] === base[key]);
      } catch {
        out.failureEvidence = canonicalFailure(base);
        record = { context: base, expected: [] };
      }
      rowTrust.set(out, record);
    }
    return out;
  });
  const projected = {
    results: rows,
    exitCode: rows.some((r) => r.status !== "passed") || result.exitCode !== 0 ? 1 : 0,
  };
  if (trust) resultTrust.set(projected, trust);
  return projected;
}
const rowTrust = new WeakMap();
export function writeStageExecution(
  file,
  metadata,
  result,
  { write = json, output = (line) => console.log(line) } = {},
) {
  const trust = new Map(
    metadata.selection.phases.map((p) => [
      p.name,
      failureContext(metadata.selection.stage, p.name, metadata.selection.selectionHash),
    ]),
  );
  // A registered result retains its independently captured context; missing records fall back, never infer from Error fields.
  resultTrust.set(result, trust);
  const projected = publicResult(result, trust);
  write(file, {
    selection: metadata.selection,
    ...projected,
    manifestHash: metadata.manifestHash,
    lockHash: metadata.lockHash,
    invocation: metadata.invocation,
    environment: metadata.environment,
  });
  publishSummary(projected, output);
  return projected.exitCode;
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
  let base;
  try {
    base = failureContext(data(context, "stage"), phase.name, data(context, "selectionHash"));
  } catch {
    // Legacy data-only adapters lack a trusted stage/selection; the series boundary supplies fallback.
  }
  let failureAt = "allocation",
    snapshot,
    snapshotInvalid = false;
  try {
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
    failureAt = "private-io";
    writeProvenance(context);
    let result;
    context.launchCount = (context.launchCount ?? 0) + 1;
    failureAt = "spawn";
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
        rememberAbortedLaunch,
      );
    } catch (error) {
      writePrivate("spawn-error.txt", String(error?.stack ?? error));
      throw coded("CHILD_FAILED");
    }
    // Capture before the first post-launch private write, including partial native returns.
    try {
      snapshot = launcherSnapshot(result);
    } catch {
      snapshotInvalid = true;
    }
    failureAt = "private-io";
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
    failureAt = snapshot?.launcher.errorKind === "spawn" ? "spawn" : "launcher";
    if (result.error || result.signal || result.status !== 0)
      throw new Error(`CI E2E child failed: ${phase.name}`);
    let evidence;
    failureAt = "report-missing";
    try {
      evidence = readEvidence();
    } catch {
      throw new Error(`CI E2E report missing: ${phase.name}`);
    }
    failureAt = "report-validate";
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
    failureAt = "private-io";
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
  } catch (error) {
    if (base) {
      const captured = captureContext(base, context, owner);
      let evidence = canonicalFailure(captured.context);
      try {
        check(!snapshotInvalid);
        const report = readFailureReport(owner, context, expected);
        if (
          ["report-missing", "report-validate"].includes(failureAt) &&
          ["invalid-json", "invalid-shape"].includes(report.report.state)
        )
          failureAt = "report-parse";
        evidence = {
          context: { ...captured.context },
          failureAt,
          launcher: snapshot?.launcher ?? null,
          ...report,
        };
        evidence.diagnosisComplete &&= captured.complete && (snapshot?.complete ?? false);
        evidence = validateFailureEvidence(evidence, captured.context, expected);
      } catch {
        evidence = canonicalFailure(captured.context);
      }
      rememberFailure(error, evidence, captured.context, expected);
    }
    throw error;
  }
}

export async function runPhaseSeries(selectedPhases, execute, options) {
  if (!selectedPhases.length) throw new Error("Empty phase run");
  const results = [];
  const trust =
    options &&
    new Map(
      selectedPhases.map((p) => [
        p.name,
        failureContext(options.stage, p.name, options.selectionHash),
      ]),
    );
  for (const phase of selectedPhases) {
    try {
      await execute(phase);
      results.push({
        phase: phases.some((p) => p.name === phase.name) ? phase.name : "unknown",
        status: "passed",
      });
    } catch (error) {
      const cleanupOnly = cleanupFailures.delete(error);
      const row = {
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
      };
      if (trust) {
        const record = evidenceFor(error, trust.get(phase.name), cleanupOnly);
        row.failureEvidence = record.evidence;
        rowTrust.set(row, record);
      }
      results.push(row);
    }
  }
  const result = { results, exitCode: results.some((r) => r.status !== "passed") ? 1 : 0 };
  if (trust) resultTrust.set(result, trust);
  return result;
}

export function publishSummary(result, output = (value) => console.log(value)) {
  output(JSON.stringify(publicResult(result)));
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
  {
    phaseName,
    mode = "direct",
    usedPorts = [],
    fixedPorts,
    previous = [],
    abortSignal,
    diagnosticContext,
  },
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
    if (diagnosticContext) {
      const captured = captureContext(diagnosticContext, handle.context, handle);
      rememberFailure(
        error,
        canonicalFailure(captured.context, "allocation"),
        captured.context,
        [],
      );
    }
    let failure = error;
    try {
      cleanup = await releaseOwnedPhase(handle);
    } catch (cleanupError) {
      cleanup = handle.cleanup;
      failure = ownedAggregate(error, cleanupError, "Allocation and owned cleanup failed");
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
  const diagnosticContext = failureContext(stage, phase.name, selectionHash);
  let allocation, proof, failure;
  let cleanup = {};
  try {
    allocation = await allocateOwnedPhase({
      phaseName: phase.name,
      mode: phase.mode ?? "direct",
      usedPorts: previous.flatMap((p) => [p.dbPort, p.profile.apiPort, p.profile.webPort]),
      previous,
      abortSignal,
      diagnosticContext,
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
    if (cleanupFailures.has(error) && allocation) {
      const captured = captureContext(diagnosticContext, allocation.context, allocation);
      rememberFailure(error, canonicalFailure(captured.context, "cleanup"), captured.context, []);
    }
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
  const result = await runPhaseSeries(
    selectedPhases,
    (phase) =>
      runPhase(
        phase,
        expected.filter((r) => r.phase === phase.name),
        selection.selectionHash,
        previous,
        stage,
        controller.signal,
      ),
    { stage, selectionHash: selection.selectionHash },
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
  process.exitCode = writeStageExecution(
    path.join(outputBase, stage, `execution-${randomUUID()}.json`),
    {
      selection,
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
    },
    result,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("PHASE_FAILED");
    process.exitCode = 1;
  });
}
