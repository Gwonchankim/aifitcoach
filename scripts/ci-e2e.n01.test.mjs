import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  REGISTRY,
  INVOCATION,
  emptyCase,
  validateSummary,
  completeSummary,
  publishN01Summary,
  classifyRed,
  probePassed,
  PROBE_SOURCE,
  BROWSER_SOURCE,
  runWrongBuild,
  runProbe,
} from "./ci-e2e.n01.mjs";
import { inspectBytes, inspectTrace, playwrightUtils, privateLaunch } from "./ci-e2e.mjs";
import { makeProfile } from "./ci-e2e.manifest.mjs";
const { structuredClone, queueMicrotask } = globalThis;

const expected = ["wrong-rewrite", "wrong-base", "occupied-port", "abort", "timeout"];
function validSummary() {
  return {
    run: "11111111-1111-4111-8111-111111111111",
    sha: "a".repeat(40),
    invocation: INVOCATION,
    cases: expected.map((name) => {
      const row = emptyCase(name);
      row.status = "passed";
      row.inspection.stdout = inspectBytes("").inspection;
      row.inspection.stderr = inspectBytes("").inspection;
      if (name.startsWith("wrong-")) {
        row.redKind = "request-failed";
        row.restoredGreen = true;
      }
      if (name === "wrong-rewrite")
        row.inspection.trace = {
          state: "inspected",
          inputDigest: "b".repeat(64),
          inputBytes: 100,
          bytesInspected: 40,
          entryCount: 1,
        };
      return row;
    }),
  };
}
test("N01 fixed registry, strict producer/reparse and incomplete results cannot borrow old safe files", () => {
  assert.deepEqual(REGISTRY, expected);
  const good = validSummary();
  assert.equal(completeSummary(good), true);
  for (const change of [
    (v) => {
      v.cases = [];
    },
    (v) => {
      v.cases.pop();
    },
    (v) => {
      v.cases[4] = v.cases[0];
    },
    (v) => {
      v.env = "secret";
    },
    (v) => {
      v.cases[0].url = "private";
    },
    (v) => {
      v.cases[0].restoredGreen = false;
    },
    (v) => {
      v.cases[0].inspection.trace.state = "error";
    },
    (v) => {
      v.cases[1].redKind = "http-error";
      v.cases[1].httpStatus = 502;
    },
  ]) {
    const value = structuredClone(good);
    change(value);
    assert.throws(() => validateSummary(value));
  }
  const dir = mkdtempSync(path.join(tmpdir(), "afc-n01-summary-"));
  try {
    writeFileSync(path.join(dir, "old-product-safe.json"), "{}");
    const notRun = structuredClone(good);
    notRun.cases[4] = emptyCase("timeout");
    assert.equal(publishN01Summary(notRun, dir), 1);
    assert.equal(
      completeSummary(
        JSON.parse(readFileSync(path.join(dir, `n01-summary-${good.run}.json`), "utf8")),
      ),
      false,
    );
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + path.sep));
    rmSync(dir, { recursive: true });
  }
});
test("N01 RED classifier rejects setup/no-route/200 and records only exact failure kind/status", () => {
  const url = "http://localhost:4100/api/v1/me",
    requests = [{ url, method: "GET" }];
  assert.deepEqual(
    classifyRed("wrong-rewrite", { requests, responses: [{ url, status: 502 }], failed: [] }, url),
    { redKind: "http-error", httpStatus: 502 },
  );
  assert.deepEqual(classifyRed("wrong-base", { requests, responses: [], failed: [url] }, url), {
    redKind: "request-failed",
    httpStatus: null,
  });
  for (const data of [
    null,
    { responses: [], failed: [] },
    { responses: [{ url: url + "/other", status: 502 }], failed: [] },
    { responses: [{ url, status: 200 }], failed: [url] },
  ])
    assert.equal(classifyRed("wrong-rewrite", data, url), null);
});
test("N01 probe proof requires early PID, ACK-before-ready, native timeout and per-resource state", () => {
  const evidence = {
    pid: 23,
    grandchildPid: 24,
    spawnAt: 0,
    readyAt: 1000,
    completedAt: 7000,
    ack: true,
    closed: true,
    readyFileAbsent: true,
    groupAbsent: true,
    pidAbsent: true,
    grandchildAbsent: true,
    port: "notAllocated",
    profile: "notAllocated",
    container: "notAllocated",
    timeout: 5000,
    errorCode: "ETIMEDOUT",
    abortReasonPreserved: true,
  };
  assert.equal(probePassed("timeout", evidence), true);
  assert.equal(probePassed("abort", evidence), true);
  for (const changed of [
    { pid: undefined },
    { ack: false },
    { readyAt: 2100 },
    { readyAt: 8000 },
    { timeout: 500 },
    { completedAt: 4000 },
    { container: true },
    { groupAbsent: false },
    { grandchildAbsent: false },
    { closed: false },
  ])
    assert.equal(probePassed("timeout", { ...evidence, ...changed }), false);
  assert.match(PROBE_SOURCE, /\['ignore','inherit','inherit','pipe'\]/);
  assert.match(PROBE_SOURCE, /grand\.stdio\[3\]/);
});
test("N01 actual inflated ZIP and JSON inspectors see private sentinels, partial/error never inspected", async () => {
  const sentinel = 'N01_PRIVATE_"\\\n_SENTINEL';
  assert.equal(inspectBytes(JSON.stringify({ env: { sentinel } }), [sentinel]).detected, true);
  const zip = new (playwrightUtils().yazl.ZipFile)();
  const chunks = [];
  const bytes = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (b) => chunks.push(b));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.addBuffer(Buffer.from(sentinel), "trace.trace");
  zip.end();
  const input = await bytes;
  const checked = await inspectTrace(input, [sentinel]);
  assert.equal(checked.inspection.state, "inspected");
  assert.equal(checked.detected, true);
  assert.equal(checked.inspection.inputBytes, input.length);
  assert.equal(checked.inspection.bytesInspected, Buffer.byteLength(sentinel));
  assert.equal(checked.inspection.entryCount, 1);
  const broken = await inspectTrace(Buffer.from("not a zip"), [sentinel]);
  assert.equal(broken.inspection.state, "error");
});
test("N01 actual Node sink stays private through inspector and strict safe producer", async () => {
  const sentinel = "N01_ACTUAL_PRIVATE_SINK_991ff";
  const result = await privateLaunch(
    process.execPath,
    [
      "-e",
      "process.stdout.write(process.env.AFC_N01_SENTINEL);process.stderr.write(process.env.AFC_N01_SENTINEL)",
    ],
    {
      env: { ...process.env, AFC_N01_SENTINEL: sentinel },
      stdio: "pipe",
      shell: false,
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0);
  assert.equal(inspectBytes(result.stdout, [sentinel]).detected, true);
  assert.equal(inspectBytes(result.stderr, [sentinel]).detected, true);
  const summary = validSummary();
  summary.cases[3].inspection.stdout = inspectBytes(result.stdout, [sentinel]).inspection;
  summary.cases[3].inspection.stderr = inspectBytes(result.stderr, [sentinel]).inspection;
  assert.equal(completeSummary(summary), true);
  assert.ok(!JSON.stringify(summary).includes(sentinel));
});

test("N01 actual public child streams and written safe/proof exclude both private probe sinks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "afc-n01-public-")),
    sentinel = "N01_PUBLIC_NEGATIVE_c7b9f1";
  try {
    const runner = pathToFileURL(path.resolve("scripts/ci-e2e.mjs")).href,
      n01 = pathToFileURL(path.resolve("scripts/ci-e2e.n01.mjs")).href;
    const program = `import {privateLaunch,inspectBytes} from ${JSON.stringify(runner)};import {publishN01Summary} from ${JSON.stringify(n01)};import {writeFileSync} from 'node:fs';
 const result=await privateLaunch(process.execPath,['-e','process.stdout.write(process.env.AFC_N01_SENTINEL);process.stderr.write(process.env.AFC_N01_SENTINEL)'],{env:process.env,stdio:'pipe',timeout:5000});
 if(result.status!==0)throw new Error('probe failed');const stdout=inspectBytes(result.stdout,[process.env.AFC_N01_SENTINEL]),stderr=inspectBytes(result.stderr,[process.env.AFC_N01_SENTINEL]);
 const summary=${JSON.stringify(validSummary())};summary.cases[3].inspection.stdout=stdout.inspection;summary.cases[3].inspection.stderr=stderr.inspection;
 const proof={stdout:stdout.inspection,stderr:stderr.inspection};writeFileSync(${JSON.stringify(path.join(dir, "private-positive.json"))},JSON.stringify({stdout:stdout.detected,stderr:stderr.detected}),{flag:'wx'});
 writeFileSync(${JSON.stringify(path.join(dir, "proof.json"))},JSON.stringify(proof),{flag:'wx'});process.exitCode=publishN01Summary(summary,${JSON.stringify(dir)});console.log(JSON.stringify({summary,proof}));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env: { ...process.env, AFC_N01_SENTINEL: sentinel },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    assert.ok(!child.stdout.includes(sentinel));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "private-positive.json"), "utf8")), {
      stdout: true,
      stderr: true,
    });
    for (const file of [`n01-summary-${validSummary().run}.json`, "proof.json"])
      assert.ok(!readFileSync(path.join(dir, file), "utf8").includes(sentinel));
    assert.equal(completeSummary(JSON.parse(child.stdout).summary), true);
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + path.sep));
    rmSync(dir, { recursive: true });
  }
});
test("N01 CLI rejects every argument and unsupported runtime before resources; import has no side effects", () => {
  const file = path.resolve("scripts/ci-e2e.n01.mjs"),
    dir = mkdtempSync(path.join(tmpdir(), "afc-n01-cli-"));
  try {
    const before = readdirSync(dir);
    const imported = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)})`],
      { env: { ...process.env, TMP: dir, TEMP: dir }, encoding: "utf8" },
    );
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout + imported.stderr, "");
    assert.deepEqual(readdirSync(dir), before);
    for (const args of [[], ["--stage", "m0"], ["--case", "abort"]]) {
      const result = spawnSync(process.execPath, [file, ...args], {
        env: { ...process.env, GITHUB_ACTIONS: "false", TMP: dir, TEMP: dir },
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^(UNKNOWN_STAGE|UNSUPPORTED_RUNNER)\s*$/);
      assert.equal(result.stdout, "");
      assert.deepEqual(readdirSync(dir), before);
    }
  } finally {
    assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + path.sep));
    rmSync(dir, { recursive: true });
  }
});

test("N01 real wrong-build orchestrator models wrong build, request RED and exact rebuild GREEN independently", async () => {
  const browserChildStatuses = [];
  for (const name of ["wrong-rewrite", "wrong-base"]) {
    for (const fault of [
      null,
      "wrong-build",
      "red-missing",
      "green-id",
      "trace",
      "cleanup",
      "validate",
      "browser-child",
    ]) {
      const dir = mkdtempSync(path.join(tmpdir(), "afc-n01-g1-model-"));
      const handle = {
        owner: {
          profile: makeProfile(name === "wrong-rewrite" ? "proxy" : "direct", 41201, 41202),
          dbPort: 45555,
          e2eUser: "owned-principal",
        },
        context: { launchCount: 0 },
        env: {
          DATABASE_URL: "postgresql://postgres:synthetic@127.0.0.1:45555/owned_e2e",
          FIELD_ENCRYPTION_KEY: "synthetic",
          AFC_TEST_TODAY: "must-unset",
        },
      };
      const calls = [];
      let releases = 0,
        builds = 0,
        observation;
      const io = {
        results: [{ stdout: Buffer.from("private"), stderr: Buffer.from("") }],
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (args[0] === "build") {
            builds++;
            if (fault === "wrong-build" && builds === 1) throw new Error("synthetic build failed");
          }
          if (args[0] === "-e") {
            assert.equal(args[1], BROWSER_SOURCE);
            const setting = JSON.parse(options.env.AFC_N01_BROWSER);
            if (fault === "browser-child" && !setting.green)
              throw Object.assign(new Error("synthetic browser child failed"), {
                code: "CHILD_FAILED",
              });
            observation = {
              requests: [{ url: setting.expected, method: "GET" }],
              responses: setting.green
                ? [
                    {
                      url: setting.expected,
                      method: "GET",
                      status: 200,
                      id: fault === "green-id" ? "foreign" : setting.user,
                    },
                  ]
                : name === "wrong-rewrite" && fault !== "red-missing"
                  ? [{ url: setting.expected, method: "GET", status: 502 }]
                  : [],
              failed:
                !setting.green && name === "wrong-base" && fault !== "red-missing"
                  ? [setting.expected]
                  : [],
            };
          }
        },
        start(command, args, options) {
          calls.push({ command, args, options });
          if (args.includes("api")) assert.equal(options.env.AFC_TEST_TODAY, undefined);
          return {};
        },
        async close() {
          calls.push({ close: true });
        },
        async cleanup() {
          calls.push({ cleanup: true });
        },
      };
      try {
        const row = await runWrongBuild(
          name,
          { directory: dir, sentinel: "secret" },
          {
            allocate: async (input) => {
              assert.equal(input.mode, name === "wrong-rewrite" ? "proxy" : "direct");
              return handle;
            },
            validate() {
              if (fault === "validate") throw new Error("bad owner");
            },
            release: async () => {
              releases++;
              if (fault === "cleanup") throw new Error("unconfirmed");
            },
            io: () => io,
            waitReady: async () => {},
            freePort: async () => 49999,
            readObservation: () => observation,
            inspectTrace: async () => ({
              inspection:
                fault === "trace"
                  ? {
                      state: "error",
                      inputDigest: null,
                      inputBytes: null,
                      bytesInspected: null,
                      entryCount: null,
                    }
                  : {
                      state: "inspected",
                      inputDigest: "a".repeat(64),
                      inputBytes: 100,
                      bytesInspected: 10,
                      entryCount: 1,
                    },
            }),
          },
        );
        assert.equal(releases, 1);
        const passing = fault === null || (fault === "trace" && name === "wrong-base");
        if (fault === "browser-child") {
          browserChildStatuses.push([name, row.status]);
          assert.equal(row.redKind, null);
          assert.equal(row.httpStatus, null);
          assert.deepEqual(row.codes, ["CHILD_FAILED"]);
          assert.equal(row.restoredGreen, true);
        } else
          assert.equal(
            row.status,
            passing
              ? "passed"
              : ["wrong-build", "validate"].includes(fault)
                ? "setup-failed"
                : "failed",
            `${name}/${fault}`,
          );
        if (fault !== "validate") {
          assert.equal(builds, 2, "even a failed wrong build requires an attempted exact rebuild");
          const buildCalls = calls.filter((c) => c.args?.[0] === "build");
          assert.equal(
            buildCalls[0].options.env[
              name === "wrong-rewrite" ? "API_PROXY_ORIGIN" : "NEXT_PUBLIC_API_BASE_URL"
            ],
            name === "wrong-rewrite" ? "http://127.0.0.1:49999" : "http://localhost:49999/v1",
          );
          assert.equal(
            buildCalls[1].options.env.NEXT_PUBLIC_API_BASE_URL,
            handle.owner.profile.apiBase,
          );
          assert.equal(
            buildCalls[1].options.env.API_PROXY_ORIGIN,
            handle.owner.profile.proxyOrigin,
          );
          if (fault === "red-missing") assert.equal(row.restoredGreen, true);
          if (fault === "green-id") assert.equal(row.restoredGreen, false);
        }
      } finally {
        rmSync(dir, { recursive: true });
      }
    }
  }
  assert.deepEqual(browserChildStatuses, [
    ["wrong-rewrite", "setup-failed"],
    ["wrong-base", "setup-failed"],
  ]);
});

test("N01 real probe orchestrator rejects pre-ACK/late ready, preserves native timeout and cleanup failure", async () => {
  for (const mode of ["abort", "timeout", "no-ack", "late", "cleanup"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "afc-n01-g2-model-"));
    let now = 0,
      finish,
      optionsValue,
      readyFile;
    let closes = 0;
    try {
      const row = await runProbe(
        mode === "timeout" ? "timeout" : "abort",
        { directory: dir, sentinel: "private" },
        {
          now: () => now,
          launch(_c, args, options, onSpawn) {
            optionsValue = options;
            readyFile = args[2];
            assert.equal(options.timeout, 5000);
            assert.equal(args[1], PROBE_SOURCE);
            onSpawn(22222);
            if (!["no-ack", "late"].includes(mode)) {
              writeFileSync(readyFile, JSON.stringify({ pid: 22222, grandchildPid: 22223 }));
              now = 100;
            }
            return new Promise((resolve) => {
              finish = () => {
                now++;
                resolve({
                  pid: 22222,
                  closed: true,
                  status: null,
                  stdout: Buffer.from("private"),
                  stderr: Buffer.from("private"),
                  error: options.signal.aborted
                    ? options.signal.reason
                    : Object.assign(new Error("native"), { code: "ETIMEDOUT" }),
                });
              };
              options.signal.addEventListener("abort", finish, { once: true });
              if (mode === "timeout")
                queueMicrotask(() => {
                  now = 7000;
                  finish();
                });
            });
          },
          delay: async () => {
            now += 1000;
            if (mode === "late" && now === 3000)
              writeFileSync(readyFile, JSON.stringify({ pid: 22222, grandchildPid: 22223 }));
          },
          closeGroup: async (pid) => {
            assert.equal(pid, 22222);
            closes++;
            if (mode === "cleanup") throw new Error("EPERM");
          },
          absent: () => mode !== "cleanup",
        },
      );
      assert.equal(optionsValue.timeout, 5000);
      assert.equal(closes, 1);
      assert.equal(
        row.status,
        ["abort", "timeout"].includes(mode)
          ? "passed"
          : ["no-ack", "late"].includes(mode)
            ? "setup-failed"
            : "failed",
      );
      if (mode === "cleanup") assert.deepEqual(row.codes, ["CHILD_FAILED", "CLEANUP_FAILED"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test("N01 ZIP partial streams and close errors cannot become inspected", async () => {
  for (const fault of ["partial", "close"]) {
    const checked = await inspectTrace(Buffer.from("synthetic-zip"), [], {
      open(_b, callback) {
        const zip = new EventEmitter();
        zip.isOpen = true;
        zip.close = () => {
          if (fault === "close") throw new Error("close");
          zip.isOpen = false;
        };
        let step = 0;
        zip.readEntry = () =>
          queueMicrotask(() => {
            if (step++ === 0) zip.emit("entry", { uncompressedSize: 4 });
            else zip.emit("end");
          });
        zip.openReadStream = (_entry, cb) => {
          const stream = Readable.from([Buffer.from(fault === "partial" ? "bad" : "good")]);
          cb(null, stream);
        };
        callback(null, zip);
      },
    });
    assert.equal(checked.inspection.state, "error");
    assert.ok(checked.inspection.inputBytes > 0);
  }
});
