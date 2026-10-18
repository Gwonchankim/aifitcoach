import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  phases,
  phaseArgs,
  cleanContainer,
  executeOwnedPhase,
  runPhaseSeries,
  withCleanup,
  freePort,
  closeOwnedGroup,
  privateLaunch,
  publishSummary,
  rememberAbortedLaunch,
  launcherSnapshot,
  failureContext,
  canonicalFailure,
  decodeFailureReport,
  readFailureReport,
  validateFailureEvidence,
  writeStageExecution,
} from "./ci-e2e.mjs";
import {
  loadManifest,
  validateSelections,
  makeProfile,
  profileEnv,
  classifyConsole,
} from "./ci-e2e.manifest.mjs";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
const { structuredClone, AbortController } = globalThis;

function launchModel({
  pid = 4242,
  detached = true,
  spawnFailure = false,
  denySignals = false,
} = {}) {
  let now = 0;
  let nextTimer = 0;
  let alive = true;
  let spawns = 0;
  const timers = new Map();
  const signals = [];
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  for (const stream of [child.stdout, child.stderr]) stream.destroy = () => {};
  child.kill = (signal) => signals.push([pid, signal]);
  const signal = (target, kind) => {
    assert.equal(target, -pid);
    if (denySignals) throw Object.assign(new Error("unconfirmed group"), { code: "EPERM" });
    if (!alive) throw Object.assign(new Error("absent"), { code: "ESRCH" });
    if (kind !== 0) signals.push([target, kind]);
    if (kind === "SIGKILL") alive = false;
  };
  // Evaluate the real function; only OS spawn/signals and time are modeled.
  const launch = runInNewContext(`(${privateLaunch.toString()})`, {
    Buffer,
    coded: (code) => Object.assign(new Error(code), { code }),
    process: { platform: "linux", kill: signal },
    spawn: () => {
      spawns++;
      if (spawnFailure)
        throw spawnFailure instanceof Error ? spawnFailure : new Error("synthetic spawn failure");
      return child;
    },
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    launch: (options, onSpawn) =>
      launch("synthetic", [], { detached, ...options }, onSpawn, rememberAbortedLaunch),
    child,
    signals,
    signal,
    timerCount: () => timers.size,
    spawnCount: () => spawns,
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = end;
    },
  };
}

test("QA-01 external abort settles before close and reaches owned cleanup", async () => {
  const f = ownedFixture();
  const model = launchModel();
  const controller = new AbortController();
  f.request.context.abortSignal = controller.signal;
  let cleaned = false;
  let settled = false;
  let result;
  const pending = runPhaseSeries([f.request.phase, { name: "core-w" }], (phase) => {
    if (phase.name === "core-w") return;
    return withCleanup(
      () =>
        executeOwnedPhase(f.request, {
          ...f.adapters,
          launch: (_c, _a, options, onSpawn) => model.launch(options, onSpawn),
        }),
      async () => {
        assert.equal(f.request.context.childPid, 4242);
        await closeOwnedGroup(f.request.context.childPid, model.signal);
        cleaned = true;
      },
    );
  }).then((value) => {
    result = value;
    settled = true;
  });
  controller.abort(new Error("QA_PRIVATE_ABORT_SENTINEL"));
  // No close event, and TERM is ignored; KILL must precede finite drain settlement.
  model.tick(10_000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(settled, true, "abort must not wait forever for close");
  await pending;
  assert.equal(cleaned, true);
  assert.deepEqual(model.signals, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.results[1].status, "passed");
  assert.doesNotMatch(JSON.stringify(result), /QA_PRIVATE_ABORT_SENTINEL/);
  assert.equal(model.timerCount(), 0);
});

test("QA-01 timeout owns PID immediately and terminates before close", async () => {
  const model = launchModel();
  let pid;
  let settled = false;
  const pending = model
    .launch({ timeout: 25 }, (value) => {
      pid = value;
    })
    .then((value) => {
      settled = true;
      return value;
    });
  assert.equal(pid, 4242);
  assert.equal(settled, false);
  model.tick(25);
  assert.deepEqual(model.signals, [[-4242, "SIGTERM"]]);
  model.tick(1999);
  assert.equal(settled, false);
  assert.equal(model.signals.length, 1);
  model.tick(2001);
  const result = await pending;
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.closed, false);
  assert.deepEqual(model.signals, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
  ]);
  assert.equal((await closeOwnedGroup(pid, model.signal)).processGroupAbsent, true);
  assert.equal(model.timerCount(), 0);
});

test("QA-01 exited child with inherited open pipes has a finite drain", async () => {
  const model = launchModel();
  const pending = model.launch({ timeout: 3_600_000 });
  model.child.emit("exit", null, "SIGTERM");
  model.tick(6000);
  const result = await pending;
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, null);
  assert.ok(result.error);
  assert.equal(result.closed, false);
  assert.deepEqual(model.signals, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
  ]);
  assert.equal(model.timerCount(), 0);
});

test("QA-01 normal, pre-aborted, unowned, missing PID and spawn failure never signal", async () => {
  const normal = launchModel();
  const pending = normal.launch({ timeout: 50 });
  normal.child.stdout.emit("data", Buffer.from("private stdout"));
  normal.child.stderr.emit("data", Buffer.from("private stderr"));
  normal.child.emit("exit", 0, null);
  normal.child.emit("close", 0, null);
  const result = await pending;
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.closed, true);
  assert.equal(result.stdout.toString(), "private stdout");
  assert.equal(result.stderr.toString(), "private stderr");
  normal.tick(10_000);
  assert.equal(normal.signals.length, 0);
  assert.equal(normal.timerCount(), 0);
  const controller = new AbortController();
  controller.abort();
  const pre = launchModel();
  assert.ok((await pre.launch({ signal: controller.signal })).error);
  assert.equal(pre.spawnCount(), 0);
  assert.equal(pre.signals.length, 0);
  for (const input of [{ detached: false }, { pid: null }, { spawnFailure: true }]) {
    const model = launchModel(input);
    let registered = false;
    const done = model.launch({ timeout: 10 }, () => {
      registered = true;
    });
    model.tick(10_000);
    assert.ok((await done).error);
    assert.equal(registered, false);
    assert.equal(model.signals.length, 0);
    assert.equal(model.timerCount(), 0);
  }
  const missing = launchModel({ pid: null });
  const spawnError = Object.assign(new Error("synthetic async spawn failure"), { code: "ENOENT" });
  const failed = missing.launch({ timeout: 50 });
  missing.child.emit("error", spawnError);
  missing.tick(10_000);
  assert.equal((await failed).error, spawnError);
  assert.equal(missing.signals.length, 0);
  assert.equal(missing.timerCount(), 0);
});

test("QA-01 concurrent abort timeout and stream errors settle once with the first failure", async () => {
  const model = launchModel();
  const controller = new AbortController();
  const original = new Error("QA_PRIVATE_FIRST_FAILURE");
  let settlements = 0;
  const done = model.launch({ signal: controller.signal, timeout: 1 }).then((result) => {
    settlements++;
    return result;
  });
  controller.abort(original);
  model.child.stdout.emit("error", new Error("QA_PRIVATE_STREAM_FAILURE"));
  model.child.emit("error", new Error("QA_PRIVATE_CHILD_FAILURE"));
  model.tick(10_000);
  const result = await done;
  model.child.emit("close", 0, null);
  model.child.emit("error", new Error("QA_PRIVATE_LATE_FAILURE"));
  assert.equal(settlements, 1);
  assert.equal(result.error, original);
  assert.equal(result.closed, false);
  assert.deepEqual(model.signals, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
  ]);
  assert.equal(model.timerCount(), 0);
});

test("QA-01 unconfirmed group cleanup preserves phase plus cleanup failures", async () => {
  const f = ownedFixture();
  const model = launchModel({ denySignals: true });
  let cleaned = false;
  const done = runPhaseSeries([f.request.phase], () =>
    withCleanup(
      () =>
        executeOwnedPhase(f.request, {
          ...f.adapters,
          launch: (_c, _a, options, onSpawn) => model.launch({ ...options, timeout: 1 }, onSpawn),
        }),
      async () => {
        cleaned = true;
        await closeOwnedGroup(f.request.context.childPid, model.signal);
      },
    ),
  );
  model.tick(10_000);
  const result = await done;
  assert.equal(cleaned, true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.results[0].failures.map((f) => f.boundary),
    ["phase", "cleanup"],
  );
  let published;
  publishSummary(result, (value) => {
    published = value;
  });
  assert.doesNotMatch(published, /timed out|unconfirmed|EPERM|stack/);
});

test("F06 API and web diagnostics both reach the private Playwright launcher", () => {
  // Playwright ignores webServer stdout by default; outer pipe alone loses diagnostics.
  const ts = createRequire(import.meta.url)("typescript");
  const source = ts.createSourceFile(
    "playwright.config.ts",
    readFileSync(new URL("../apps/web/playwright.config.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let servers;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "webServer")
      servers = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(servers && ts.isArrayLiteralExpression(servers));
  assert.equal(servers.elements.length, 2);
  for (const server of servers.elements) {
    assert.ok(ts.isObjectLiteralExpression(server));
    for (const stream of ["stdout", "stderr"]) {
      const setting = server.properties.find(
        (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === stream,
      );
      assert.ok(setting, `webServer ${stream} must be explicit`);
      assert.ok(ts.isStringLiteral(setting.initializer));
      assert.equal(setting.initializer.text, "pipe");
    }
  }
});

test("F06 first spawn owns both private streams and publishes only a safe projection", async () => {
  const f = ownedFixture();
  const sentinel = "F06_PRIVATE_SENTINEL";
  const privateData = [];
  f.report.config.env = { SECRET: sentinel };
  f.report.suites[0].specs[0].tests[0].results[0].attachments = [{ path: sentinel }];
  f.adapters.writePrivate = (name, data) => privateData.push([name, String(data)]);
  let inherited;
  f.adapters.launch = (_command, _args, options) => {
    inherited = options;
    // The RED probe itself cannot leak the sentinel through the old inherit launcher.
    return spawnSync(
      process.execPath,
      ["-e", `process.stdout.write('${sentinel}');process.stderr.write('${sentinel}')`],
      { ...options, cwd: process.cwd(), stdio: "pipe" },
    );
  };
  const safe = await executeOwnedPhase(f.request, f.adapters);
  assert.equal(inherited.stdio, "pipe");
  assert.ok(privateData.some(([n, s]) => n === "stdout.txt" && s.includes(sentinel)));
  assert.ok(privateData.some(([n, s]) => n === "stderr.txt" && s.includes(sentinel)));
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(sentinel));
});

test("F06 actual public stdout/stderr and upload projection exclude private sentinels on every boundary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "afc-f06-"));
  const sentinel = "F06_REAL_CHILD_PRIVATE_SENTINEL";
  const module = pathToFileURL(fileURLToPath(new URL("./ci-e2e.mjs", import.meta.url))).href;
  try {
    for (const mode of [
      "passed",
      "exit",
      "signal",
      "spawn",
      "missing",
      "invalid",
      "cleanup",
      "both",
      "overflow",
      "abort",
      "timeout",
    ]) {
      const f = ownedFixture();
      const output = path.join(dir, mode);
      mkdirSync(output);
      f.request.owner.output = output;
      f.request.context.reportPath = path.join(output, "raw.json");
      f.request.env.PLAYWRIGHT_JSON_OUTPUT_NAME = f.request.context.reportPath;
      f.request.env.PLAYWRIGHT_JSON_OUTPUT_FILE = f.request.context.reportPath;
      f.report.config.env = { SECRET: sentinel };
      f.report.suites[0].specs[0].tests[0].results[0].attachments = [{ path: sentinel }];
      const script = path.join(output, "probe.mjs");
      const childScript =
        `process.stdout.write('${sentinel}');process.stderr.write('${sentinel}');` +
        (mode === "overflow" ? "process.stdout.write(Buffer.alloc(34*1024*1024,120));" : "") +
        (mode === "missing"
          ? ""
          : `require('fs').writeFileSync(${JSON.stringify(f.request.context.reportPath)},${JSON.stringify(JSON.stringify(mode === "invalid" ? {} : f.report))});`) +
        (mode === "exit" || mode === "both"
          ? "process.exit(1)"
          : mode === "signal"
            ? "process.kill(process.pid,'SIGTERM')"
            : ["abort", "timeout"].includes(mode)
              ? "setTimeout(()=>{},10000)"
              : "");
      writeFileSync(
        script,
        `
        import {executeOwnedPhase,privateLaunch,runPhaseSeries,withCleanup,publishSummary} from ${JSON.stringify(module)};
        import {writeFileSync} from 'node:fs';
        const request=${JSON.stringify(f.request)};
        let projection;
        const result=await runPhaseSeries([request.phase,{name:'core-w'}], phase=>{
          if(phase.name==='core-w') return;
          return withCleanup(async()=>{
            projection=await executeOwnedPhase(request,{launch:(_c,_a,options,onSpawn)=>{
              if(${JSON.stringify(mode)}==='spawn') throw Object.assign(new Error('${sentinel}'),{code:'${sentinel}',argv:['${sentinel}']});
              if(${JSON.stringify(mode)}==='abort') {
                const controller=new AbortController();
                options.signal=controller.signal;
                setTimeout(()=>controller.abort(new Error('${sentinel}')),500);
              }
              if(${JSON.stringify(mode)}==='timeout') options.timeout=500;
              return privateLaunch(process.execPath,['-e',${JSON.stringify(childScript)}],{...options,cwd:${JSON.stringify(dir)}},onSpawn);
            }});
          },()=>{if(['cleanup','both'].includes(${JSON.stringify(mode)})) throw Object.assign(new Error('${sentinel}'),{code:'${sentinel}'});});
        });
        writeFileSync(${JSON.stringify(path.join(output, "safe-upload.json"))},JSON.stringify({projection,result}));
        publishSummary(result);
        process.exitCode=result.exitCode;
      `,
      );
      const observed = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 15000,
        stdio: "pipe",
      });
      assert.equal(observed.status, mode === "passed" ? 0 : 1, mode);
      assert.doesNotMatch(observed.stdout + observed.stderr, new RegExp(sentinel), mode);
      assert.doesNotMatch(
        readFileSync(path.join(output, "safe-upload.json"), "utf8"),
        new RegExp(sentinel),
        mode,
      );
      if (mode === "spawn")
        assert.match(
          readFileSync(path.join(output, "spawn-error.txt"), "utf8"),
          new RegExp(sentinel),
        );
      else {
        const state = JSON.parse(readFileSync(path.join(output, "launcher-state.json"), "utf8"));
        assert.equal(typeof state.closed, "boolean");
        if (mode === "signal") {
          // Windows may report self-SIGTERM as an exit code; compare the OS/Node oracle.
          const native = spawnSync(
            process.execPath,
            ["-e", "process.kill(process.pid,'SIGTERM')"],
            {
              stdio: "pipe",
              timeout: 5000,
            },
          );
          assert.equal(native.error, undefined);
          assert.notEqual(native.status, 0);
          assert.deepEqual(
            { status: state.status, signal: state.signal },
            { status: native.status, signal: native.signal },
          );
        }
        for (const channel of ["stdout", "stderr"])
          assert.match(
            readFileSync(path.join(output, `${channel}.txt`), "utf8"),
            new RegExp(sentinel),
            mode,
          );
        if (!["missing", "invalid", "overflow", "signal"].includes(mode))
          assert.match(readFileSync(f.request.context.reportPath, "utf8"), new RegExp(sentinel));
        if (mode === "abort")
          assert.match(
            readFileSync(path.join(output, "spawn-error.txt"), "utf8"),
            new RegExp(sentinel),
          );
      }
      assert.equal(JSON.parse(observed.stdout).results[1].status, "passed");
    }
    // The real CLI top-level guard must not print a stack, environment or arbitrary code.
    const guarded = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./ci-e2e.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "false", SECRET: sentinel },
        stdio: "pipe",
      },
    );
    assert.equal(guarded.status, 1);
    assert.equal(guarded.stderr.trim(), "PHASE_FAILED");
    assert.equal(guarded.stdout, "");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("P3-01 QA reproduction classifies cleanup-only failure as cleanup", async () => {
  const result = await runPhaseSeries([{ name: "cleanup-only" }], () =>
    withCleanup(
      () => {},
      () => {
        throw new Error("qa-cleanup-only");
      },
    ),
  );
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.results[0], {
    phase: "unknown",
    status: "failed",
    error: "CLEANUP_FAILED",
    failures: [{ boundary: "cleanup", code: "CLEANUP_FAILED" }],
  });
});

test("P3-01 actual operation/cleanup combinations retain boundaries and subsequent success cannot clear failure", async () => {
  for (const [operationFails, cleanupFails, boundaries] of [
    [false, false, []],
    [true, false, ["phase"]],
    [false, true, ["cleanup"]],
    [true, true, ["phase", "cleanup"]],
  ]) {
    const order = [];
    const result = await runPhaseSeries([{ name: "first" }, { name: "later-success" }], (phase) => {
      if (phase.name === "later-success") {
        order.push("later");
        return;
      }
      return withCleanup(
        () => {
          order.push("operation");
          if (operationFails) throw new Error("operation failed");
        },
        () => {
          order.push("cleanup");
          if (cleanupFails) throw new Error("cleanup failed");
        },
      );
    });
    assert.deepEqual(order, ["operation", "cleanup", "later"]);
    assert.deepEqual(result.results[0].failures?.map((f) => f.boundary) ?? [], boundaries);
    assert.equal(result.results[0].status, boundaries.length ? "failed" : "passed");
    assert.equal(result.results[1].status, "passed");
    assert.equal(result.exitCode, boundaries.length ? 1 : 0);
  }
});

test("P3-01 cleanup-only summary normalizes untrusted error fields and preserves the original error", async () => {
  const secret = "synthetic-private-argv-and-password";
  const failure = Object.freeze(
    Object.assign(new Error(secret), { code: secret, boundary: secret, argv: [secret] }),
  );
  await assert.rejects(
    withCleanup(
      () => {},
      () => {
        throw failure;
      },
    ),
    (error) => {
      assert.equal(error, failure);
      assert.equal(error.message, secret);
      return true;
    },
  );
  const result = await runPhaseSeries([{ name: "cleanup-only" }], () =>
    withCleanup(
      () => {},
      () => {
        throw failure;
      },
    ),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.results[0].error, "CLEANUP_FAILED");
  assert.deepEqual(result.results[0].failures, [{ boundary: "cleanup", code: "CLEANUP_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  const unmarked = Object.assign(new Error("ordinary operation failure"), { boundary: "cleanup" });
  const operation = await runPhaseSeries([{ name: "operation-only" }], () => {
    throw unmarked;
  });
  assert.deepEqual(operation.results[0].failures, [
    { boundary: "phase", code: "OPERATION_FAILED" },
  ]);
});

test("series summary retains phase and cleanup failures without raw credential-bearing errors", async () => {
  const combined = await runPhaseSeries([{ name: "both-fail" }], () => {
    throw new AggregateError([new Error("secret phase argv"), new Error("secret cleanup argv")]);
  });
  assert.deepEqual(
    combined.results[0].failures.map((e) => e.boundary),
    ["phase", "cleanup"],
  );
  assert.equal(combined.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(combined), /secret/);
});

test("sixteen phases still fail when historical-w silently selects native-w cases", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = loadManifest(root);
  const selected = Object.fromEntries(
    phases.map((p) => [p.name, manifest.cases.filter((r) => r.phase === p.name)]),
  );
  validateSelections(manifest, selected, phases, "product");
  selected["historical-w"] = selected["native-w"];
  assert.equal(phases.slice(0, 16).length, 16);
  assert.throws(
    () => validateSelections(manifest, selected, phases, "product"),
    (e) => e.code === "DUPLICATE_SELECTION",
  );
  selected["historical-w"] = manifest.cases.filter((r) => r.phase === "historical-w");
  validateSelections(manifest, selected, phases, "product");
});

test("both browsers retain separate native and historical fresh-principal phases", () => {
  assert.equal(phases.length, 20);
  assert.equal(new Set(phases.map((phase) => phase.name)).size, 20);
  for (const project of ["chromium-mobile", "webkit-ios"]) {
    for (const spec of ["18-assistance-append.spec.ts", "19-assistance-historical.spec.ts"]) {
      assert.equal(
        phases.filter((phase) => phase.project === project && phase.args.includes(spec)).length,
        1,
      );
    }
  }
});

test("similar-init journey runs once with its own principal", () => {
  const selected = phases.filter((phase) => phase.args.includes("20-similar-init.spec.ts"));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].project, "chromium-mobile");
  assert.notEqual(selected[0].core, true);
});

test("weekly focus swap runs once per browser in independent fresh-principal phases", () => {
  const spec = "21-weekly-focus-swap.spec.ts";
  const selected = phases.filter((phase) => phase.args.includes(spec));
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected.map((phase) => phase.name)).size, 2);
  for (const project of ["chromium-mobile", "webkit-ios"]) {
    const matching = selected.filter((phase) => phase.project === project);
    assert.equal(matching.length, 1);
    assert.notEqual(matching[0].core, true);
    assert.deepEqual(matching[0].args, [spec]);
    assert.ok(phaseArgs(matching[0]).includes(spec));
  }
});

test("core selection includes 00 through 17 on both OS paths, excludes fresh-principal specs", () => {
  for (const phase of phases.filter((phase) => phase.core)) {
    const patterns = phaseArgs(phase).filter((value) => value.startsWith("^.*"));
    assert.equal(patterns.length, 18);
    for (const separator of ["/", "\\"]) {
      for (let index = 0; index < 24; index++) {
        const file = `e2e${separator}${String(index).padStart(2, "0")}-example.spec.ts`;
        assert.equal(
          patterns.some((pattern) => new RegExp(pattern).test(file)),
          index < 18,
        );
      }
    }
  }
});

test("reserved split and cardio each run once per browser with independent principals", () => {
  for (const spec of ["22-split-preference.spec.ts", "23-cardio-prescription-read.spec.ts"]) {
    const selected = phases.filter((phase) => phase.args.includes(spec));
    assert.equal(selected.length, 2);
    for (const project of ["chromium-mobile", "webkit-ios"]) {
      const matching = selected.filter((phase) => phase.project === project);
      assert.equal(matching.length, 1);
      assert.notEqual(matching[0].core, true);
      assert.deepEqual(matching[0].args, [spec, "--config", "playwright.v2-split.config.ts"]);
      assert.deepEqual(phaseArgs(matching[0]).slice(0, 6), [
        "exec",
        "playwright",
        "test",
        spec,
        "--config",
        "playwright.v2-split.config.ts",
      ]);
    }
  }
  for (const phase of phases.filter((phase) => phase.core)) {
    assert.equal(phaseArgs(phase).includes("--config"), false);
  }
});

test("fact window runs once per browser with its own config and independent principals", () => {
  const spec = "24-fact-window.spec.ts";
  const selected = phases.filter((phase) => phase.args.includes(spec));
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected.map((phase) => phase.name)).size, 2);
  for (const project of ["chromium-mobile", "webkit-ios"]) {
    const matching = selected.filter((phase) => phase.project === project);
    assert.equal(matching.length, 1);
    assert.notEqual(matching[0].core, true);
    assert.deepEqual(matching[0].args, [spec, "--config", "playwright.fact-window.config.ts"]);
    assert.deepEqual(phaseArgs(matching[0]).slice(0, 6), [
      "exec",
      "playwright",
      "test",
      spec,
      "--config",
      "playwright.fact-window.config.ts",
    ]);
  }
});

test("persistent headed case is moved, not skipped; retry/timeout assertions stay unchanged", () => {
  const core = phases.find((phase) => phase.name === "core-c");
  const persistent = phases.find((phase) => phase.name === "persistent-c");
  assert.deepEqual(core.args, ["--grep-invert", "owned persistent process"]);
  assert.deepEqual(persistent.args, [
    "16-session-position.spec.ts",
    "--grep",
    "owned persistent process",
  ]);
  for (const phase of phases) {
    assert.equal(
      phaseArgs(phase).some((arg) => /retries|timeout|pass-with-no-tests/.test(arg)),
      false,
    );
  }
});

function ownedFixture() {
  const root = path.resolve("/candidate");
  const output = path.join(root, "owned", "one");
  const owner = {
    run: "run1",
    phase: "core-c",
    containerId: "id1",
    container: "afc_one",
    label: "one",
    dbPort: 45555,
    names: ["afc_one_e2e"],
    e2eUser: "principal1",
    profiles: path.join(output, "profiles"),
    output,
    profile: makeProfile("direct", 41201, 41202),
  };
  const url = "postgresql://postgres:synthetic@127.0.0.1:45555/afc_one_e2e";
  const context = {
    root,
    sha: "a".repeat(40),
    phase: "core-c",
    run: owner.run,
    selectionHash: "expected",
    reportPath: path.join(output, "results.json"),
    startedAt: "2026-10-17T00:00:00.000Z",
  };
  const env = {
    ...profileEnv(owner.profile),
    DATABASE_URL: url,
    DIRECT_URL: url,
    E2E_DATABASE_URL: url,
    E2E_DEV_USER_ID: owner.e2eUser,
    AFC_TEST_RUN_ID: owner.run,
    AFC_POSITION_PROFILE_ROOT: owner.profiles,
    PLAYWRIGHT_JSON_OUTPUT_NAME: context.reportPath,
    PLAYWRIGHT_JSON_OUTPUT_FILE: context.reportPath,
  };
  const inspect = {
    Id: owner.containerId,
    Name: `/${owner.container}`,
    Config: {
      Image: "postgres:16",
      Labels: { "afc.run": owner.run, "afc.owner": "automation-m0-06", "afc.purpose": "owned-e2e" },
    },
    HostConfig: { Tmpfs: { "/var/lib/postgresql/data": "" } },
    Mounts: [],
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45555" }] } },
  };
  const expected = [
    {
      file: "apps/web/e2e/09-offline-sync.spec.ts",
      case: ["owned roundtrip"],
      browser: "chromium-mobile",
      config: "playwright.config.ts",
      repeatEachIndex: 0,
    },
  ];
  const report = {
    errors: [],
    config: {
      rootDir: path.join(root, "apps/web/e2e"),
      configFile: path.join(root, "apps/web/playwright.config.ts"),
      projects: [{ name: "chromium-mobile", retries: 0, repeatEach: 1 }],
    },
    stats: { startTime: context.startedAt },
    suites: [
      {
        title: "09-offline-sync.spec.ts",
        specs: [
          {
            title: "owned roundtrip",
            file: "09-offline-sync.spec.ts",
            ok: true,
            tests: [
              {
                projectName: "chromium-mobile",
                annotations: [],
                expectedStatus: "passed",
                status: "expected",
                results: [{ status: "passed", retry: 0 }],
              },
            ],
          },
        ],
      },
    ],
  };
  const seen = [];
  let provenance;
  const adapters = {
    launch: (command, args, options) => {
      seen.push({ command, args, options });
      return { status: 0 };
    },
    writeProvenance: (c) => {
      provenance = structuredClone(c);
    },
    readEvidence: () => ({ provenance, report }),
    reportExists: () => false,
    writePrivate: () => {},
  };
  return {
    request: { phase: phases[0], owner, env, inspect, previous: [], context, expected },
    adapters,
    seen,
    report,
  };
}

test("owned launcher receives actual phase selectors/config/env and validates its report", async () => {
  const f = ownedFixture();
  await executeOwnedPhase(f.request, f.adapters);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].command, "pnpm");
  assert.deepEqual(f.seen[0].args, [...phaseArgs(phases[0]), "--reporter=json", "--forbid-only"]);
  assert.equal(f.seen[0].options.env, f.request.env);
  assert.equal(f.seen[0].options.cwd, path.join(f.request.context.root, "apps/web"));
  assert.equal(f.seen[0].options.shell, false);
  assert.deepEqual(f.request.previous, [f.request.owner]);
});

test("ownership and old-report faults stop the actual launcher before migration/server spawn", async () => {
  for (const mutate of [
    (f) => {
      f.request.env.DIRECT_URL = "postgresql://hidden:secret@remote/foreign_e2e";
    },
    (f) => {
      f.request.inspect.Config.Labels["afc.run"] = "foreign";
    },
    (f) => {
      f.adapters.reportExists = () => true;
    },
    (f) => {
      f.request.previous.push({ e2eUser: f.request.owner.e2eUser });
    },
  ]) {
    const f = ownedFixture();
    mutate(f);
    await assert.rejects(executeOwnedPhase(f.request, f.adapters));
    assert.equal(f.seen.length, 0);
    const good = ownedFixture();
    await executeOwnedPhase(good.request, good.adapters);
  }
});

test("child nonzero, signal and spawn errors remain failures, even with a good report", async () => {
  for (const result of [
    { status: 1 },
    { status: null, signal: "SIGTERM" },
    { status: 0, error: new Error("spawn") },
  ]) {
    const f = ownedFixture();
    f.adapters.launch = () => result;
    let cleaned = false;
    await assert.rejects(
      withCleanup(
        () => executeOwnedPhase(f.request, f.adapters),
        () => {
          cleaned = true;
        },
      ),
      /child failed/,
    );
    assert.equal(cleaned, true);
    const good = ownedFixture();
    await executeOwnedPhase(good.request, good.adapters);
  }
});

test("exit zero without a valid report cannot pass; cleanup retains the original failure", async () => {
  const f = ownedFixture();
  f.adapters.readEvidence = () => {
    throw new Error("missing");
  };
  await assert.rejects(
    withCleanup(
      () => executeOwnedPhase(f.request, f.adapters),
      () => {
        throw new Error("cleanup");
      },
    ),
    (e) => {
      assert.equal(e.errors.length, 2);
      assert.match(e.errors[0].message, /report missing/);
      assert.equal(e.errors[1].message, "cleanup");
      return true;
    },
  );
  await assert.rejects(
    withCleanup(
      () => {},
      () => {
        throw new Error("cleanup-only");
      },
    ),
    /cleanup-only/,
  );
  await withCleanup(
    () => {},
    () => {},
  );
});

test("owned cleanup refuses foreign IDs/names/labels and never stops the foreign container", () => {
  for (const mutate of [
    (i) => {
      i.Id = "foreign";
    },
    (i) => {
      i.Name = "/foreign";
    },
    (i) => {
      i.Config.Labels["afc.run"] = "foreign";
    },
  ]) {
    const f = ownedFixture();
    mutate(f.request.inspect);
    const calls = [];
    assert.throws(
      () =>
        cleanContainer("id1", "afc_one", "run1", (...args) => {
          calls.push(args);
          return JSON.stringify([f.request.inspect]);
        }),
      /ownership mismatch/,
    );
    assert.deepEqual(calls, [["inspect", "id1"]]);
  }
  const good = ownedFixture();
  const calls = [];
  cleanContainer("id1", "afc_one", "run1", (...args) => {
    calls.push(args);
    if (args[0] === "ps") return "";
    return JSON.stringify([good.request.inspect]);
  });
  assert.deepEqual(calls, [
    ["inspect", "id1"],
    ["stop", "id1"],
    ["rm", "-v", "id1"],
    ["ps", "-a", "--no-trunc", "--filter", "id=id1", "--format", "{{.ID}}"],
  ]);
});

test("failed phase followed by success still returns nonzero and runs serially", async () => {
  const order = [];
  const result = await runPhaseSeries([{ name: "bad" }, { name: "good" }], async (phase) => {
    order.push(phase.name);
    if (phase.name === "bad") throw new Error("failure");
  });
  assert.deepEqual(order, ["bad", "good"]);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["failed", "passed"],
  );
  assert.equal(result.exitCode, 1);
  assert.equal((await runPhaseSeries([{ name: "good" }], () => {})).exitCode, 0);
  await assert.rejects(
    runPhaseSeries([], () => {}),
    /Empty phase run/,
  );
});

test("workflow build-test checkout fetches pinned history and rejects misplaced depth", () => {
  const { parse } = createRequire(new URL("../apps/api/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const check = (value) => {
    const steps = value.jobs?.["build-test"]?.steps;
    assert.ok(Array.isArray(steps));
    assert.equal(steps[0]?.uses, "actions/checkout@v4");
    assert.equal(steps.filter((s) => s.uses?.startsWith("actions/checkout@")).length, 1);
    assert.equal(steps[0].with?.["fetch-depth"], 0);
  };
  check(workflow);
  for (const depth of [undefined, 1, 50]) {
    const changed = structuredClone(workflow);
    changed.jobs["build-test"].steps[0].with = { "fetch-depth": depth };
    assert.throws(() => check(changed));
  }
  const missingStep = structuredClone(workflow);
  missingStep.jobs["build-test"].steps.shift();
  assert.throws(() => check(missingStep));
  const wrongStep = structuredClone(workflow);
  delete wrongStep.jobs["build-test"].steps[0].with;
  wrongStep.jobs["build-test"].steps[1].with = { "fetch-depth": 0 };
  assert.throws(() => check(wrongStep));
  const wrongJob = structuredClone(workflow);
  delete wrongJob.jobs["build-test"].steps[0].with;
  wrongJob.jobs.other = { steps: [{ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }] };
  assert.throws(() => check(wrongJob));
  const duplicate = structuredClone(workflow);
  duplicate.jobs["build-test"].steps.push({
    uses: "actions/checkout@v4",
    with: { "fetch-depth": 0 },
  });
  assert.throws(() => check(duplicate));
});

test("workflow calls the accepted M0 root once before product and preserves blocking safe evidence", async () => {
  const { parse } = createRequire(new URL("../apps/api/package.json", import.meta.url))("yaml");
  const yaml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parse(yaml);
  const { COMMON_GATES, NODE_TESTS, gatesFor } = await import("./ci-m0.mjs");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["ci:m0"], "node scripts/ci-m0.mjs");
  assert.equal(manifest.scripts["ci:product"], "node scripts/ci-m0.mjs --stage product");
  assert.deepEqual(NODE_TESTS, [
    "scripts/rebuild-bootstrap.test.mjs",
    "scripts/rebuild-fixtures.test.mjs",
    "scripts/ci-e2e.test.mjs",
    "scripts/ci-e2e.manifest.test.mjs",
    "scripts/ci-m0.test.mjs",
  ]);
  // Independent old-step -> accepted root gate oracle; do not derive expected commands from GATES.
  assert.deepEqual(
    COMMON_GATES.map((g) => [
      g.id,
      g.codegen
        ? "git diff --exit-code " + g.codegen
        : [g.command === process.execPath ? "node" : g.command, ...g.args].join(" "),
    ]),
    [
      ["bootstrap", "node scripts/rebuild-bootstrap.mjs"],
      ["fixtures", "node scripts/rebuild-fixtures.mjs"],
      ["api-types", "pnpm exec tsc -p scripts/tsconfig.rebuild-api-types.json --noEmit"],
      ["codegen", "pnpm codegen"],
      ["codegen-drift", "git diff --exit-code apps/web/lib/api-types.ts"],
      ["typecheck", "pnpm typecheck"],
      [
        "node-tests",
        "node --test scripts/rebuild-bootstrap.test.mjs scripts/rebuild-fixtures.test.mjs scripts/ci-e2e.test.mjs scripts/ci-e2e.manifest.test.mjs scripts/ci-m0.test.mjs",
      ],
      ["discovery-product", "node scripts/ci-e2e.manifest.mjs --stage product"],
      ["discovery-m0", "node scripts/ci-e2e.manifest.mjs --stage m0"],
      ["lint", "pnpm lint"],
      ["format", "pnpm format:check"],
      ["build", "pnpm build"],
      ["verify-no-test-seed", "pnpm --filter web verify:no-test-seed"],
      ["verify-contrast", "pnpm --filter web verify:contrast"],
      ["verify-font-payload", "pnpm --filter web verify:font-payload"],
    ],
  );
  const gates = gatesFor("m0");
  assert.equal(gates.length, 17);
  assert.deepEqual(gates.slice(0, 15), COMMON_GATES);
  assert.deepEqual(gates[15], { id: "owned-test", ownedTest: true });
  assert.equal(gates[16].id, "owned-e2e");
  assert.equal(gates[16].ownedE2E, true);
  assert.equal(gates[16].command, "xvfb-run");
  assert.deepEqual(gates[16].args, [
    "--auto-servernum",
    process.execPath,
    "scripts/ci-e2e.mjs",
    "--stage",
    "m0",
  ]);
  const check = (value) => {
    assert.deepEqual(Object.keys(value.jobs), ["build-test"]);
    const job = value.jobs["build-test"];
    for (const key of ["env", "defaults", "if", "continue-on-error", "services"])
      assert.equal(job[key], undefined, key);
    assert.equal(value.env, undefined);
    assert.equal(value.defaults, undefined);
    const steps = job.steps;
    assert.deepEqual(
      steps.map((s) => s.uses ?? s.run),
      [
        "actions/checkout@v4",
        "pnpm/action-setup@v4",
        "actions/setup-node@v4",
        "pnpm install --frozen-lockfile",
        "npx playwright install --with-deps chromium webkit",
        "node --test scripts/ci-e2e.n01.test.mjs",
        "pnpm ci:m0",
        "xvfb-run --auto-servernum node scripts/ci-e2e.mjs --stage product",
        "xvfb-run --auto-servernum node scripts/ci-e2e.n01.mjs",
        "actions/upload-artifact@v4",
      ],
    );
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(steps[0].with["fetch-depth"], 0);
    assert.deepEqual(steps[2].with, { "node-version": 20, cache: "pnpm" });
    assert.equal(steps[4]["working-directory"], "apps/web");
    for (const [i, step] of steps.entries()) {
      assert.ok(!(step.uses && step.run));
      for (const key of ["continue-on-error", "env", "shell"])
        assert.equal(step[key], undefined, key);
      assert.equal(step.if, i === 9 ? "always()" : undefined);
      assert.equal(step["working-directory"], i === 4 ? "apps/web" : undefined);
    }
    assert.deepEqual(steps[9].with, {
      name: "e2e-safe-evidence",
      path: "apps/web/e2e/.artifacts-ci/m0/*.json\napps/web/e2e/.artifacts-ci/product/*.json\napps/web/e2e/.artifacts-ci/n01/n01-summary-*.json\n",
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 7,
    });
  };
  check(workflow);
  const changes = [
    (w) => w.jobs["build-test"].steps.splice(5, 1),
    (w) => w.jobs["build-test"].steps.splice(8, 1),
    (w) => {
      w.jobs["build-test"].steps[5].run += " || true";
    },
    (w) => {
      w.jobs["build-test"].steps[8]["continue-on-error"] = true;
    },
    (w) => {
      w.jobs["build-test"].steps[9].with.path = w.jobs["build-test"].steps[9].with.path.replace(
        "apps/web/e2e/.artifacts-ci/n01/n01-summary-*.json\n",
        "",
      );
    },
    (w) => w.jobs["build-test"].steps.splice(6, 1),
    (w) => {
      w.jobs["build-test"].steps[6].run = "pnpm ci:product";
    },
    (w) => {
      const s = w.jobs["build-test"].steps;
      [s[5], s[6]] = [s[6], s[5]];
    },
    (w) => w.jobs["build-test"].steps.splice(5, 0, { run: "pnpm typecheck" }),
    (w) => w.jobs["build-test"].steps.splice(4, 0, { run: "pnpm install --frozen-lockfile" }),
    (w) => w.jobs["build-test"].steps.splice(5, 0, structuredClone(w.jobs["build-test"].steps[4])),
    (w) => {
      w.jobs["build-test"].services = { postgres: { image: "postgres:16" } };
    },
    (w) => {
      w.jobs["build-test"].steps[6].env = { DATABASE_URL: "synthetic-old-service" };
    },
    (w) => {
      w.jobs["build-test"].env = { DATABASE_URL: "synthetic-old-service" };
    },
    (w) => {
      w.jobs["build-test"].steps[6]["continue-on-error"] = true;
    },
    (w) => {
      w.jobs["build-test"].steps[6].if = "failure()";
    },
    (w) => {
      w.jobs["build-test"].steps[7].if = "always()";
    },
    (w) => {
      w.jobs["build-test"].steps[6].run += " || true";
    },
    (w) => {
      w.jobs["build-test"].steps[6].shell = "bash {0}; exit 0";
    },
    (w) => {
      w.jobs["build-test"].steps[9].if = "success()";
    },
    (w) => {
      w.jobs["build-test"].steps[9].with["include-hidden-files"] = false;
    },
    (w) => {
      w.jobs["build-test"].steps[9].with["if-no-files-found"] = "warn";
    },
    (w) => {
      w.jobs["build-test"].steps[9].with["retention-days"] = 1;
    },
    (w) => {
      w.jobs["build-test"].steps[9].with.path += "apps/web/e2e/.report/**";
    },
    (w) => {
      w.jobs.other = { steps: [w.jobs["build-test"].steps.splice(6, 1)[0]] };
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(workflow);
    change(changed);
    assert.throws(() => check(changed));
  }
  // A comment or similar script name cannot stand in for the actual invocation.
  assert.throws(() =>
    check(
      parse(yaml.replace("run: pnpm ci:m0", "run: pnpm ci:m0-other") + "\n# - run: pnpm ci:m0\n"),
    ),
  );
});

test("pinned manifest covers the independent baseline file inventory and phase/browser partition", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = loadManifest(root);
  assert.equal(manifest.baselineSha, "7825c93ac9b1cc3ae8ae494b07ad7e693f6352cd");
  assert.equal(new Set(manifest.cases.map((r) => r.file)).size, 27);
  assert.deepEqual(
    [...new Set(manifest.cases.map((r) => r.phase))].sort(),
    phases.map((p) => p.name).sort(),
  );
  assert.equal(manifest.conditional.length, 2);
  assert.ok(manifest.conditional.every((r) => r.requiredOutcome === "passed"));
  assert.ok(
    manifest.exclusions.every((r) => r.browser === "webkit-ios" && r.reason && r.condition),
  );
});

test("immutable legacy229/conditional2 and first16 phases are preserved; independent M0 union is exact", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const show = (file) =>
    execFileSync("git", ["show", `a6b176b72abfe8beadfc97810c5a98b3781d2484:${file}`], {
      cwd: root,
      encoding: "utf8",
    });
  const baseline = JSON.parse(show("apps/web/e2e/ci-manifest.json"));
  const actual = loadManifest(root);
  assert.deepEqual(
    actual.cases.filter((r) => r.stage === "product"),
    baseline.cases,
  );
  assert.deepEqual(actual.exclusions, baseline.exclusions);
  assert.deepEqual(actual.conditional, baseline.conditional);
  const literal = show("scripts/ci-e2e.mjs").match(
    /export const phases = ([\s\S]*?);\r?\n\r?\nconst root/,
  )[1];
  assert.deepEqual(
    phases.slice(0, 16),
    JSON.parse(JSON.stringify(runInNewContext(`(${literal})`))),
  );
  const expected = [];
  for (const [mode, suffix] of [
    ["direct", "direct"],
    ["proxy", "proxy"],
  ]) {
    for (const [browser, p] of [
      ["chromium-mobile", "c"],
      ["webkit-ios", "w"],
    ]) {
      for (const title of [
        "shell consumes real API contract",
        "fresh principal renders empty program",
        "real missing session renders recoverable error",
      ])
        expected.push([`M0-06 ${mode}`, title, browser, `m0-${suffix}-${p}`]);
    }
  }
  assert.deepEqual(
    actual.cases.filter((r) => r.stage === "m0").map((r) => [...r.case, r.browser, r.phase]),
    expected,
  );
  for (const phase of phases.slice(16))
    assert.deepEqual(phase.args, [
      "m0-06-shell-api.spec.ts",
      "--grep",
      phase.name.includes("proxy") ? "M0-06 proxy" : "M0-06 direct",
    ]);
});

test("N01 occupied own port is rejected without stopping its owner; group cleanup is scoped", async () => {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve) => server.listen({ host: "::", port: 0 }, resolve));
  const port = server.address().port;
  try {
    await assert.rejects(freePort(port), (e) => e.code === "PORT_OCCUPIED");
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await freePort(port), port);
  const calls = [];
  await closeOwnedGroup(12345, (pid, signal) => {
    calls.push([pid, signal]);
    if (calls.length > 1) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  assert.ok(calls.every(([pid]) => pid === -12345));
});

test("404 console diagnostics require exact source, observed method/status and bounded occurrence", () => {
  const url = "http://localhost:4444/v1/programs/current";
  const text = "Failed to load resource: the server responded with a status of 404 (Not Found)";
  const response = { url, method: "GET", status: 404 };
  assert.equal(classifyConsole([{ url, text }], [response], [url]).unexpected, 0);
  for (const error of [
    { url: "", text },
    { url, text: "hydration failed" },
    { url: url + "/other", text },
  ])
    assert.equal(classifyConsole([error], [response], [url]).unexpected, 1);
  for (const changed of [
    { ...response, status: 500 },
    { ...response, method: "POST" },
  ])
    assert.equal(classifyConsole([{ url, text }], [changed], [url]).unexpected, 1);
  assert.equal(
    classifyConsole(
      [
        { url, text },
        { url, text },
      ],
      [response],
      [url],
    ).unexpected,
    1,
  );
  assert.equal(
    classifyConsole(
      [
        { url, text },
        { url, text },
      ],
      [response, response],
      [url],
    ).unexpected,
    0,
  );
});

test("EE G3 raw and public network diagnostics enforce case lower bounds and exact keys", async () => {
  const { networkProjection, validateNetworkProjection } = await import("./ci-e2e.mjs");
  assert.equal(typeof networkProjection, "function");
  const profile = makeProfile("direct", 4101, 4102);
  const row = loadManifest(path.resolve(".")).cases.find((r) => r.phase === "m0-direct-c");
  const url = profile.apiTarget + "/v1/programs/current";
  const raw = {
    unexpected: 0,
    expectedNetwork: [],
    responses: [{ url, method: "GET", status: 404 }],
  };
  const safe = networkProjection(raw, row, profile);
  assert.equal(safe.observed404, 0);
  assert.equal(safe.responses404, 1);
  assert.ok(!JSON.stringify(safe).includes(url));
  validateNetworkProjection([safe], [row]);
  for (const changed of [
    { ...raw, responses: [] },
    { ...raw, extra: "secret" },
    { ...raw, unexpected: 1 },
    { ...raw, responses: [{ url: url + "/other", method: "GET", status: 404 }] },
    { ...raw, expectedNetwork: [{ url, count: 2 }] },
  ])
    assert.throws(() => networkProjection(changed, row, profile));
  const missing = {
    ...row,
    case: ["M0-06 direct", "real missing session renders recoverable error"],
  };
  const session = profile.apiTarget + "/v1/sessions/11111111-1111-4111-8111-111111111111";
  const response = { url: session, method: "GET", status: 404 };
  assert.throws(() => networkProjection({ ...raw, responses: [response] }, missing, profile));
  const missingSafe = networkProjection(
    { ...raw, responses: [response, response] },
    missing,
    profile,
  );
  assert.equal(missingSafe.responses404, 2);
  for (const changed of [
    { ...missingSafe, responses404: 1 },
    { ...safe, url },
    { ...safe, case: ["wrong"] },
    { ...safe, attachmentDigest: "bad" },
  ])
    assert.throws(() => validateNetworkProjection([changed], [row]));
});

test("EE allocate owns partial rollback once and transfers successful release responsibility", async () => {
  const { allocateOwnedPhase, releaseOwnedPhase, allocationFailure, validateOwnedPhaseAllocation } =
    await import("./ci-e2e.mjs");
  const { createServer } = await import("node:net");
  const { existsSync } = await import("node:fs");
  const base = mkdtempSync(path.join(tmpdir(), "afc-ee-allocation-"));
  const states = [];
  function model({ unready = false, missingId = false, failCleanup = false } = {}) {
    const state = { created: false, rm: 0, groups: 0, run: null, name: null };
    states.push(state);
    const command = (cmd, ...args) => {
      if (cmd === "run") {
        state.created = true;
        state.name = args[args.indexOf("--name") + 1];
        state.run = args.find((a) => a.startsWith("afc.run=")).slice(8);
        return missingId ? "" : "a".repeat(64);
      }
      if (cmd === "inspect")
        return JSON.stringify([
          {
            Id: "a".repeat(64),
            Name: "/" + state.name,
            Config: {
              Image: "postgres:16",
              Labels: {
                "afc.run": state.run,
                "afc.owner": "automation-m0-06",
                "afc.purpose": "owned-e2e",
              },
            },
            HostConfig: { Tmpfs: { "/var/lib/postgresql/data": "" } },
            Mounts: [],
            NetworkSettings: {
              Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45321" }] },
            },
          },
        ]);
      if (cmd === "ps") return state.created ? "a".repeat(64) : "";
      if (cmd === "stop") {
        if (failCleanup) throw new Error("synthetic cleanup");
        return "";
      }
      if (cmd === "rm") {
        state.rm++;
        state.created = false;
        return "";
      }
      throw new Error("unexpected fake command");
    };
    return {
      state,
      ops: {
        base,
        command,
        ready: () => !unready,
        wait: async () => {},
        git: () => "b".repeat(40),
        group: async () => {
          state.groups++;
          throw new Error("unowned group");
        },
        physicalCleanup: (file, d) => {
          assert.ok(path.resolve(file).startsWith(path.resolve(base) + path.sep));
          assert.equal(
            JSON.parse(readFileSync(path.join(file, ".afc-position-root.json"), "utf8")).token,
            d.token,
          );
          rmSync(file, { recursive: true });
          return { physicalProfileAbsent: true };
        },
      },
    };
  }
  const server = createServer();
  await new Promise((resolve) => server.listen({ host: "::", port: 0 }, resolve));
  const port = server.address().port;
  try {
    for (const mode of [
      {},
      { unready: true },
      { missingId: true },
      { unready: true, failCleanup: true },
    ]) {
      const m = model(mode);
      let caught;
      try {
        await allocateOwnedPhase(
          { phaseName: "n01-occupied-port", fixedPorts: { api: port } },
          m.ops,
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught);
      const failed = allocationFailure(caught);
      assert.equal(failed.launchCount, 0);
      assert.equal(m.state.groups, 0);
      assert.equal(failed.cleanup.processGroupAbsent, "notAllocated");
      assert.equal(failed.cleanup.portsAbsent, "notAllocated");
      if (mode.failCleanup) {
        assert.ok(caught instanceof AggregateError);
        assert.equal(caught.errors.length, 2);
        assert.equal(failed.cleanup.exactContainerAbsent, "unknown");
      } else {
        assert.equal(m.state.rm, 1);
        assert.equal(failed.cleanup.exactContainerAbsent, true);
      }
      assert.equal(server.listening, true);
      await assert.rejects(releaseOwnedPhase(failed.handle));
    }
    await new Promise((resolve) => server.close(resolve));
    const m = model();
    const handle = await allocateOwnedPhase(
      { phaseName: "n01-occupied-port", fixedPorts: { api: port } },
      m.ops,
    );
    assert.equal(m.state.rm, 0);
    assert.equal(handle.context.launchCount, 0);
    assert.equal(handle.owner.profile.apiPort, port);
    validateOwnedPhaseAllocation(handle);
    const cleanup = await releaseOwnedPhase(handle);
    assert.equal(m.state.rm, 1);
    assert.equal(cleanup.portsAbsent, true);
    assert.equal(cleanup.physicalProfileAbsent, true);
    assert.equal(cleanup.processGroupAbsent, "notAllocated");
    assert.equal(existsSync(handle.physical), false);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    assert.ok(base.startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(base, { recursive: true, force: true });
  }
});

test("EE actual report collection validates attachment ownership, count, identity and nested schema", async () => {
  const { collectNetworkDiagnostics } = await import("./ci-e2e.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "afc-g3-report-"));
  try {
    const f = ownedFixture(),
      row = {
        file: "apps/web/e2e/m0-06-shell-api.spec.ts",
        case: ["M0-06 direct", "shell consumes real API contract"],
        browser: "chromium-mobile",
        config: "playwright.config.ts",
        repeatEachIndex: 0,
      };
    const suite = f.report.suites[0],
      spec = suite.specs[0],
      result = spec.tests[0].results[0];
    suite.title = "M0-06 direct";
    f.report.suites = [{ title: "m0-06-shell-api.spec.ts", suites: [suite] }];
    spec.title = row.case[1];
    spec.file = "m0-06-shell-api.spec.ts";
    const url = `${f.request.owner.profile.apiBase}/programs/current`,
      raw = {
        unexpected: 0,
        expectedNetwork: [],
        responses: [{ url, method: "GET", status: 404 }],
      };
    const attachment = {
      name: "m0-network-diagnostics",
      contentType: "application/json",
      body: JSON.stringify(raw),
    };
    result.attachments = [attachment];
    f.request.owner.output = dir;
    const evidence = { provenance: structuredClone(f.request.context), report: f.report };
    const consume = () =>
      collectNetworkDiagnostics(evidence, f.request.owner, f.request.context, [row]);
    assert.equal(consume()[0].observed404, 0);
    assert.equal(consume()[0].responses404, 1);
    attachment.body = Buffer.from(JSON.stringify(raw)).toString("base64");
    assert.equal(consume().length, 1);
    for (const mutate of [
      () => {
        result.attachments = [];
      },
      () => {
        result.attachments = [attachment, attachment];
      },
      () => {
        attachment.contentType = "text/plain";
      },
      () => {
        attachment.body = JSON.stringify({ ...raw, env: "private" });
      },
      () => {
        attachment.body = JSON.stringify({ ...raw, responses: [] });
      },
      () => {
        attachment.body = JSON.stringify({
          ...raw,
          responses: [{ url: url + "/other", method: "GET", status: 404 }],
        });
      },
      () => {
        evidence.provenance.run = "foreign";
      },
    ]) {
      const saved = structuredClone(attachment);
      mutate();
      assert.throws(consume);
      Object.assign(attachment, saved);
      result.attachments = [attachment];
      evidence.provenance.run = f.request.context.run;
    }
    delete attachment.body;
    attachment.path = path.join(dir, "attachment.json");
    writeFileSync(attachment.path, JSON.stringify(raw));
    assert.equal(consume().length, 1);
    attachment.path = path.join(dir, "..", "foreign.json");
    assert.throws(consume);
    const fs = await import("node:fs");
    const link = path.join(dir, "link");
    fs.symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
    attachment.path = path.join(link, "attachment.json");
    assert.throws(consume);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(dir, { recursive: true });
  }
});

// FEP: real producer/first writer regressions. These are local data/launcher models, not Linux E2E.
function failureFixture() {
  const f = ownedFixture();
  const dir = mkdtempSync(path.join(tmpdir(), "afc-fep-"));
  f.request.owner.output = dir;
  f.request.owner.run = "11111111-1111-4111-8111-111111111111";
  f.request.context.run = f.request.owner.run;
  f.request.context.stage = "product";
  f.request.context.selectionHash = "b".repeat(64);
  f.request.context.reportPath = path.join(dir, "results.json");
  f.request.env.AFC_TEST_RUN_ID = f.request.owner.run;
  f.request.env.PLAYWRIGHT_JSON_OUTPUT_NAME = f.request.context.reportPath;
  f.request.env.PLAYWRIGHT_JSON_OUTPUT_FILE = f.request.context.reportPath;
  f.request.inspect.Config.Labels["afc.run"] = f.request.owner.run;
  f.adapters.writeProvenance = (c) =>
    writeFileSync(path.join(dir, "execution-provenance.json"), JSON.stringify(c));
  f.adapters.readEvidence = () => ({
    provenance: JSON.parse(readFileSync(path.join(dir, "execution-provenance.json"))),
    report: JSON.parse(readFileSync(f.request.context.reportPath)),
  });
  f.adapters.writePrivate = (name, data) => writeFileSync(path.join(dir, name), data);
  f.options = { stage: "product", selectionHash: "b".repeat(64) };
  f.dispose = () => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(dir, { recursive: true, force: true });
  };
  return f;
}

test("FEP RED/GREEN nonzero child preserves full trusted report diagnostics and failure", async () => {
  const f = failureFixture();
  try {
    f.report.suites[0].specs[0].tests[0].results[0].status = "failed";
    f.adapters.launch = (_command, _args, _options, _onSpawn, markAbort) => {
      assert.equal(markAbort, rememberAbortedLaunch);
      writeFileSync(f.request.context.reportPath, JSON.stringify(f.report));
      return { status: 7, signal: null, closed: true, error: undefined };
    };
    const value = await runPhaseSeries(
      [f.request.phase, phases[2]],
      (phase) => phase === f.request.phase && executeOwnedPhase(f.request, f.adapters),
      f.options,
    );
    assert.equal(value.exitCode, 1);
    assert.equal(value.results[1].status, "passed");
    const d = value.results[0].failureEvidence;
    assert.ok(d, "failureEvidence must be produced, not just a generic operation code");
    assert.equal(d.failureAt, "launcher");
    assert.deepEqual(d.launcher, { status: 7, signal: "none", closed: true, errorKind: "none" });
    assert.equal(d.context.sha, f.request.context.sha);
    assert.equal(d.context.phaseRun, f.request.owner.run);
    assert.equal(d.report.state, "parsed");
    assert.equal(d.cases.length, 1);
    assert.equal(d.cases[0].observed, "failed");
    assert.equal(d.diagnosisComplete, true);
  } finally {
    f.dispose();
  }
});

async function failedProduction(f, launch, change = {}) {
  f.adapters.launch = launch;
  Object.assign(f.adapters, change);
  return runPhaseSeries(
    [f.request.phase, phases[2]],
    (p) => p === f.request.phase && executeOwnedPhase(f.request, f.adapters),
    f.options,
  );
}
function decodeFixture(
  f,
  report = f.report,
  expected = f.request.expected,
  provenance = f.request.context,
) {
  return decodeFailureReport(
    report,
    expected,
    f.request.context,
    provenance,
    Buffer.from(JSON.stringify(report)),
  );
}
function reportRows(f, count) {
  const original = f.report.suites[0].specs[0];
  f.report.suites[0].specs = Array.from({ length: count }, (_, i) => ({
    ...structuredClone(original),
    title: `case ${i}`,
  }));
  f.request.expected = f.report.suites[0].specs.map((s) => ({
    ...f.request.expected[0],
    case: [s.title],
  }));
}

test("FEP actual launcher first-error marker, partial returns, closed state and signal allowlist", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private reason"));
  const pre = await privateLaunch(
    "never",
    [],
    { signal: controller.signal },
    undefined,
    rememberAbortedLaunch,
  );
  assert.deepEqual(launcherSnapshot(pre).launcher, {
    status: null,
    signal: null,
    closed: null,
    errorKind: "abort",
  });
  const syncModel = launchModel({
    spawnFailure: Object.assign(new Error("private"), { syscall: "spawn secret" }),
  });
  assert.deepEqual(launcherSnapshot(await syncModel.launch({})).launcher, {
    status: null,
    signal: null,
    closed: null,
    errorKind: "spawn",
  });
  const missing = await privateLaunch(path.join(tmpdir(), "afc-does-not-exist-528cf49b"), [], {
    stdio: "pipe",
    detached: true,
  });
  assert.equal(launcherSnapshot(missing).launcher.errorKind, "spawn");
  for (const mode of ["timeout", "output-limit", "private-io", "other", "abort"]) {
    const m = launchModel(),
      c = new AbortController(),
      promise = m.launch({ signal: c.signal, timeout: 5 });
    if (mode === "timeout") m.tick(5);
    if (mode === "output-limit") m.child.stdout.emit("data", Buffer.alloc(32 * 1024 * 1024 + 1));
    if (mode === "private-io") m.child.stderr.emit("error", new Error("private"));
    if (mode === "other") m.child.emit("error", new Error("first private"));
    c.abort(new Error("late private"));
    m.tick(4000);
    const value = await promise;
    assert.equal(launcherSnapshot(value).launcher.errorKind, mode);
    assert.equal(launcherSnapshot(value).launcher.closed, false);
  }
  assert.equal(
    launcherSnapshot({ status: 1, signal: "SIGPRIVATE", closed: true }).launcher.signal,
    "unknown",
  );
  assert.equal(
    launcherSnapshot({ status: 1, signal: "SIGXFSZ", closed: true }).launcher.signal,
    "SIGXFSZ",
  );
  assert.equal(
    launcherSnapshot({ status: 1, error: new Error("unknown") }).launcher.errorKind,
    "other",
  );
});

test("FEP snapshot uses own data descriptors without invoking nullable or error getters", () => {
  let calls = 0;
  const value = { status: 2, signal: null, closed: true };
  Object.defineProperty(value, "status", {
    get() {
      calls++;
      throw Error("secret");
    },
  });
  const observed = launcherSnapshot(value);
  assert.equal(observed.launcher.status, null);
  assert.equal(observed.complete, false);
  assert.equal(calls, 0);
  Object.defineProperty(value, "error", {
    get() {
      calls++;
      throw Error("secret");
    },
  });
  assert.throws(() => launcherSnapshot(value));
  assert.equal(calls, 0);
  const error = new Error("private");
  Object.defineProperty(error, "code", {
    get() {
      calls++;
      return "ETIMEDOUT";
    },
  });
  assert.throws(() => launcherSnapshot({ error }));
  assert.equal(calls, 0);
  assert.throws(() =>
    launcherSnapshot(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error("private");
          },
        },
      ),
    ),
  );
});

test("FEP real producer distinguishes injected throw, native partial spawn, pre-abort and private write failure", async () => {
  for (const mode of [
    "throw",
    "partial-spawn",
    "pre-abort",
    "private-write",
    "bad-error-descriptor",
  ]) {
    const f = failureFixture();
    try {
      const error = Object.assign(new Error("private sentinel"), {
        syscall: "spawn private-command",
      });
      const launcher =
        mode === "partial-spawn"
          ? { status: null, error }
          : mode === "pre-abort"
            ? rememberAbortedLaunch({ status: null, error: new Error("reason") })
            : { status: 9, signal: null, closed: true };
      if (mode === "bad-error-descriptor")
        Object.defineProperty(launcher, "error", {
          get() {
            throw Error("private getter");
          },
        });
      const result = await failedProduction(
        f,
        () => {
          if (mode === "throw") throw error;
          return launcher;
        },
        mode === "private-write"
          ? {
              writePrivate() {
                throw Object.assign(new Error("private write"), { code: "PRIVATE_IO" });
              },
            }
          : {},
      );
      const row = result.results[0],
        d = row.failureEvidence;
      assert.equal(result.exitCode, 1);
      assert.equal(result.results[1].status, "passed");
      if (mode === "throw") {
        assert.equal(d.failureAt, "spawn");
        assert.equal(d.launcher, null);
      }
      if (mode === "partial-spawn") {
        assert.equal(d.failureAt, "spawn");
        assert.deepEqual(d.launcher, {
          status: null,
          signal: null,
          closed: null,
          errorKind: "spawn",
        });
      }
      if (mode === "pre-abort") {
        assert.equal(d.failureAt, "launcher");
        assert.equal(d.launcher.errorKind, "abort");
        assert.equal(d.launcher.closed, null);
      }
      if (mode === "private-write") {
        assert.equal(d.failureAt, "private-io");
        assert.equal(d.launcher.status, 9);
        assert.equal(row.error, "PRIVATE_IO");
      }
      if (mode === "bad-error-descriptor") {
        assert.equal(d.failureAt, "diagnosis");
        assert.equal(d.launcher, null);
      }
    } finally {
      f.dispose();
    }
  }
});

test("FEP actual producer child0 missing/parse/shape/provenance/stale failures retain launcher0", async () => {
  for (const [mode, at, state] of [
    ["missing", "report-missing", "missing"],
    ["invalid", "report-parse", "invalid-json"],
    ["shape", "report-parse", "invalid-shape"],
    ["provenance", "report-validate", "wrong-provenance"],
    ["stale", "report-validate", "stale"],
  ]) {
    const f = failureFixture();
    try {
      if (mode === "shape") delete f.report.suites;
      if (mode === "provenance") f.report.config.configFile = path.join(tmpdir(), "wrong.ts");
      if (mode === "stale") f.report.stats.startTime = "2020-01-01T00:00:00Z";
      const result = await failedProduction(f, () => {
        if (mode !== "missing")
          writeFileSync(
            f.request.context.reportPath,
            mode === "invalid" ? "{" : JSON.stringify(f.report),
          );
        return { status: 0, signal: null, closed: true };
      });
      const d = result.results[0].failureEvidence;
      assert.equal(d.failureAt, at);
      assert.equal(d.report.state, state);
      assert.equal(d.launcher.status, 0);
      assert.equal(d.cases, null);
      assert.equal(result.exitCode, 1);
    } finally {
      f.dispose();
    }
  }
});

test("FEP core113/128 entire expected identities, partial missing, overflow and six-passed nonzero stay failures", async () => {
  const f = failureFixture();
  try {
    for (const count of [113, 128]) {
      reportRows(f, count);
      let d = decodeFixture(f);
      assert.equal(d.cases.length, count);
      assert.equal(d.diagnosisComplete, true);
      f.report.suites[0].specs.pop();
      d = decodeFixture(f);
      assert.equal(d.cases.length, count);
      assert.equal(d.cases.at(-1).observed, "missing");
      assert.equal(d.diagnosisComplete, true);
    }
    reportRows(f, 129);
    let d = decodeFixture(f);
    assert.equal(d.report.state, "limit-exceeded");
    assert.equal(d.cases, null);
    reportRows(f, 6);
    const result = await failedProduction(f, () => {
      writeFileSync(f.request.context.reportPath, JSON.stringify(f.report));
      return { status: 1, signal: null, closed: true };
    });
    d = result.results[0].failureEvidence;
    assert.equal(result.exitCode, 1);
    assert.equal(d.cases.length, 6);
    assert.ok(d.cases.every((r) => r.observed === "passed"));
    assert.equal(d.diagnosisComplete, true);
  } finally {
    f.dispose();
  }
});

test("FEP decoder leaf optional key only; mandatory arrays, nested titles and occurrence match success rules", () => {
  const f = failureFixture();
  try {
    assert.equal(decodeFixture(f).report.state, "parsed");
    for (const value of [undefined, null, {}, "private"]) {
      const report = structuredClone(f.report);
      report.suites[0].suites = value;
      assert.equal(decodeFixture(f, report).report.state, "invalid-shape");
    }
    const valid = structuredClone(f.report);
    valid.suites[0].suites = [];
    assert.equal(decodeFixture(f, valid).report.state, "parsed");
    for (const mutate of [
      (r) => delete r.suites,
      (r) => delete r.suites[0].specs,
      (r) => delete r.suites[0].specs[0].tests,
      (r) => delete r.suites[0].specs[0].tests[0].results,
    ]) {
      const r = structuredClone(f.report);
      mutate(r);
      assert.equal(decodeFixture(f, r).report.state, "invalid-shape");
    }
    const nested = structuredClone(f.report);
    nested.suites[0] = { specs: [], suites: [{ title: "group", specs: nested.suites[0].specs }] };
    assert.deepEqual(
      decodeFixture(f, nested, [{ ...f.request.expected[0], case: ["group", "owned roundtrip"] }])
        .cases[0].case,
      ["group", "owned roundtrip"],
    );
    const repeated = structuredClone(f.report);
    repeated.suites[0].specs.push(structuredClone(repeated.suites[0].specs[0]));
    const extra = decodeFixture(f, repeated);
    assert.equal(extra.unknownCases, 1);
    assert.equal(extra.duplicateCases, 0);
    assert.equal(extra.diagnosisComplete, false);
    const expected = [f.request.expected[0], { ...f.request.expected[0], repeatEachIndex: 1 }];
    assert.deepEqual(
      decodeFixture(f, repeated, expected).cases.map((r) => r.repeatEachIndex),
      [0, 1],
    );
  } finally {
    f.dispose();
  }
});

test("FEP decoder last result status only, attempts bounds, unknown status and global errors count", () => {
  const f = failureFixture();
  try {
    for (const [results, observed, attempts, complete] of [
      [[], "missing", 0, true],
      [[{ status: "failed" }, { status: "passed" }], "passed", 2, true],
      [[{ status: "timedOut" }], "timedOut", 1, true],
      [[{ status: "interrupted" }], "interrupted", 1, true],
      [[{ status: "skipped" }], "skipped", 1, true],
      [[{ status: "expected" }], "missing", 1, false],
      [Array.from({ length: 11 }, () => ({ status: "passed" })), "passed", null, false],
    ]) {
      const r = structuredClone(f.report);
      r.suites[0].specs[0].tests[0].results = results;
      r.suites[0].specs[0].tests[0].status = "unexpected";
      const d = decodeFixture(f, r);
      assert.equal(d.cases[0].observed, observed);
      assert.equal(d.cases[0].attempts, attempts);
      assert.equal(d.diagnosisComplete, complete);
    }
    f.report.errors = Array(1001).fill({ message: "private" });
    const d = decodeFixture(f);
    assert.equal(d.globalErrors, null);
    assert.equal(d.diagnosisComplete, false);
  } finally {
    f.dispose();
  }
});

test("FEP bounded decoder depth/node/row/expected limits do not truncate or accept malformed/getter arrays", () => {
  const f = failureFixture();
  try {
    const depth = structuredClone(f.report);
    let leaf = depth.suites[0];
    for (let i = 1; i < 17; i++) {
      leaf.suites = [{ title: "nested", specs: [] }];
      leaf = leaf.suites[0];
    }
    assert.equal(decodeFixture(f, depth).report.state, "limit-exceeded");
    const rows = structuredClone(f.report);
    rows.suites[0].specs[0].tests = Array.from({ length: 4097 }, () =>
      structuredClone(rows.suites[0].specs[0].tests[0]),
    );
    assert.equal(decodeFixture(f, rows).report.state, "limit-exceeded");
    const nodes = structuredClone(f.report);
    nodes.suites[0].specs[0].tests[0].results = Array.from({ length: 20000 }, () => ({
      status: "passed",
    }));
    assert.equal(decodeFixture(f, nodes).report.state, "limit-exceeded");
    const huge = structuredClone(f.report);
    huge.suites.length = 20001;
    assert.equal(decodeFixture(f, huge).report.state, "limit-exceeded");
    const raw = Buffer.from(JSON.stringify(f.report));
    let calls = 0;
    Object.defineProperty(f.report, "suites", {
      get() {
        calls++;
        return [];
      },
    });
    const d = decodeFailureReport(
      f.report,
      f.request.expected,
      f.request.context,
      f.request.context,
      raw,
    );
    assert.equal(d.report.state, "invalid-shape");
    assert.equal(calls, 0);
  } finally {
    f.dispose();
  }
});

test("FEP bounded regular report read distinguishes missing/unreadable/oversize/full digest and provenance", async () => {
  const fs = await import("node:fs"),
    crypto = await import("node:crypto");
  const f = failureFixture();
  try {
    const read = () => readFailureReport(f.request.owner, f.request.context, f.request.expected);
    assert.equal(read().report.state, "missing");
    fs.mkdirSync(f.request.context.reportPath);
    assert.equal(read().report.state, "unreadable");
    fs.rmSync(f.request.context.reportPath, { recursive: true });
    const fd = fs.openSync(f.request.context.reportPath, "wx");
    fs.ftruncateSync(fd, 33554433);
    fs.closeSync(fd);
    assert.deepEqual(read().report, { state: "oversize", bytes: 33554433, digest: null });
    fs.rmSync(f.request.context.reportPath);
    writeFileSync(f.request.context.reportPath, "{");
    assert.deepEqual(read().report, {
      state: "invalid-json",
      bytes: 1,
      digest: crypto.createHash("sha256").update("{").digest("hex"),
    });
    writeFileSync(f.request.context.reportPath, JSON.stringify(f.report));
    assert.equal(read().report.state, "wrong-provenance");
    f.adapters.writeProvenance(f.request.context);
    assert.equal(read().report.state, "parsed");
    const link = path.join(f.request.owner.output, "link");
    fs.symlinkSync(f.request.owner.output, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(
      readFailureReport(
        { ...f.request.owner, output: link },
        { ...f.request.context, reportPath: path.join(link, "results.json") },
        f.request.expected,
      ).report.state,
      "unreadable",
    );
    if (process.platform !== "win32") {
      const other = path.join(f.request.owner.output, "target");
      writeFileSync(other, "{}");
      fs.rmSync(f.request.context.reportPath);
      fs.symlinkSync(other, f.request.context.reportPath, "file");
      assert.equal(read().report.state, "unreadable");
    }
  } finally {
    f.dispose();
  }
});

test("FEP own cleanup/rollback wrappers preserve diagnostics; foreign wrappers and map misses use canonical", async () => {
  const { allocateOwnedPhase } = await import("./ci-e2e.mjs");
  const f = failureFixture();
  try {
    f.adapters.launch = () => ({ status: 1, signal: null, closed: true });
    let result = await runPhaseSeries(
      [f.request.phase, phases[2]],
      (p) =>
        p === f.request.phase &&
        withCleanup(
          () => executeOwnedPhase(f.request, f.adapters),
          () => {
            throw Error("cleanup private");
          },
        ),
      f.options,
    );
    assert.equal(result.results[0].failureEvidence.failureAt, "launcher");
    assert.equal(result.results[0].failures.length, 2);
    assert.equal(result.results[1].status, "passed");
    result = await runPhaseSeries(
      [f.request.phase],
      () =>
        withCleanup(
          () => {},
          () => {
            throw Error("cleanup private");
          },
        ),
      f.options,
    );
    assert.equal(result.results[0].failureEvidence.failureAt, "cleanup");
    assert.equal(result.results[0].error, "CLEANUP_FAILED");
    result = await runPhaseSeries(
      [f.request.phase],
      () => {
        throw new AggregateError([Error("foreign private")], "private");
      },
      f.options,
    );
    assert.deepEqual(
      result.results[0].failureEvidence,
      canonicalFailure(failureContext("product", f.request.phase.name, f.options.selectionHash)),
    );
    result = await runPhaseSeries(
      [f.request.phase],
      () =>
        allocateOwnedPhase(
          {
            phaseName: f.request.phase.name,
            diagnosticContext: failureContext(
              "product",
              f.request.phase.name,
              f.options.selectionHash,
            ),
          },
          {
            base: f.request.owner.output,
            mkdir() {},
            writeJson() {},
            command() {
              throw Error("allocation private");
            },
            physicalCleanup() {
              throw Error("cleanup private");
            },
          },
        ),
      f.options,
    );
    assert.equal(result.results[0].failureEvidence.failureAt, "allocation");
    assert.equal(result.results[0].failureEvidence.context.sha, null);
    assert.match(result.results[0].failureEvidence.context.phaseRun, /^[a-f0-9-]{36}$/);
    assert.equal(result.results[0].failures.length, 2);
  } finally {
    f.dispose();
  }
});

test("FEP strict validator rejects extras/identity duplication/context spoof/getters without raw serialization", () => {
  const f = failureFixture();
  try {
    const context = {
      ...failureContext("product", f.request.phase.name, f.options.selectionHash),
      sha: f.request.context.sha,
      phaseRun: f.request.owner.run,
    };
    const valid = {
      context,
      failureAt: "launcher",
      launcher: { status: 1, signal: "none", closed: true, errorKind: "none" },
      ...decodeFixture(f),
    };
    let calls = 0;
    Object.setPrototypeOf(valid, {
      toJSON() {
        calls++;
        throw Error("private");
      },
    });
    assert.equal(validateFailureEvidence(valid, context, f.request.expected).launcher.status, 1);
    assert.equal(calls, 0);
    for (const mutate of [
      (d) => (d.extra = "private"),
      (d) => (d.context.sha = "c".repeat(40)),
      (d) => (d.context.phaseRun = "22222222-2222-4222-8222-222222222222"),
      (d) => (d.context.stage = "m0"),
      (d) => (d.context.selectionHash = "c".repeat(64)),
      (d) => (d.context.config = "playwright.fact-window.config.ts"),
      (d) => d.cases.push(d.cases[0]),
      (d) => (d.launcher.signal = "SIGPRIVATE"),
      (d) => (d.report.bytes = -1),
      (d) =>
        Object.defineProperty(d, "report", {
          get() {
            calls++;
            throw Error("private");
          },
        }),
    ]) {
      const d = structuredClone(valid);
      mutate(d);
      assert.throws(() => validateFailureEvidence(d, context, f.request.expected));
    }
    assert.equal(calls, 0);
  } finally {
    f.dispose();
  }
});

test("FEP actual first stage writer and stdout share closed projection; sentinel private positive/public negative", async () => {
  const f = failureFixture();
  try {
    const sentinel = "PRIVATE_FEP_SENTINEL_0394e1";
    f.report.config.private = sentinel;
    f.report.errors = [{ message: sentinel }];
    f.report.suites[0].specs[0].tests[0].results[0].error = { message: sentinel };
    const result = await failedProduction(f, () => {
      writeFileSync(f.request.context.reportPath, JSON.stringify(f.report));
      return {
        status: 1,
        signal: null,
        closed: true,
        error: new Error(sentinel),
        stdout: sentinel,
        stderr: sentinel,
      };
    });
    assert.ok(
      readFileSync(path.join(f.request.owner.output, "stdout.txt"), "utf8").includes(sentinel),
    );
    assert.ok(readFileSync(f.request.context.reportPath, "utf8").includes(sentinel));
    const metadata = {
      selection: {
        stage: "product",
        selectionHash: f.options.selectionHash,
        phases: [f.request.phase, phases[2]],
      },
      manifestHash: "c".repeat(64),
      lockHash: "d".repeat(64),
      invocation: "fixed",
      environment: { platform: "fixture" },
    };
    const target = path.join(f.request.owner.output, "execution.json"),
      lines = [];
    assert.equal(
      writeStageExecution(target, metadata, result, { output: (l) => lines.push(l) }),
      1,
    );
    const written = JSON.parse(readFileSync(target)),
      summary = JSON.parse(lines[0]);
    assert.deepEqual(written.results, summary.results);
    assert.equal(written.exitCode, 1);
    assert.ok(!JSON.stringify(written).includes(sentinel));
    assert.ok(!lines[0].includes(sentinel));
    const source = readFileSync(new URL("./ci-e2e.mjs", import.meta.url), "utf8");
    assert.match(
      source,
      /process\.exitCode = writeStageExecution\(\s*path\.join\(outputBase, stage, `execution-/,
    );
    assert.doesNotMatch(source, /json\(\s*path\.join\(outputBase, stage, `execution-/);
    for (const mutate of [
      (row) => (row.failureEvidence.report.extra = sentinel),
      (row) =>
        Object.defineProperty(row, "failureEvidence", {
          get() {
            throw Error(sentinel);
          },
        }),
      (row) => (row.failureEvidence.context.stage = "m0"),
    ]) {
      const f2 = await runPhaseSeries(
        [f.request.phase],
        () => {
          throw Error(sentinel);
        },
        f.options,
      );
      mutate(f2.results[0]);
      let payload, line;
      writeStageExecution(target, metadata, f2, {
        write: (_p, v) => (payload = v),
        output: (v) => (line = v),
      });
      assert.deepEqual(payload.results, JSON.parse(line).results);
      assert.equal(payload.results[0].failureEvidence.failureAt, "diagnosis");
      assert.ok(!JSON.stringify(payload).includes(sentinel));
    }
    const success = {
      results: [
        {
          phase: f.request.phase.name,
          status: "passed",
          failureEvidence: canonicalFailure(
            failureContext("product", f.request.phase.name, f.options.selectionHash),
          ),
        },
      ],
      exitCode: 0,
    };
    let payload;
    assert.equal(
      writeStageExecution(target, metadata, success, {
        write: (_p, v) => (payload = v),
        output() {},
      }),
      1,
    );
    assert.equal(payload.results[0].error, "OPERATION_FAILED");
    assert.equal(payload.results[0].status, "failed");
  } finally {
    f.dispose();
  }
});

test("FEP descriptor values are consumed once: proxy get hooks cannot run after validation", () => {
  const f = failureFixture();
  try {
    const context = {
      ...failureContext("product", f.request.phase.name, f.options.selectionHash),
      sha: f.request.context.sha,
      phaseRun: f.request.owner.run,
    };
    const valid = {
      context,
      failureAt: "launcher",
      launcher: { status: 1, signal: "none", closed: true, errorKind: "none" },
      ...decodeFixture(f),
    };
    let calls = 0;
    const proxy = (value) =>
      new Proxy(value, {
        get() {
          calls++;
          throw Error("private getter trap");
        },
      });
    valid.context = proxy(valid.context);
    valid.launcher = proxy(valid.launcher);
    valid.report = proxy(valid.report);
    valid.cases[0] = proxy(valid.cases[0]);
    const projected = validateFailureEvidence(proxy(valid), context, f.request.expected);
    assert.equal(projected.context.sha, context.sha);
    assert.equal(projected.cases[0].observed, "passed");
    assert.equal(calls, 0);
  } finally {
    f.dispose();
  }
});
