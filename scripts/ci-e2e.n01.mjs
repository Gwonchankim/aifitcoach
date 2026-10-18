/** Fixed execution-evidence diagnostics. Actual execution requires GitHub disposable Linux. */
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  allocateOwnedPhase,
  releaseOwnedPhase,
  allocationFailure,
  validateOwnedPhaseAllocation,
  privateLaunch,
  closeOwnedGroup,
  freePort,
  exactKeys,
  emptyInspection,
  inspectBytes,
  inspectTrace,
  validateInspection,
  withCleanup,
} from "./ci-e2e.mjs";
import { safeCode } from "./ci-e2e.manifest.mjs";
const { AbortController } = globalThis;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
export const REGISTRY = Object.freeze([
  "wrong-rewrite",
  "wrong-base",
  "occupied-port",
  "abort",
  "timeout",
]);
export const INVOCATION = "xvfb-run --auto-servernum node scripts/ci-e2e.n01.mjs";
const MATERIALS = Object.freeze(["reporter", "config", "stdout", "stderr", "trace"]);
const failure = (code) => Object.assign(new Error(code), { code });
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function emptyCase(name) {
  return {
    case: name,
    status: "notRun",
    codes: [],
    redKind: null,
    httpStatus: null,
    restoredGreen: null,
    inspection: Object.fromEntries(MATERIALS.map((k) => [k, emptyInspection()])),
  };
}
export function validateSummary(value) {
  exactKeys(value, ["run", "sha", "invocation", "cases"]);
  if (
    !uuid(value.run) ||
    typeof value.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sha) ||
    value.invocation !== INVOCATION ||
    !Array.isArray(value.cases) ||
    value.cases.length !== REGISTRY.length
  )
    throw failure("REPORT_SCHEMA");
  for (const [index, row] of value.cases.entries()) {
    exactKeys(row, [
      "case",
      "status",
      "codes",
      "redKind",
      "httpStatus",
      "restoredGreen",
      "inspection",
    ]);
    if (
      row.case !== REGISTRY[index] ||
      !["passed", "setup-failed", "failed", "notRun"].includes(row.status) ||
      !Array.isArray(row.codes) ||
      new Set(row.codes).size !== row.codes.length ||
      row.codes.some((code) => typeof code !== "string" || safeCode({ code }, null) !== code)
    )
      throw failure("REPORT_SCHEMA");
    const g1 = index < 2;
    if (g1) {
      if (
        ![null, "http-error", "request-failed"].includes(row.redKind) ||
        ![null, true, false].includes(row.restoredGreen) ||
        (row.redKind === "http-error"
          ? !Number.isInteger(row.httpStatus) ||
            row.httpStatus < 500 ||
            row.httpStatus > 599 ||
            row.case !== "wrong-rewrite"
          : row.httpStatus !== null) ||
        (row.status === "passed" && (!row.redKind || row.restoredGreen !== true))
      )
        throw failure("REPORT_SCHEMA");
    } else if (row.redKind !== null || row.httpStatus !== null || row.restoredGreen !== null)
      throw failure("REPORT_SCHEMA");
    exactKeys(row.inspection, MATERIALS);
    for (const name of MATERIALS) {
      validateInspection(row.inspection[name], name === "trace");
      if (row.status === "passed" && ["error", "notInspected"].includes(row.inspection[name].state))
        throw failure("REPORT_SCHEMA");
    }
    if (
      row.status === "passed" &&
      row.case === "wrong-rewrite" &&
      row.inspection.trace.state !== "inspected"
    )
      throw failure("REPORT_SCHEMA");
  }
  return value;
}
export function completeSummary(value) {
  validateSummary(value);
  return value.cases.every((row) => row.status === "passed");
}
export function publishN01Summary(value, directory = path.join(web, "e2e/.artifacts-ci/n01")) {
  validateSummary(value);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `n01-summary-${value.run}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  return completeSummary(JSON.parse(readFileSync(file, "utf8"))) ? 0 : 1;
}
export function classifyRed(name, observation, expectedUrl) {
  if (
    !observation ||
    !Array.isArray(observation.responses) ||
    !Array.isArray(observation.failed) ||
    !observation.requests?.some((r) => r.url === expectedUrl && r.method === "GET") ||
    observation.responses.some((r) => /\/me(?:[?#]|$)/.test(r.url) && r.status === 200)
  )
    return null;
  if (name === "wrong-rewrite") {
    const http = observation.responses.find(
      (r) =>
        r.url === expectedUrl && Number.isInteger(r.status) && r.status >= 500 && r.status <= 599,
    );
    if (http) return { redKind: "http-error", httpStatus: http.status };
  }
  if (["wrong-base", "wrong-rewrite"].includes(name) && observation.failed.includes(expectedUrl))
    return { redKind: "request-failed", httpStatus: null };
  return null;
}
export function probePassed(name, evidence) {
  return (
    ["abort", "timeout"].includes(name) &&
    Number.isInteger(evidence.pid) &&
    evidence.pid > 1 &&
    Number.isInteger(evidence.grandchildPid) &&
    evidence.grandchildPid > 1 &&
    evidence.pid !== evidence.grandchildPid &&
    evidence.spawnAt <= evidence.readyAt &&
    evidence.readyAt - evidence.spawnAt <= 2000 &&
    evidence.readyAt < evidence.completedAt &&
    evidence.ack === true &&
    evidence.closed === true &&
    evidence.readyFileAbsent === true &&
    evidence.groupAbsent === true &&
    evidence.pidAbsent === true &&
    evidence.grandchildAbsent === true &&
    evidence.port === "notAllocated" &&
    evidence.profile === "notAllocated" &&
    evidence.container === "notAllocated" &&
    (name === "timeout"
      ? evidence.timeout === 5000 &&
        evidence.errorCode === "ETIMEDOUT" &&
        evidence.completedAt - evidence.spawnAt >= 5000
      : evidence.abortReasonPreserved === true)
  );
}
export const PROBE_SOURCE = String.raw`
const {spawn}=require('node:child_process');const fs=require('node:fs');
process.on('SIGTERM',()=>{});
const grand=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write(process.env.AFC_N01_SENTINEL);process.stderr.write(process.env.AFC_N01_SENTINEL);require('node:fs').writeSync(3,'ACK\\n');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','pipe'],env:process.env});
let ack='';grand.stdio[3].on('data',data=>{ack+=data;if(ack==='ACK\n'){fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,grandchildPid:grand.pid}),{flag:'wx',mode:0o600});}});
setInterval(()=>{},1000);
`;
function privateWrite(directory, name, data) {
  writeFileSync(path.join(directory, name), data, { flag: "wx", mode: 0o600 });
}
function inspectStreams(row, results, secrets) {
  for (const stream of ["stdout", "stderr"]) {
    const data = Buffer.concat(results.map((r) => Buffer.from(r[stream] ?? "")));
    row.inspection[stream] = inspectBytes(data, secrets).inspection;
  }
}
function absent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw failure("CLEANUP_FAILED");
  }
}
export async function runProbe(name, { directory, signal, sentinel }, adapters = {}) {
  const row = emptyCase(name),
    launch = adapters.launch ?? privateLaunch,
    clock = adapters.now ?? (() => performance.now());
  const controller = new AbortController(),
    reason = failure("CHILD_FAILED"),
    readyFile = path.join(directory, `probe-ready-${name}.json`);
  let pid, ready, spawnAt, readyAt, result, completedAt, cleanupError, combined;
  const abort = () => controller.abort(reason);
  signal?.addEventListener("abort", abort, { once: true });
  const started = clock();
  if (signal?.aborted) abort();
  const task = launch(
    process.execPath,
    ["-e", PROBE_SOURCE, readyFile],
    {
      cwd: root,
      env: { ...process.env, AFC_N01_SENTINEL: sentinel },
      stdio: "pipe",
      shell: false,
      detached: true,
      timeout: 5000,
      signal: controller.signal,
    },
    (owned) => {
      pid = owned;
      spawnAt = clock();
    },
  );
  const observed = Promise.resolve(task).then((value) => {
    result = value;
    completedAt = clock();
    return value;
  });
  try {
    await withCleanup(
      async () => {
        try {
          while (!result && spawnAt !== undefined && clock() - spawnAt <= 2000) {
            if (existsSync(readyFile)) {
              if (lstatSync(readyFile).isSymbolicLink()) throw failure("OWNERSHIP");
              ready = JSON.parse(readFileSync(readyFile, "utf8"));
              readyAt = clock();
              break;
            }
            await (adapters.delay ?? delay)(100);
          }
          if (!ready || ready.pid !== pid || readyAt - spawnAt > 2000) {
            row.status = "setup-failed";
            abort();
          } else if (name === "abort") abort();
          await observed;
          if (result?.error) throw result.error;
          throw failure("CHILD_FAILED");
        } catch (error) {
          if (!result) {
            row.status = "setup-failed";
            abort();
            await observed;
          }
          throw error;
        }
      },
      async () => {
        if (!Number.isInteger(pid) || pid <= 1) {
          cleanupError = true;
          throw failure("CLEANUP_FAILED");
        }
        try {
          await (adapters.closeGroup ?? closeOwnedGroup)(pid);
        } catch {
          cleanupError = true;
          throw failure("CLEANUP_FAILED");
        }
      },
    );
  } catch (error) {
    combined = error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const evidence = {
    pid,
    grandchildPid: ready?.grandchildPid,
    spawnAt,
    readyAt,
    completedAt,
    ack: !!ready,
    closed: result?.closed === true,
    status: result?.status,
    signal: result?.signal,
    errorCode: result?.error?.code,
    abortReasonPreserved: result?.error === reason,
    timeout: 5000,
    port: "notAllocated",
    profile: "notAllocated",
    container: "notAllocated",
  };
  try {
    if (
      !Number.isInteger(pid) ||
      pid <= 1 ||
      !Number.isInteger(ready?.grandchildPid) ||
      ready.grandchildPid <= 1 ||
      ready.grandchildPid === pid
    )
      throw failure("CLEANUP_FAILED");
    evidence.groupAbsent = (adapters.absent ?? absent)(-pid);
    evidence.pidAbsent = (adapters.absent ?? absent)(pid);
    evidence.grandchildAbsent = (adapters.absent ?? absent)(ready.grandchildPid);
  } catch {
    cleanupError = true;
  }
  if (clock() - started > 30000) cleanupError = true;
  if (result) {
    privateWrite(directory, `${name}-stdout.txt`, result.stdout ?? "");
    privateWrite(directory, `${name}-stderr.txt`, result.stderr ?? "");
    inspectStreams(row, [result], [sentinel]);
  }
  if (combined) privateWrite(directory, `${name}-error.txt`, String(combined.stack ?? combined));
  if (existsSync(readyFile)) rmSync(readyFile);
  evidence.readyFileAbsent = !existsSync(readyFile);
  privateWrite(directory, `${name}-state.json`, JSON.stringify(evidence));
  row.status =
    row.status === "setup-failed"
      ? "setup-failed"
      : !cleanupError && probePassed(name, evidence)
        ? "passed"
        : "failed";
  if (row.status !== "passed")
    row.codes = cleanupError ? ["CHILD_FAILED", "CLEANUP_FAILED"] : ["CHILD_FAILED"];
  return row;
}

/** The library runs in an owned Node child so its debug streams have the same private boundary. */
export const BROWSER_SOURCE = String.raw`
const {createRequire}=require('node:module');const fs=require('node:fs');
const settings=JSON.parse(process.env.AFC_N01_BROWSER);
const webRequire=createRequire(settings.webPackage),testRequire=createRequire(webRequire.resolve('@playwright/test/package.json'));
const {chromium}=testRequire('playwright');
(async()=>{let browser,context;const observation={requests:[],responses:[],failed:[]};const pending=[];
try{browser=await chromium.launch();context=await browser.newContext();
if(settings.trace)await context.tracing.start({screenshots:true,snapshots:true,sources:true});
const page=await context.newPage();
page.on('request',r=>observation.requests.push({url:r.url(),method:r.method()}));
page.on('requestfailed',r=>observation.failed.push(r.url()));
page.on('response',r=>{const row={url:r.url(),status:r.status(),method:r.request().method()};observation.responses.push(row);
if(row.url===settings.expected&&row.status===200)pending.push(r.json().then(body=>{row.id=body.id;}).catch(()=>{}));});
await page.goto(settings.origin,{waitUntil:'domcontentloaded',timeout:30000});
const end=Date.now()+30000;
while(Date.now()<end){
 if(settings.green?observation.responses.some(r=>r.url===settings.expected&&r.status===200&&r.id===settings.user):observation.failed.includes(settings.expected)||observation.responses.some(r=>r.url===settings.expected&&r.status>=500))break;
 await new Promise(resolve=>setTimeout(resolve,100));
}
await Promise.all(pending);
if(settings.trace)await context.tracing.stop({path:settings.trace});
}finally{if(context)await context.close();if(browser)await browser.close();}
fs.writeFileSync(settings.output,JSON.stringify(observation),{flag:'wx',mode:0o600});
})().catch(()=>{process.stderr.write('BROWSER_FAILED');process.exitCode=1;});
`;

export function greenObserved(observation, expected, user) {
  return (
    observation?.requests?.some((r) => r.url === expected && r.method === "GET") === true &&
    observation.responses?.some(
      (r) => r.url === expected && r.method === "GET" && r.status === 200 && r.id === user,
    ) === true
  );
}

export function diagnosticIO(
  handle,
  directory,
  signal,
  sentinel,
  deps = { launch: privateLaunch, closeGroup: closeOwnedGroup },
) {
  if (
    typeof handle?.run !== "string" ||
    handle.run.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(handle.run)
  )
    throw failure("OWNERSHIP");
  const active = new Set(),
    results = [];
  let sequence = 0;
  function start(
    command,
    args,
    { cwd = root, env = handle.env, timeout = 300000, execution = true } = {},
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? failure("CHILD_FAILED"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const item = { pid: undefined, controller, result: undefined, sequence: sequence++ };
    active.add(item);
    if (execution) handle.context.launchCount++;
    item.task = deps
      .launch(
        command,
        args,
        {
          cwd,
          env: { ...env, AFC_N01_SENTINEL: sentinel },
          timeout,
          signal: controller.signal,
          detached: true,
          stdio: "pipe",
          shell: false,
        },
        (pid) => {
          item.pid = pid;
          if (execution) handle.context.childPid = pid;
        },
      )
      .then((result) => {
        item.result = result;
        results.push(result);
        privateWrite(
          directory,
          `child-${handle.run}-${item.sequence}-stdout.txt`,
          result.stdout ?? "",
        );
        privateWrite(
          directory,
          `child-${handle.run}-${item.sequence}-stderr.txt`,
          result.stderr ?? "",
        );
        privateWrite(
          directory,
          `child-${handle.run}-${item.sequence}-state.json`,
          JSON.stringify({
            pid: result.pid,
            status: result.status,
            signal: result.signal,
            closed: result.closed,
            error: result.error ? safeCode(result.error) : null,
          }),
        );
        return result;
      })
      .finally(() => signal?.removeEventListener("abort", abort));
    return item;
  }
  async function close(item) {
    await withCleanup(
      async () => {
        if (!item.pid) throw failure("CLEANUP_FAILED");
        await deps.closeGroup(item.pid);
      },
      async () => {
        item.controller.abort(failure("CHILD_FAILED"));
        await item.task;
      },
    );
    active.delete(item);
    if (item.result?.closed !== true) throw failure("CLEANUP_FAILED");
  }
  async function run(command, args, options) {
    const item = start(command, args, options);
    const result = await item.task;
    await withCleanup(
      async () => {
        if (result.error || result.status !== 0 || result.signal || !result.closed)
          throw result.error ?? failure("CHILD_FAILED");
      },
      () => close(item),
    );
    return result;
  }
  async function cleanup() {
    const errors = [];
    for (const item of [...active])
      try {
        await close(item);
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, "Owned diagnostic cleanup failed");
  }
  return { start, close, run, cleanup, results };
}
async function waitReady(url, predicate, interval, timeout, signal, server) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (signal?.aborted || server.result) throw failure("CHILD_FAILED");
    try {
      const response = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(Math.min(interval, 1000)),
      });
      if (await predicate(response)) return;
    } catch {
      // A refused/not-yet-ready endpoint is retried only within the readiness deadline.
    }
    await delay(interval);
  }
  throw failure("CHILD_FAILED");
}

export async function runWrongBuild(name, options, adapters = {}) {
  const row = emptyCase(name);
  let handle, io, failureValue, trace;
  const allocate = adapters.allocate ?? allocateOwnedPhase,
    release = adapters.release ?? releaseOwnedPhase;
  try {
    handle = await allocate({
      phaseName: `n01-${name}`,
      mode: name === "wrong-rewrite" ? "proxy" : "direct",
      abortSignal: options.signal,
    });
    await withCleanup(
      async () => {
        (adapters.validate ?? validateOwnedPhaseAllocation)(handle);
        io = (adapters.io ?? diagnosticIO)(
          handle,
          options.directory,
          options.signal,
          options.sentinel,
        );
        await io.run("pnpm", ["--filter", "api", "db:migrate"], { execution: false });
        await io.run("pnpm", ["--filter", "api", "db:seed"], { execution: false });
        const profile = handle.owner.profile;
        const apiEnv = {
          ...handle.env,
          PORT: String(profile.apiPort),
          DEV_USER_ID: handle.owner.e2eUser,
          WEB_ORIGIN: profile.webOrigin,
        };
        delete apiEnv.AFC_TEST_TODAY;
        const api = io.start("pnpm", ["--filter", "api", "start"], {
          env: apiEnv,
          timeout: 1200000,
        });
        const ready = adapters.waitReady ?? waitReady;
        await ready(
          `${profile.apiTarget}/v1/me`,
          async (r) => r.status === 200 && (await r.json()).id === handle.owner.e2eUser,
          1000,
          180000,
          options.signal,
          api,
        );
        const port = await (adapters.freePort ?? freePort)(0, [
          profile.apiPort,
          profile.webPort,
          handle.owner.dbPort,
        ]);
        const correct = {
          ...handle.env,
          NODE_ENV: "production",
          API_PROXY_ORIGIN: profile.proxyOrigin,
          NEXT_PUBLIC_API_BASE_URL: profile.apiBase,
        };
        const wrong = {
          ...correct,
          ...(name === "wrong-rewrite"
            ? { API_PROXY_ORIGIN: `http://127.0.0.1:${port}` }
            : { NEXT_PUBLIC_API_BASE_URL: `http://localhost:${port}/v1` }),
        };
        const wrongUrl =
          name === "wrong-rewrite"
            ? `${profile.webOrigin}/api/v1/me`
            : `http://localhost:${port}/v1/me`;
        const correctUrl = new URL(`${profile.apiBase}/me`, profile.webOrigin).href;
        let server,
          wrongAttempted = false;
        const browser = async (green, expected) => {
          const output = path.join(
            options.directory,
            `${name}-${green ? "green" : "red"}-observation.json`,
          );
          const settings = {
            webPackage: path.join(web, "package.json"),
            origin: profile.webOrigin,
            expected,
            user: handle.owner.e2eUser,
            green,
            output,
          };
          if (green && name === "wrong-rewrite") {
            trace = path.join(options.directory, "n01-trace.zip");
            settings.trace = trace;
          }
          await io.run(process.execPath, ["-e", BROWSER_SOURCE], {
            env: { ...handle.env, AFC_N01_BROWSER: JSON.stringify(settings) },
            timeout: 60000,
          });
          return (adapters.readObservation ?? ((file) => JSON.parse(readFileSync(file, "utf8"))))(
            output,
          );
        };
        const buildStart = async (env) => {
          await io.run("pnpm", ["build"], { cwd: web, env, timeout: 300000 });
          server = io.start("pnpm", ["start", "--port", String(profile.webPort)], {
            cwd: web,
            env,
            timeout: 180000,
          });
          await ready(
            profile.webOrigin,
            (r) => r.status === 200,
            500,
            120000,
            options.signal,
            server,
          );
        };
        let redFailure;
        try {
          wrongAttempted = true;
          await buildStart(wrong);
          const observation = await browser(false, wrongUrl);
          row.status = "failed";
          const red = classifyRed(name, observation, wrongUrl);
          if (!red) throw failure("CHILD_FAILED");
          Object.assign(row, red);
        } catch (error) {
          redFailure = error;
          if (row.status === "notRun") row.status = "setup-failed";
        }
        // A setup failure remains a failure even if restoration succeeds. Abort leaves restoration false.
        if (wrongAttempted) {
          row.restoredGreen = false;
          if (server) {
            await io.close(server);
            server = undefined;
          }
          if (!options.signal?.aborted) {
            await buildStart(correct);
            row.restoredGreen = greenObserved(
              await browser(true, correctUrl),
              correctUrl,
              handle.owner.e2eUser,
            );
            if (!row.restoredGreen) throw failure("CHILD_FAILED");
          }
        }
        if (redFailure) throw redFailure;
        if (row.restoredGreen !== true) throw failure("CHILD_FAILED");
        row.status = "passed";
      },
      async () => {
        await withCleanup(
          async () => {
            if (io) await io.cleanup();
          },
          () => release(handle),
        );
      },
    );
  } catch (error) {
    failureValue = error;
    if (row.status === "notRun") row.status = "setup-failed";
    else if (row.status === "passed") row.status = "failed";
    row.codes = [safeCode(error, "CHILD_FAILED")];
    if (error instanceof AggregateError && !row.codes.includes("CLEANUP_FAILED"))
      row.codes.push("CLEANUP_FAILED");
  }
  if (io)
    inspectStreams(row, io.results, [
      options.sentinel,
      handle?.env.FIELD_ENCRYPTION_KEY,
      handle?.env.DATABASE_URL ? new URL(handle.env.DATABASE_URL).password : undefined,
    ]);
  if (trace)
    row.inspection.trace = (
      await (adapters.inspectTrace ?? inspectTrace)(trace, [
        options.sentinel,
        handle.env.FIELD_ENCRYPTION_KEY,
        new URL(handle.env.DATABASE_URL).password,
      ])
    ).inspection;
  if (
    row.status === "passed" &&
    name === "wrong-rewrite" &&
    row.inspection.trace.state !== "inspected"
  ) {
    row.status = "failed";
    row.codes = ["PRIVATE_IO"];
  }
  if (failureValue)
    privateWrite(
      options.directory,
      `${name}-error.txt`,
      String(failureValue.stack ?? failureValue),
    );
  if (handle)
    privateWrite(
      options.directory,
      `${name}-allocation.json`,
      JSON.stringify({
        run: handle.run,
        launchCount: handle.context.launchCount,
        cleanup: handle.cleanup ?? null,
      }),
    );
  return row;
}

export async function runOccupiedPort(options, adapters = {}) {
  const row = emptyCase("occupied-port"),
    listener = createServer();
  let failed, handle, port;
  const allocate = adapters.allocate ?? allocateOwnedPhase,
    release = adapters.release ?? releaseOwnedPhase;
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen({ host: "::", port: 0 }, resolve);
    });
    port = listener.address().port;
    try {
      handle = await allocate({
        phaseName: "n01-occupied-port",
        fixedPorts: { api: port },
        abortSignal: options.signal,
      });
    } catch (error) {
      failed = (adapters.allocationFailure ?? allocationFailure)(error);
      if (error instanceof AggregateError) throw error;
      if (
        error.code !== "PORT_OCCUPIED" ||
        !failed ||
        failed.launchCount !== 0 ||
        failed.cleanup?.exactContainerAbsent !== true ||
        failed.cleanup?.physicalProfileAbsent !== true ||
        !listener.listening
      )
        throw failure("OWNERSHIP");
    }
    if (handle || !failed) throw failure("OWNERSHIP");
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    handle = await allocate({
      phaseName: "n01-occupied-port",
      fixedPorts: { api: port },
      abortSignal: options.signal,
    });
    const owned = handle;
    handle = undefined;
    await withCleanup(
      async () => {
        (adapters.validate ?? validateOwnedPhaseAllocation)(owned);
        if (owned.context.launchCount !== 0 || owned.owner.profile.apiPort !== port)
          throw failure("OWNERSHIP");
      },
      () => release(owned),
    );
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.codes = [safeCode(error, "OWNERSHIP")];
    if (error instanceof AggregateError) row.codes.push("CLEANUP_FAILED");
    privateWrite(options.directory, "occupied-port-error.txt", String(error.stack ?? error));
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    if (handle)
      try {
        await release(handle);
      } catch {
        row.status = "failed";
        if (!row.codes.includes("CLEANUP_FAILED")) row.codes.push("CLEANUP_FAILED");
      }
  }
  privateWrite(
    options.directory,
    "occupied-port-state.json",
    JSON.stringify({
      port,
      launchCount: failed?.launchCount,
      rollback: failed?.cleanup,
      listenerClosed: !listener.listening,
    }),
  );
  return row;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length) throw failure("UNKNOWN_STAGE");
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux")
    throw failure("UNSUPPORTED_RUNNER");
  const shaResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10000,
  });
  if (shaResult.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(shaResult.stdout))
    throw failure("OWNERSHIP");
  const run = randomUUID(),
    directory = path.join(tmpdir(), `afc-n01-private-${run}`),
    sentinel = randomBytes(16).toString("hex");
  const summary = {
    run,
    sha: shaResult.stdout.trim(),
    invocation: INVOCATION,
    cases: REGISTRY.map(emptyCase),
  };
  const controller = new AbortController(),
    abort = () => controller.abort(failure("CHILD_FAILED"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  mkdirSync(directory, { mode: 0o700 });
  await withCleanup(
    async () => {
      for (const [index, name] of REGISTRY.entries()) {
        if (controller.signal.aborted) break;
        const options = { directory, sentinel, signal: controller.signal };
        summary.cases[index] = name.startsWith("wrong-")
          ? await runWrongBuild(name, options)
          : name === "occupied-port"
            ? await runOccupiedPort(options)
            : await runProbe(name, options);
        if (summary.cases[index].status !== "passed") break;
      }
    },
    async () => {
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGINT", abort);
      if (
        path.dirname(directory) !== realpathSync(tmpdir()) ||
        lstatSync(directory).isSymbolicLink() ||
        realpathSync(directory) !== directory
      )
        throw failure("CLEANUP_FAILED");
      rmSync(directory, { recursive: true });
      if (existsSync(directory)) throw failure("CLEANUP_FAILED");
    },
  );
  const exit = publishN01Summary(summary);
  console.log(JSON.stringify(validateSummary(summary)));
  return exit;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(safeCode(error, "OPERATION_FAILED"));
      process.exitCode = 1;
    });
}
