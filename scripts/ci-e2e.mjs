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
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import {
  loadManifest,
  parseStage,
  preflight,
  requiredCases,
  validateAllocation,
  validateExecution,
  executionProjection,
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

export async function executeOwnedPhase(
  { phase, owner, env, inspect, previous, context, expected },
  {
    launch = privateLaunch,
    writeProvenance = (c) => json(path.join(owner.output, "execution-provenance.json"), c),
    readEvidence = () => ({
      provenance: JSON.parse(
        readFileSync(path.join(owner.output, "execution-provenance.json"), "utf8"),
      ),
      report: JSON.parse(readFileSync(context.reportPath, "utf8")),
    }),
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
  return executionProjection(evidence, context, expected);
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

async function runPhase(phase, expected, selectionHash, previous, stage, abortSignal) {
  if (abortSignal.aborted) throw coded("CHILD_FAILED");
  const run = randomUUID();
  const token = randomBytes(4).toString("hex");
  const label = `gen_s03_ci_${token}`;
  const container = `afc_${label}`;
  const names = [`afc_${label}_test`, `afc_${label}_e2e`];
  const user = randomUUID();
  const password = randomBytes(24).toString("hex");
  const family = phase.project === "chromium-mobile" ? "chromium" : "webkit";
  const output = path.join(
    ownedBase,
    "evidence",
    epic,
    "sprint-03-generator",
    `${phase.name}-${token}`,
  );
  const profiles = path.join(output, `${family}-owned-profiles`);
  const physical = path.join(ownedBase, "p", token);
  const descriptor = { v: 1, epic, manifestRoot: profiles, physicalRoot: physical, token: run };
  let physicalCreated = false;
  let id;
  let context;
  let owner;
  let proof;
  let failure;
  const cleanup = {};
  const usedPorts = previous.flatMap((p) => [p.dbPort, p.profile.apiPort, p.profile.webPort]);
  try {
    await withCleanup(
      async () => {
        mkdirSync(profiles, { recursive: true, mode: 0o700 });
        mkdirSync(path.dirname(physical), { recursive: true });
        mkdirSync(physical, { mode: 0o700 });
        physicalCreated = true;
        json(path.join(profiles, "physical-root.json"), descriptor);
        json(path.join(physical, ".afc-position-root.json"), descriptor);
        id = docker(
          "run",
          "-d",
          "--name",
          container,
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
        const info = JSON.parse(docker("inspect", id))[0];
        const port = Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort);
        const apiPort = await freePort(0, [...usedPorts, port]);
        const webPort = await freePort(0, [...usedPorts, port, apiPort]);
        const profile = makeProfile(phase.mode ?? "direct", apiPort, webPort);
        owner = {
          label,
          container,
          names,
          dbPort: port,
          run,
          e2eUser: user,
          containerId: id,
          profiles,
          output,
          profile,
        };
        json(path.join(output, "ownership.json"), owner);
        json(path.join(output, "container-ownership.json"), {
          container,
          names,
          run,
          containerId: id,
        });
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = spawnSync("docker", ["exec", id, "pg_isready", "-U", "postgres"], {
            stdio: "ignore",
            timeout: 5_000,
          });
          if (result.status === 0) {
            ready = true;
            break;
          }
          await delay(1_000);
        }
        if (!ready) throw new Error("Owned PostgreSQL did not become ready");
        const url = `postgresql://postgres:${password}@127.0.0.1:${port}/${names[1]}`;
        const git = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
          stdio: "pipe",
        });
        if (git.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(git.stdout)) throw coded("OWNERSHIP");
        context = {
          sha: git.stdout.trim(),
          run,
          phase: phase.name,
          selectionHash,
          root,
          reportPath: path.join(output, "playwright-results.json"),
          startedAt: new Date().toISOString(),
          stage,
          abortSignal,
        };
        const env = {
          ...process.env,
          ...profileEnv(profile),
          NODE_ENV: "test",
          AUTH_MODE: "dev-user",
          DATABASE_URL: url,
          DIRECT_URL: url,
          E2E_DATABASE_URL: url,
          E2E_DEV_USER_ID: user,
          AFC_TEST_RUN_ID: run,
          AFC_POSITION_PROFILE_ROOT: profiles,
          AFC_POSITION_PROFILE_ALLOCATION: path.join(profiles, "physical-root.json"),
          FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
          PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(output, "html-private"),
          PLAYWRIGHT_JSON_OUTPUT_NAME: context.reportPath,
          PLAYWRIGHT_JSON_OUTPUT_FILE: context.reportPath,
        };
        await freePort(apiPort);
        await freePort(webPort);
        proof = await executeOwnedPhase({
          phase,
          owner,
          env,
          inspect: JSON.parse(docker("inspect", id))[0],
          previous,
          context,
          expected,
        });
      },
      async () => {
        const issues = [];
        try {
          Object.assign(cleanup, await closeOwnedGroup(context?.childPid));
        } catch {
          issues.push("process");
        }
        // Recover only the exact run/name/owner when a failed docker run did not return its ID.
        if (!id) {
          try {
            const found = docker(
              "ps",
              "-a",
              "--no-trunc",
              "--filter",
              `name=^/${container}$`,
              "--filter",
              `label=afc.run=${run}`,
              "--filter",
              "label=afc.owner=automation-m0-06",
              "--format",
              "{{.ID}}",
            );
            if (found && !found.includes("\n")) id = found;
            else if (found) throw coded("CLEANUP_FAILED");
            else cleanup.exactContainerAbsent = true;
          } catch {
            issues.push("lookup");
          }
        }
        if (id)
          try {
            Object.assign(cleanup, cleanContainer(id, container, run));
          } catch {
            issues.push("container");
          }
        if (physicalCreated && cleanup.processGroupAbsent)
          try {
            Object.assign(cleanup, cleanPhysical(physical, descriptor));
          } catch {
            issues.push("profile");
          }
        if (owner)
          for (const port of [owner.profile.apiPort, owner.profile.webPort]) {
            try {
              await freePort(port);
            } catch {
              issues.push("port");
            }
          }
        cleanup.portsAbsent = issues.includes("port") ? false : true;
        if (issues.length) throw coded("CLEANUP_FAILED");
      },
    );
  } catch (error) {
    failure = error;
  }
  const safe = {
    phase: phase.name,
    run,
    stage,
    profile: owner?.profile,
    containerId: /^[0-9a-f]{64}$/.test(id ?? "") ? id : null,
    database: names[1],
    principal: user,
    owner: "automation-m0-06",
    purpose: "owned-e2e",
    childPid: context?.childPid,
    status: failure ? "failed" : "passed",
    error: failure ? safeCode(failure) : undefined,
    execution: proof,
    cleanup,
    finishedAt: new Date().toISOString(),
  };
  mkdirSync(path.join(outputBase, stage), { recursive: true });
  json(path.join(outputBase, stage, `${phase.name}-${run}.json`), safe);
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
