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
      if (spawnFailure) throw new Error("synthetic spawn failure");
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
    launch: (options, onSpawn) => launch("synthetic", [], { detached, ...options }, onSpawn),
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

test("workflow executes new tests/real checks once while preserving legacy gate order", () => {
  const yaml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const legacy = [
    "pnpm install --frozen-lockfile",
    "pnpm codegen",
    "git diff --exit-code apps/web/lib/api-types.ts",
    "pnpm typecheck",
    "node --test scripts/ci-e2e.test.mjs",
    "pnpm lint",
    "pnpm format:check",
    "pnpm build",
    "pnpm --filter web verify:no-test-seed",
    "pnpm --filter web verify:contrast",
    "pnpm --filter web verify:font-payload",
    "pnpm test",
    "npx playwright install --with-deps chromium webkit",
    "xvfb-run --auto-servernum node scripts/ci-e2e.mjs",
  ];
  let cursor = -1;
  for (const command of legacy) {
    const i = yaml.indexOf(`- run: ${command}`, cursor + 1);
    assert.ok(i > cursor, command);
    cursor = i;
  }
  for (const command of [
    "pnpm ci:bootstrap",
    "node scripts/rebuild-fixtures.mjs",
    "pnpm exec tsc -p scripts/tsconfig.rebuild-api-types.json --noEmit",
    "node --test scripts/rebuild-bootstrap.test.mjs scripts/rebuild-fixtures.test.mjs",
    "node scripts/ci-e2e.manifest.mjs --stage product",
    "node --test scripts/ci-e2e.test.mjs scripts/ci-e2e.manifest.test.mjs",
  ])
    assert.ok(yaml.includes(`- run: ${command}`), command);
  assert.equal((yaml.match(/- run: pnpm install/g) ?? []).length, 1);
  assert.doesNotMatch(yaml, /continue-on-error|ci:m0|ci:product|ci-m0\.mjs|passWithNoTests/);
  assert.equal((yaml.match(/- if: failure\(\)/g) ?? []).length, 0);
  assert.ok(yaml.includes("- if: always()"));
  assert.ok(yaml.includes("apps/web/e2e/.artifacts-ci/m0/*.json"));
  assert.ok(yaml.includes("apps/web/e2e/.artifacts-ci/product/*.json"));
  assert.doesNotMatch(yaml, /path: apps\/web\/C:|\.artifacts\s*$|\.report\s*$/m);
  const m0 = yaml.indexOf("xvfb-run --auto-servernum node scripts/ci-e2e.mjs --stage m0");
  assert.ok(
    m0 > 0 &&
      yaml.indexOf("xvfb-run --auto-servernum node scripts/ci-e2e.mjs --stage product") > m0,
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
