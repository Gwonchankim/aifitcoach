/**
 * ci-m0 root 명령 본체의 반례 — 실제 export(main·runGates·runOwnedTest·summarize·ownedTestProblems 등)와 실제 CLI 를
 * 소비한다. docker·DB·전체 gate 는 실행하지 않는다(전체 실행은 GitHub disposable Linux/Node20/Xvfb 의 몫이다).
 * 실제 CLI 를 띄우는 시험은 GITHUB_ACTIONS=false 를 명시해 runner guard 가 먼저 거부하게 한다 — 지원 환경의
 * `pnpm ci:m0` 안(필수 node gate)에서 이 파일이 돌아도 ci:m0 를 재귀 실행하지 않는다. in-process main 이 guard 를
 * 통과하는 시험은 전부 합성 launcher 만 쓴다(실제 child 0).
 *
 *   node --test scripts/ci-m0.test.mjs
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { closeOwnedGroup, phases as runnerPhases, privateLaunch } from "./ci-e2e.mjs";
// fix-01 에서 생긴 export 는 namespace 로만 쓴다 — 이 시험 파일이 수정 전 본체에도 import 되어 원인별 RED 를 보이게.
import * as ciM0 from "./ci-m0.mjs";
import {
  CODEGEN_OUTPUT,
  CODES,
  GATE_IDS,
  OWNER,
  PURPOSE,
  SELF_TEST,
  TEST_TODAY,
  TIMEOUTS,
  checkInstall,
  checkRunner,
  gatesFor,
  main,
  ownedTestEnv,
  ownedTestProblems,
  parseArgs,
  privateSink,
  rootCode,
  runGates,
  runOwnedTest,
  summarize,
} from "./ci-m0.mjs";
const { AbortController } = globalThis;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = fileURLToPath(new URL("./ci-m0.mjs", import.meta.url));
const NODE = process.execPath;
const TEMP_PREFIX = "afc-ci-m0-test-";

/** 본체 목록을 빌리지 않고 여기서 따로 고정한 필수 node 시험 — 자체 시험(ci-m0.test.mjs)이 빠지면 RED 다. */
const MANDATORY_NODE_TESTS = [
  "scripts/rebuild-bootstrap.test.mjs",
  "scripts/rebuild-fixtures.test.mjs",
  "scripts/ci-e2e.test.mjs",
  "scripts/ci-e2e.manifest.test.mjs",
  "scripts/ci-m0.test.mjs",
];
/** tech §11 공통 gate 순서 — 기존 workflow 개별 step 과 1:1 인 실제 child 명령(codegen-drift 는 git 2회). */
const COMMON_LAUNCHES = [
  ["bootstrap", NODE, ["scripts/rebuild-bootstrap.mjs"]],
  ["fixtures", NODE, ["scripts/rebuild-fixtures.mjs"]],
  [
    "api-types",
    "pnpm",
    ["exec", "tsc", "-p", "scripts/tsconfig.rebuild-api-types.json", "--noEmit"],
  ],
  ["codegen", "pnpm", ["codegen"]],
  ["codegen-drift", "git", ["ls-files", "--error-unmatch", "--", "apps/web/lib/api-types.ts"]],
  ["codegen-drift", "git", ["diff", "--exit-code", "--", "apps/web/lib/api-types.ts"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["node-tests", NODE, ["--test", ...MANDATORY_NODE_TESTS]],
  ["discovery-product", NODE, ["scripts/ci-e2e.manifest.mjs", "--stage", "product"]],
  ["discovery-m0", NODE, ["scripts/ci-e2e.manifest.mjs", "--stage", "m0"]],
  ["lint", "pnpm", ["lint"]],
  ["format", "pnpm", ["format:check"]],
  ["build", "pnpm", ["build"]],
  ["verify-no-test-seed", "pnpm", ["--filter", "web", "verify:no-test-seed"]],
  ["verify-contrast", "pnpm", ["--filter", "web", "verify:contrast"]],
  ["verify-font-payload", "pnpm", ["--filter", "web", "verify:font-payload"]],
];
const EXPECTED_GATE_IDS = [
  ...new Set(COMMON_LAUNCHES.map(([id]) => id)),
  "owned-test",
  "owned-e2e",
];
/** 기존 workflow 의 service DB 와 개발 DB(고정 개발값 — 비밀이 아니다). 둘 다 owned `_test` 대상이 될 수 없다. */
const SERVICE_URL = "postgresql://postgres:postgres@localhost:5432/afc_test";
const DEV_URL = "postgresql://postgres:postgres@localhost:5432/afc";

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

/** install 흔적·생성물만 갖춘 합성 checkout(.env 없음) — 합성 launcher 시험의 root. */
function syntheticRoot(t) {
  const root = tempDir(t);
  for (const dir of [
    "node_modules",
    "apps/api/node_modules",
    "apps/web/node_modules",
    "packages/shared/node_modules",
    "apps/web/lib",
  ])
    mkdirSync(path.join(root, ...dir.split("/")), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".modules.yaml"), "layoutVersion: 5\n");
  writeFileSync(path.join(root, ...CODEGEN_OUTPUT.split("/")), "export interface paths {}\n");
  return root;
}

const ok = (stdout = "") => ({
  status: 0,
  signal: null,
  closed: true,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
});
const exited = (status) => ({ ...ok(), status });
const noDelay = async () => {};

/** runner(ci-e2e runPhase)가 phase finally 뒤에 쓰는 safe phase JSON 과 같은 모양(합성). change 로 한 가지씩 바꾼다. */
function phaseRecord(stage, phase, change = {}) {
  return {
    phase,
    run: randomUUID(),
    stage,
    profile: { mode: "direct", apiPort: 41001, webPort: 41002 },
    containerId: "cd".repeat(32),
    database: "afc_gen_s03_ci_0123abcd_e2e",
    principal: randomUUID(),
    owner: "automation-m0-06",
    purpose: "owned-e2e",
    childPid: 7100,
    status: "passed",
    execution: { required: 1 },
    cleanup: {
      processGroupAbsent: true,
      forced: false,
      exactContainerAbsent: true,
      physicalProfileAbsent: true,
      portsAbsent: true,
    },
    finishedAt: new Date().toISOString(),
    ...change,
  };
}
const phaseDir = (root, stage) => path.join(root, "apps", "web", "e2e", ".artifacts-ci", stage);
/** runner 처럼 `<stage>/<phase>-<run>.json` 에 wx 로 쓴다. dirStage 는 본문 stage 와 다른 귀속을 만들 때만 준다. */
function writePhase(root, record, dirStage = record.stage) {
  mkdirSync(phaseDir(root, dirStage), { recursive: true });
  const name = `${record.phase}-${record.run}.json`;
  writeFileSync(path.join(phaseDir(root, dirStage), name), JSON.stringify(record, null, 2), {
    flag: "wx",
  });
  return name;
}
/** 이번 stage 의 기대 phase — 실제 manifest(이 checkout)와 runner phase 순서. */
const realPhases = (stage) => ciM0.expectedPhases(ROOT, stage);
const childStream = () => Object.assign(new EventEmitter(), { destroy() {} });

/**
 * 합성 launcher — docker·pnpm·git·node·xvfb-run 호출을 기록만 하고 실제 child 를 만들지 않는다.
 * detached 호출에는 합성 PID 를 주고, closeGroup 은 그 PID 의 부재 확인 호출을 기록한다.
 * docker 는 run/exec/inspect/ps/rm 을 상태로 흉내 낸다. override(command, args) 가 결과를 주면 그것을 쓴다.
 * owned-e2e runner 는 전용 경계가 spawnRunner 로 직접 만든다 — 기대 phase 마다 유효 safe 파일을 쓰고 정상 종료한다.
 */
function fakeLauncher({ override = () => undefined, inspect = (info) => info, runTimesOut } = {}) {
  const calls = [];
  const spawned = [];
  const closed = [];
  const signals = [];
  const container = { id: "ab".repeat(32), created: null, removed: false };
  const field = (prefix) =>
    container.created?.env.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  const describe = () => ({
    Id: container.id,
    Name: `/${container.created.name}`,
    Config: {
      Image: "postgres:16",
      Labels: { ...container.created.labels },
      Env: [...container.created.env],
    },
    State: { Running: true },
    HostConfig: { Tmpfs: { "/var/lib/postgresql/data": "" } },
    Mounts: [],
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } },
  });
  const docker = (args) => {
    const [verb] = args;
    if (verb === "run") {
      const created = { name: undefined, labels: {}, env: [] };
      for (let i = 1; i < args.length; i += 1) {
        if (args[i] === "--name") {
          i += 1;
          created.name = args[i];
        } else if (args[i] === "--label") {
          i += 1;
          const [key, value] = args[i].split(/=(.*)/s);
          created.labels[key] = value;
        } else if (args[i] === "-e") {
          i += 1;
          created.env.push(args[i]);
        }
      }
      container.created = created;
      if (runTimesOut)
        return {
          status: null,
          error: Object.assign(new Error("synthetic docker timeout"), { code: "ETIMEDOUT" }),
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      return ok(`${container.id}\n`);
    }
    if (verb === "exec") return ok(args.includes("psql") ? `${field("POSTGRES_DB=")}\n` : "");
    if (verb === "inspect") return ok(JSON.stringify([inspect(describe())]));
    if (verb === "ps")
      return ok(container.created && !container.removed ? `${container.id}\n` : "");
    if (verb === "rm") {
      container.removed = true;
      return ok();
    }
    return exited(1);
  };
  const launch = async (command, args, options, onSpawn) => {
    calls.push({ command, args: [...args], options });
    if (options.detached) {
      const pid = 4000 + calls.length;
      spawned.push(pid);
      onSpawn(pid);
    }
    return override(command, args, options) ?? (command === "docker" ? docker(args) : ok());
  };
  const closeGroup = async (pid) => {
    closed.push(pid);
    return { processGroupAbsent: true };
  };
  const spawnRunner = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const pid = 4000 + calls.length;
    spawned.push(pid);
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout: childStream(),
      stderr: childStream(),
      kill: () => true,
    });
    setImmediate(() => {
      const stage = args.at(-1);
      for (const phase of realPhases(stage)) writePhase(options.cwd, phaseRecord(stage, phase));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  };
  const kill = (target, kind) => {
    signals.push({ target, kind });
    return true;
  };
  return { launch, closeGroup, spawnRunner, kill, calls, spawned, closed, signals, container };
}

/**
 * 실제 privateLaunch — Windows 에서는 OS 수준 detached 만 끈다(같은 본문을 spawn 만 바꿔 실행하므로 소유 PID 등록·
 * 정리 호출은 본체 경로 그대로다). Windows 에는 POSIX PID 그룹이 없고, detached child 가 띄운 하위 console(git
 * launcher·node --test 의 child)이 사용자 화면에 창으로 뜬다. 그래서 Windows 의 그룹 부재 확인(음수 PID 탐침)은 관측이
 * 아니다 — 그룹 종료 관측은 Linux 의 몫이다. Linux 는 본체 옵션 그대로다.
 */
const realLaunch =
  process.platform === "win32"
    ? runInNewContext(`(${privateLaunch.toString()})`, {
        Buffer,
        coded: (code) => Object.assign(new Error(code), { code }),
        process,
        spawn: (command, args, options) => spawn(command, args, { ...options, detached: false }),
        setTimeout,
        clearTimeout,
      })
    : privateLaunch;

/** guard 를 통과시킨 in-process main — 합성 launcher 만 쓴다. */
async function syntheticMain(t, fake, argv = []) {
  const root = syntheticRoot(t);
  let published;
  const exitCode = await main({
    argv,
    env: { GITHUB_ACTIONS: "true", PATH: "synthetic-path" },
    platform: "linux",
    root,
    launch: fake.launch,
    writePrivate: privateSink(path.join(root, "private")),
    closeGroup: fake.closeGroup,
    delay: noDelay,
    spawn: fake.spawnRunner,
    kill: fake.kill,
    expectedPhases: realPhases,
    output: (line) => {
      published = line;
    },
  });
  return { exitCode, summary: JSON.parse(published), root };
}

test("인자: 없음=m0·`--stage m0|product` 만 허용하고, 부분 실행·skip·임의 인자는 UNKNOWN_ARGUMENT 다", () => {
  assert.deepEqual(parseArgs([]), { stage: "m0" });
  assert.deepEqual(parseArgs(["--stage", "m0"]), { stage: "m0" });
  assert.deepEqual(parseArgs(["--stage", "product"]), { stage: "product" });
  for (const argv of [
    ["--stage"],
    ["--stage=m0"],
    ["--stage=product"],
    ["--stage", "m1"],
    ["--stage", "PRODUCT"],
    ["--stage", "m0", "--stage", "product"],
    ["--stage", "m0", "--skip-db"],
    ["--partial"],
    ["--skip", "owned-test"],
    ["m0"],
    [""],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error) => error.code === "UNKNOWN_ARGUMENT",
      JSON.stringify(argv),
    );
  }
  assert.throws(
    () => gatesFor("partial"),
    (error) => error.code === "UNKNOWN_ARGUMENT",
  );
});

test("공통 gate 는 tech §11 순서의 정확한 명령이고, ci:m0·ci:product 는 마지막 owned 실행의 stage 만 다르다(install 없음)", () => {
  assert.deepEqual([...GATE_IDS], EXPECTED_GATE_IDS);
  assert.equal(GATE_IDS.length, 17);
  const m0 = gatesFor("m0");
  const product = gatesFor("product");
  assert.deepEqual(
    m0.map((gate) => gate.id),
    EXPECTED_GATE_IDS,
  );
  for (const [id, command, args] of COMMON_LAUNCHES.filter(([id]) => id !== "codegen-drift")) {
    const gate = m0.find((candidate) => candidate.id === id);
    assert.equal(gate.command, command, id);
    assert.deepEqual([...gate.args], args, id);
  }
  assert.deepEqual(
    m0.find((gate) => gate.id === "codegen-drift"),
    { id: "codegen-drift", codegen: "apps/web/lib/api-types.ts" },
  );
  assert.deepEqual(
    m0.find((gate) => gate.id === "owned-test"),
    { id: "owned-test", ownedTest: true },
  );
  const e2e = (gates) => gates.find((gate) => gate.id === "owned-e2e");
  assert.equal(e2e(m0).command, "xvfb-run");
  assert.deepEqual(
    [...e2e(m0).args],
    ["--auto-servernum", NODE, "scripts/ci-e2e.mjs", "--stage", "m0"],
  );
  assert.deepEqual(
    [...e2e(product).args],
    ["--auto-servernum", NODE, "scripts/ci-e2e.mjs", "--stage", "product"],
  );
  // 두 명령의 차이는 마지막 owned 실행의 stage 인자 하나뿐이다.
  assert.deepEqual(m0.slice(0, -1), product.slice(0, -1));
  assert.deepEqual(
    { ...e2e(m0), args: e2e(m0).args.slice(0, -1) },
    { ...e2e(product), args: e2e(product).args.slice(0, -1) },
  );
  // install·재귀 root 호출은 어느 gate 에도 없다.
  for (const gate of [...m0, ...product]) {
    const words = [gate.command ?? "", ...(gate.args ?? [])].join(" ");
    assert.doesNotMatch(words, /\binstall\b|ci:m0|ci:product|ci-m0\.mjs/, gate.id);
  }
  assert.ok(Object.isFrozen(m0) && m0.every((gate) => Object.isFrozen(gate)));
  // package.json 은 정확한 두 script 만 이 본체를 부른다.
  const { scripts } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(scripts["ci:m0"], "node scripts/ci-m0.mjs");
  assert.equal(scripts["ci:product"], "node scripts/ci-m0.mjs --stage product");
  assert.deepEqual(
    Object.keys(scripts).filter((name) =>
      /ci-m0|ci:m0|ci:product/.test(`${name} ${scripts[name]}`),
    ),
    ["ci:m0", "ci:product"],
  );
});

test("자체 시험 등록 oracle — 필수 node gate 는 정확히 5파일(ci-m0.test.mjs 포함)을 돌리고, 자체 시험이 빠지거나 실패하면 그 gate 가 RED 다", async (t) => {
  const nodeTests = gatesFor("m0").find((gate) => gate.id === "node-tests");
  assert.equal(nodeTests.command, NODE);
  assert.deepEqual([...nodeTests.args], ["--test", ...MANDATORY_NODE_TESTS]);
  for (const file of MANDATORY_NODE_TESTS) assert.ok(existsSync(path.join(ROOT, file)), file);
  // 자체 시험 경로는 목록과 따로(모듈 위치에서) 구한다 — 목록에서 빠지면 child 없이 TEST_REGISTRATION 이다.
  assert.equal(SELF_TEST, "scripts/ci-m0.test.mjs");
  assert.equal(nodeTests.requires, SELF_TEST);
  const node = GATE_IDS.indexOf("node-tests");
  const launched = [];
  const unregistered = summarize(
    "m0",
    { status: "passed" },
    await runGates(
      [
        { ...nodeTests, args: nodeTests.args.filter((arg) => arg !== SELF_TEST) },
        { id: "discovery-product", command: NODE, args: ["-e", ""] },
      ],
      {
        root: ROOT,
        launch: (command) => {
          launched.push(command);
          return ok();
        },
        writePrivate: () => {},
      },
    ),
  );
  assert.deepEqual(launched, []);
  assert.deepEqual(unregistered.gates[node], {
    id: "node-tests",
    status: "failed",
    failures: [{ boundary: "gate", code: "TEST_REGISTRATION" }],
    cleanup: { processGroupAbsent: true },
  });
  assert.deepEqual(unregistered.gates[node + 1], { id: "discovery-product", status: "not-run" });
  // 같은 명령을 실제 `node --test` child 로 돌린다 — 실패 시험이면 gate RED·후속 not-run, 통과면 GREEN.
  const dir = tempDir(t);
  const failing = path.join(dir, "self-red.test.mjs");
  const passing = path.join(dir, "self-green.test.mjs");
  writeFileSync(
    failing,
    'import { test } from "node:test";\ntest("자체 시험 실패", () => {\n  throw new Error("RED");\n});\n',
  );
  writeFileSync(passing, 'import { test } from "node:test";\ntest("자체 시험 통과", () => {});\n');
  // 부모 test runner 의 child 표지를 넘기지 않는다(중첩 runner 가 보고 형식을 바꾸지 않게).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const next = { id: "discovery-product", command: NODE, args: ["-e", ""] };
  // 합성 파일 1개만 돌린다 — 실제 목록(자체 시험 포함)을 여기서 돌리면 이 시험이 자신을 재귀 실행한다.
  const run = async (file, label) =>
    summarize(
      "m0",
      { status: "passed" },
      await runGates(
        [{ id: "node-tests", command: nodeTests.command, args: ["--test", file] }, next],
        {
          root: dir,
          env,
          launch: realLaunch,
          writePrivate: privateSink(path.join(dir, label)),
        },
      ),
    );
  const red = await run(failing, "red");
  assert.deepEqual(red.gates[node], {
    id: "node-tests",
    status: "failed",
    failures: [{ boundary: "gate", code: "CHILD_FAILED" }],
    cleanup: { processGroupAbsent: true },
  });
  assert.deepEqual(red.gates[node + 1], { id: "discovery-product", status: "not-run" });
  assert.equal(red.exitCode, 1);
  const green = await run(passing, "green");
  assert.equal(green.gates[node].status, "passed");
  assert.equal(green.gates[node + 1].status, "passed");
});

test("gate 실패는 exit 1·실패 gate 식별·후속 not-run 이고, 뒤의 성공·결과 누락이 앞선 실패를 지우지 못한다", async (t) => {
  const fake = fakeLauncher({
    override: (command, args) =>
      command === "pnpm" && args[0] === "typecheck" ? exited(2) : undefined,
  });
  const { exitCode, summary } = await syntheticMain(t, fake);
  assert.equal(exitCode, 1);
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.root, { status: "passed" });
  const index = GATE_IDS.indexOf("typecheck");
  assert.deepEqual(
    summary.gates.slice(0, index).map((gate) => gate.status),
    Array(index).fill("passed"),
  );
  assert.deepEqual(summary.gates[index], {
    id: "typecheck",
    status: "failed",
    failures: [{ boundary: "gate", code: "CHILD_FAILED" }],
    cleanup: { processGroupAbsent: true },
  });
  assert.deepEqual(
    summary.gates.slice(index + 1),
    GATE_IDS.slice(index + 1).map((id) => ({ id, status: "not-run" })),
  );
  // 실패 뒤에는 어떤 child 도 만들지 않는다(마지막 호출이 실패한 typecheck 다).
  assert.deepEqual(fake.calls.at(-1).args, ["typecheck"]);
  assert.equal(
    fake.calls.filter((call) => ["docker", "xvfb-run"].includes(call.command)).length,
    0,
  );

  // 공개 summary 는 고정 17 id 위에서 다시 계산한다.
  const passed = { status: "passed", cleanup: { processGroupAbsent: true } };
  const all = new Map(GATE_IDS.map((id) => [id, passed]));
  assert.equal(summarize("m0", { status: "passed" }, all).exitCode, 0);
  const laterSuccess = new Map(all);
  laterSuccess.set("typecheck", {
    status: "failed",
    failures: [{ boundary: "gate", code: "CHILD_FAILED" }],
  });
  assert.equal(summarize("m0", { status: "passed" }, laterSuccess).exitCode, 1);
  for (const id of GATE_IDS) {
    const missing = new Map(all);
    missing.delete(id);
    const result = summarize("m0", { status: "passed" }, missing);
    assert.equal(result.exitCode, 1, id);
    assert.deepEqual(
      result.gates.find((gate) => gate.id === id),
      { id, status: "not-run" },
    );
  }
  const renamed = new Map(all);
  renamed.delete("owned-e2e");
  renamed.set("skip-all", passed);
  const renamedSummary = summarize("m0", { status: "passed" }, renamed);
  assert.equal(renamedSummary.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(renamedSummary), /skip-all/);
  assert.equal(summarize("m0", { status: "failed", code: "UNSUPPORTED_RUNNER" }, all).exitCode, 1);
  // 결과 객체의 원 오류 code·boundary·상태는 고정 값으로만 공개된다.
  const raw = new Map(all);
  raw.set("build", {
    status: "broken",
    failures: [{ boundary: "stack", code: DEV_URL }],
  });
  assert.deepEqual(
    summarize("m0", { status: "passed" }, raw).gates.find((gate) => gate.id === "build"),
    {
      id: "build",
      status: "failed",
      failures: [{ boundary: "gate", code: "OPERATION_FAILED" }],
      cleanup: { processGroupAbsent: false },
    },
  );
  const hostile = {
    get code() {
      throw new Error(DEV_URL);
    },
  };
  assert.equal(rootCode(hostile), "OPERATION_FAILED");
  assert.equal(rootCode({ code: "ENOENT" }), "OPERATION_FAILED");
  assert.equal(rootCode({ code: "TIMEOUT" }), "TIMEOUT");
});

test("합성 launcher 로 본 전체 순서 — 공통 gate 1회 → owned _test(새 postgres:16) → owned e2e(xvfb), 모든 child 는 pipe·shell 없음·유한 timeout", async (t) => {
  const fake = fakeLauncher();
  const { exitCode, summary, root } = await syntheticMain(t, fake);
  assert.equal(exitCode, 0);
  assert.deepEqual(summary.root, { status: "passed" });
  assert.equal(summary.stage, "m0");
  assert.deepEqual(
    summary.gates.map((gate) => [gate.id, gate.status]),
    GATE_IDS.map((id) => [id, "passed"]),
  );
  assert.deepEqual(summary.gates.find((gate) => gate.id === "owned-test").cleanup, {
    processGroupAbsent: true,
    containerAbsent: true,
  });
  // owned e2e: 정상 close 뒤 기대 phase 전부의 새 safe 파일(정리 4종 true)로 안쪽 정리를 확인했고, 신호는 0 이다.
  assert.deepEqual(summary.gates.find((gate) => gate.id === "owned-e2e").cleanup, {
    processGroupAbsent: true,
    phaseCleanupVerified: true,
  });
  assert.deepEqual(fake.signals, []);
  const { calls } = fake;
  // 공통 gate: 정확한 명령이 정확히 1회씩, 순서대로.
  assert.deepEqual(
    calls.slice(0, COMMON_LAUNCHES.length).map((call) => [call.command, call.args]),
    COMMON_LAUNCHES.map(([, command, args]) => [command, args]),
  );
  // owned _test: docker run → 준비 확인 → inspect → pnpm test → 자기 컨테이너 정리 → 부재 확인.
  assert.deepEqual(
    calls.slice(COMMON_LAUNCHES.length, -1).map((call) => [call.command, call.args[0]]),
    [
      ["docker", "run"],
      ["docker", "exec"],
      ["docker", "exec"],
      ["docker", "inspect"],
      ["pnpm", "test"],
      ["docker", "ps"],
      ["docker", "inspect"],
      ["docker", "rm"],
      ["docker", "ps"],
    ],
  );
  // owned e2e: Xvfb 아래 ci-e2e.mjs --stage m0 가 마지막이다.
  assert.deepEqual(
    [calls.at(-1).command, calls.at(-1).args],
    ["xvfb-run", ["--auto-servernum", NODE, "scripts/ci-e2e.mjs", "--stage", "m0"]],
  );
  for (const call of calls) {
    assert.equal(call.options.stdio, "pipe");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, root);
    // 관리 child 는 docker 를 포함해 전부 detached 소유 그룹이다(QA-01 — docker 만 false 였던 기대를 교정).
    assert.equal(call.options.detached, true, call.command);
    if (call.command === "xvfb-run") {
      // runner 의 시간 상한은 spawn 의 PID-only timeout·signal 이 아니라 전용 경계가 직접 갖는다(QA-02).
      assert.equal(call.options.timeout, undefined);
      assert.equal(call.options.signal, undefined);
    } else assert.ok(Number.isFinite(call.options.timeout) && call.options.timeout > 0);
    assert.doesNotMatch([call.command, ...call.args].join(" "), /\binstall\b/);
  }
  assert.equal(gatesFor("m0").at(-1).timeout, TIMEOUTS.e2e);
  // 소유 PID 그룹(detached child — runner 포함)은 전부 정리에서 부재를 확인했다.
  assert.equal(fake.spawned.length, calls.length);
  assert.deepEqual(
    [...fake.closed].sort((a, b) => a - b),
    [...fake.spawned].sort((a, b) => a - b),
  );
  // ci:product 는 마지막 owned 실행의 stage 만 다르다.
  const productFake = fakeLauncher();
  const product = await syntheticMain(t, productFake, ["--stage", "product"]);
  assert.equal(product.exitCode, 0);
  assert.equal(product.summary.stage, "product");
  const shape = (call) => [call.command, call.args];
  assert.deepEqual(
    productFake.calls.slice(0, COMMON_LAUNCHES.length).map(shape),
    calls.slice(0, COMMON_LAUNCHES.length).map(shape),
  );
  assert.deepEqual(
    productFake.calls.map((call) => [call.command, call.args[0]]),
    calls.map((call) => [call.command, call.args[0]]),
  );
  assert.deepEqual(shape(productFake.calls.at(-1)), [
    "xvfb-run",
    ["--auto-servernum", NODE, "scripts/ci-e2e.mjs", "--stage", "product"],
  ]);
});

test("owned _test — 새 postgres:16·tmpfs·loopback·라벨, child 직전 env 는 같은 URL 하나·명시 날짜·run·synthetic key 뿐이고 정리는 자기 컨테이너만", async (t) => {
  const root = syntheticRoot(t);
  const fake = fakeLauncher();
  const base = {
    PATH: "synthetic-path",
    DATABASE_URL: DEV_URL,
    DEV_USER_ID: "inherited-user",
    E2E_DATABASE_URL: SERVICE_URL,
    NODE_OPTIONS: "--inspect",
    AFC_TEST_TODAY: "2026-01-01",
    PGPASSWORD: "inherited",
    FIELD_ENCRYPTION_KEY: "inherited-key",
  };
  const outcome = await runOwnedTest({
    root,
    env: base,
    launch: fake.launch,
    writePrivate: privateSink(path.join(root, "private")),
    closeGroup: fake.closeGroup,
    delay: noDelay,
  });
  assert.equal(outcome.status, "passed");
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(outcome.cleanup, { processGroupAbsent: true, containerAbsent: true });
  const { target } = outcome;
  assert.match(target.database, /^afc_ci_m0_[0-9a-f]{8}_test$/);
  assert.match(target.container, /^afc-ci-m0-test-[0-9a-f]{8}$/);
  assert.equal(target.database.slice(10, 18), target.container.slice(15));
  assert.equal(target.containerId, fake.container.id);
  assert.equal(target.port, 49153);
  const run = fake.calls.find((call) => call.command === "docker" && call.args[0] === "run");
  const after = (flag) => run.args.filter((_, i) => run.args[i - 1] === flag);
  assert.deepEqual(after("--name"), [target.container]);
  assert.deepEqual(after("--label"), [
    `afc.owner=${OWNER}`,
    `afc.run=${target.run}`,
    `afc.purpose=${PURPOSE}`,
  ]);
  assert.deepEqual(after("--tmpfs"), ["/var/lib/postgresql/data"]);
  assert.deepEqual(after("-p"), ["127.0.0.1::5432"]);
  assert.ok(after("-e").includes(`POSTGRES_DB=${target.database}`));
  assert.equal(run.args.at(-1), "postgres:16");
  assert.ok(!run.args.some((arg) => ["-v", "--volume", "--mount"].includes(arg)));
  const tests = fake.calls.filter((call) => call.command === "pnpm");
  assert.equal(tests.length, 1);
  const [testCall] = tests;
  assert.deepEqual(testCall.args, ["test"]);
  assert.equal(testCall.options.cwd, root);
  assert.equal(testCall.options.detached, true);
  const { env } = testCall.options;
  assert.equal(env.DATABASE_URL, env.DIRECT_URL);
  const url = new URL(env.DATABASE_URL);
  assert.deepEqual(
    [url.protocol, url.hostname, url.port, url.pathname, url.username],
    ["postgresql:", "127.0.0.1", "49153", `/${target.database}`, "postgres"],
  );
  assert.match(url.password, /^[0-9a-f]{48}$/);
  assert.equal(TEST_TODAY, "2026-08-14");
  assert.equal(env.AFC_TEST_TODAY, TEST_TODAY);
  assert.equal(env.AFC_TEST_RUN_ID, target.run);
  assert.equal(Buffer.from(env.FIELD_ENCRYPTION_KEY, "base64").length, 32);
  assert.notEqual(env.FIELD_ENCRYPTION_KEY, base.FIELD_ENCRYPTION_KEY);
  for (const key of ["DEV_USER_ID", "E2E_DATABASE_URL", "NODE_OPTIONS", "PGPASSWORD"])
    assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(env.PATH, "synthetic-path");
  // 정리: 자기 PID 그룹 → 정확한 ID 존재 확인 → 소유 재확인 → rm -f -v → 부재 확인.
  assert.deepEqual(
    fake.calls.slice(fake.calls.indexOf(testCall) + 1).map((call) => call.args),
    [
      ["ps", "-a", "--no-trunc", "--filter", `id=${target.containerId}`, "--format", "{{.ID}}"],
      ["inspect", target.containerId],
      ["rm", "-f", "-v", target.containerId],
      ["ps", "-a", "--no-trunc", "--filter", `id=${target.containerId}`, "--format", "{{.ID}}"],
    ],
  );
  // 관리 child 9개(docker 8·pnpm 1)가 전부 소유 PID 를 남겼고, 정리 중에 만든 docker child 까지 그룹 부재를 확인했다.
  assert.equal(fake.calls.length, 9);
  assert.equal(fake.spawned.length, fake.calls.length);
  assert.deepEqual(fake.closed, fake.spawned);
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(url.password));
});

/** 통과하는 preflight 입력(합성) — 사례마다 한 가지만 바꾼다. */
const RUN = "0b0d7c84-5b5f-4c41-9d8e-7a1f2e3d4c5b";
function preflightInput(root, change = {}) {
  const owner = {
    id: "ab".repeat(32),
    container: "afc-ci-m0-test-0123abcd",
    database: "afc_ci_m0_0123abcd_test",
    run: RUN,
    ...change.owner,
  };
  const facts = {
    id: owner.id,
    name: `/${owner.container}`,
    labels: { "afc.owner": OWNER, "afc.run": RUN, "afc.purpose": PURPOSE },
    image: "postgres:16",
    running: true,
    tmpfs: true,
    volumes: 0,
    bindings: [{ host: "127.0.0.1", port: 49153 }],
    port: 49153,
    database: owner.database,
    currentDatabase: owner.database,
    ...change.facts,
  };
  const env = {
    ...ownedTestEnv({ PATH: "synthetic-path" }, owner, facts.port, "synthetic"),
    ...change.env,
  };
  return { owner, facts, env, root };
}

test("오대상(.env·dev DB·service DB·phase _e2e)·소유 불일치는 preflight 가 거부한다 — API 시험 child spawn 0, 남의 컨테이너는 지우지 않는다", async (t) => {
  const root = tempDir(t);
  assert.deepEqual(ownedTestProblems(preflightInput(root)), []);
  const loopback = { host: "127.0.0.1", port: 49153 };
  for (const [label, change, expected] of [
    ["dev DB 이름(afc)", { owner: { database: "afc" } }, ["database-name"]],
    ["공용 test DB 이름(afc_test)", { owner: { database: "afc_test" } }, ["database-name"]],
    [
      "dev compose·service 포트 5432",
      { facts: { bindings: [{ host: "127.0.0.1", port: 5432 }], port: 5432 } },
      ["binding"],
    ],
    [
      "service DB URL(기존 workflow)",
      { env: { DATABASE_URL: SERVICE_URL, DIRECT_URL: SERVICE_URL } },
      ["url-target"],
    ],
    ["DIRECT_URL 만 dev DB", { env: { DIRECT_URL: DEV_URL } }, ["url-pair"]],
    [
      "phase _e2e 라벨",
      {
        facts: {
          labels: { "afc.owner": "automation-m0-06", "afc.run": RUN, "afc.purpose": "owned-e2e" },
        },
      },
      ["owner-label", "purpose-label"],
    ],
    ["phase _e2e DB", { owner: { database: "afc_gen_s03_ci_0123abcd_e2e" } }, ["database-name"]],
    ["남은 env 의 다른 DB URL", { env: { E2E_DATABASE_URL: SERVICE_URL } }, ["foreign-url"]],
    [
      "다른 run 의 _test DB",
      {
        facts: { database: "afc_ci_m0_deadbeef_test", currentDatabase: "afc_ci_m0_deadbeef_test" },
      },
      ["database"],
    ],
    ["다른 컨테이너 ID", { facts: { id: "cd".repeat(32) } }, ["container-id"]],
    ["부분 ID", { owner: { id: "ab".repeat(6) }, facts: { id: "ab".repeat(6) } }, ["container-id"]],
    ["이름 불일치", { facts: { name: "/afc-other" } }, ["container-name"]],
    [
      "run 라벨 불일치",
      { facts: { labels: { "afc.owner": OWNER, "afc.run": "other", "afc.purpose": PURPOSE } } },
      ["run-label"],
    ],
    ["실행 중 아님", { facts: { running: false } }, ["running"]],
    ["다른 image", { facts: { image: "postgres:latest" } }, ["image"]],
    ["tmpfs 아님", { facts: { tmpfs: false } }, ["tmpfs"]],
    ["volume 있음", { facts: { volumes: 1 } }, ["volume"]],
    [
      "loopback 아닌 바인딩",
      { facts: { bindings: [{ host: "0.0.0.0", port: 49153 }] } },
      ["binding"],
    ],
    ["바인딩 2개", { facts: { bindings: [loopback, { host: "::", port: 49153 }] } }, ["binding"]],
    ["current_database 다름", { facts: { currentDatabase: "postgres" } }, ["database"]],
    [
      "URL query",
      {
        env: {
          DATABASE_URL: "postgresql://postgres:s@127.0.0.1:49153/afc_ci_m0_0123abcd_test?ssl=0",
          DIRECT_URL: "postgresql://postgres:s@127.0.0.1:49153/afc_ci_m0_0123abcd_test?ssl=0",
        },
      },
      ["url-target"],
    ],
    ["날짜 누락", { env: { AFC_TEST_TODAY: undefined } }, ["today"]],
    ["다른 날짜", { env: { AFC_TEST_TODAY: "2026-10-17" } }, ["today"]],
    ["run env 다름", { env: { AFC_TEST_RUN_ID: "other" } }, ["run-env"]],
    ["key 길이", { env: { FIELD_ENCRYPTION_KEY: "c2hvcnQ=" } }, ["key"]],
  ]) {
    assert.deepEqual(ownedTestProblems(preflightInput(root, change)), expected, label);
  }
  for (const file of [".env", "apps/api/.env", "apps/web/.env"]) {
    const dotenvRoot = tempDir(t);
    mkdirSync(path.dirname(path.join(dotenvRoot, ...file.split("/"))), { recursive: true });
    writeFileSync(path.join(dotenvRoot, ...file.split("/")), `DATABASE_URL=${DEV_URL}\n`);
    assert.deepEqual(ownedTestProblems(preflightInput(dotenvRoot)), ["dotenv"], file);
  }

  // wrapper: 같은 거부가 실제 runOwnedTest 안에서 API 시험 child 직전에 일어난다(spawn 0).
  const dotenvRoot = syntheticRoot(t);
  writeFileSync(path.join(dotenvRoot, ".env"), `DATABASE_URL=${DEV_URL}\n`);
  for (const [label, setup, expected] of [
    [
      "phase _e2e 라벨(남의 컨테이너로 보임 — 지우지 않는다)",
      {
        inspect: (info) => ({
          ...info,
          Config: {
            ...info.Config,
            Labels: {
              ...info.Config.Labels,
              "afc.owner": "automation-m0-06",
              "afc.purpose": "owned-e2e",
            },
          },
        }),
      },
      {
        failures: [
          { boundary: "gate", code: "OWNERSHIP" },
          { boundary: "cleanup", code: "CLEANUP_FAILED" },
        ],
        containerAbsent: false,
        removed: 0,
      },
    ],
    [
      "dev compose·service 포트 5432",
      {
        inspect: (info) => ({
          ...info,
          NetworkSettings: {
            Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] },
          },
        }),
      },
      { failures: [{ boundary: "gate", code: "OWNERSHIP" }], containerAbsent: true, removed: 1 },
    ],
    [
      "tmpfs 없음·volume",
      {
        inspect: (info) => ({
          ...info,
          HostConfig: { Tmpfs: {} },
          Mounts: [{ Type: "volume", Name: "pgdata" }],
        }),
      },
      { failures: [{ boundary: "gate", code: "OWNERSHIP" }], containerAbsent: true, removed: 1 },
    ],
    [
      ".env 가 있는 root",
      { root: dotenvRoot },
      { failures: [{ boundary: "gate", code: "OWNERSHIP" }], containerAbsent: true, removed: 1 },
    ],
    [
      "부모 env 의 service DB URL",
      { env: { PATH: "synthetic-path", LEGACY_SERVICE_URL: SERVICE_URL } },
      { failures: [{ boundary: "gate", code: "OWNERSHIP" }], containerAbsent: true, removed: 1 },
    ],
  ]) {
    const fake = fakeLauncher({ inspect: setup.inspect });
    const caseRoot = setup.root ?? syntheticRoot(t);
    const privateDir = path.join(tempDir(t), "private");
    const outcome = await runOwnedTest({
      root: caseRoot,
      env: setup.env ?? { PATH: "synthetic-path" },
      launch: fake.launch,
      writePrivate: privateSink(privateDir),
      closeGroup: fake.closeGroup,
      delay: noDelay,
    });
    assert.equal(outcome.status, "failed", label);
    assert.deepEqual(outcome.failures, expected.failures, label);
    assert.equal(outcome.cleanup.containerAbsent, expected.containerAbsent, label);
    assert.equal(fake.calls.filter((call) => call.command === "pnpm").length, 0, label);
    assert.equal(
      fake.calls.filter((call) => call.command === "docker" && call.args[0] === "rm").length,
      expected.removed,
      label,
    );
    // 거부 사유는 private 에만 고정 id 로 남는다.
    const preflight = readdirSync(privateDir).filter((name) => name.endsWith("-preflight.json"));
    assert.equal(preflight.length, 1, label);
    assert.ok(JSON.parse(readFileSync(path.join(privateDir, preflight[0]), "utf8")).length > 0);
  }
});

test("원 실패 + 정리 실패는 둘 다 보존되고, 정리만 실패해도 실패다 — 부재 확인과 구별한다", async (t) => {
  const run = async (fakeOptions = {}, closeGroup) => {
    const root = syntheticRoot(t);
    const fake = fakeLauncher(fakeOptions);
    const outcome = await runOwnedTest({
      root,
      env: { PATH: "synthetic-path" },
      launch: fake.launch,
      writePrivate: privateSink(path.join(root, "private")),
      closeGroup: closeGroup ?? fake.closeGroup,
      delay: noDelay,
    });
    return { outcome, fake };
  };
  const failTest = (command, args) =>
    command === "pnpm" && args[0] === "test" ? exited(1) : undefined;
  const failRm = (command, args) =>
    command === "docker" && args[0] === "rm" ? exited(1) : undefined;
  const BOTH = [
    { boundary: "gate", code: "CHILD_FAILED" },
    { boundary: "cleanup", code: "CLEANUP_FAILED" },
  ];

  const both = await run({ override: (c, a) => failTest(c, a) ?? failRm(c, a) });
  assert.equal(both.outcome.status, "failed");
  assert.deepEqual(both.outcome.failures, BOTH);
  assert.deepEqual(both.outcome.cleanup, { processGroupAbsent: true, containerAbsent: false });

  const cleanupOnly = await run({ override: failRm });
  assert.equal(cleanupOnly.outcome.status, "failed");
  assert.deepEqual(cleanupOnly.outcome.failures, [{ boundary: "cleanup", code: "CLEANUP_FAILED" }]);
  assert.deepEqual(cleanupOnly.outcome.cleanup, {
    processGroupAbsent: true,
    containerAbsent: false,
  });

  // PID 그룹 부재를 확인하지 못해도 정리 실패이고, 자기 컨테이너 정리는 계속한다.
  const group = await run({}, async () => {
    throw Object.assign(new Error("unconfirmed group"), { code: "EPERM" });
  });
  assert.deepEqual(group.outcome.failures, [{ boundary: "cleanup", code: "CLEANUP_FAILED" }]);
  assert.deepEqual(group.outcome.cleanup, { processGroupAbsent: false, containerAbsent: true });

  // docker run 이 ID 없이 실패하면 정확한 이름·run·owner 로만 되찾는다. nonzero 종료는 생성 요청이 끝났다는 증거가
  // 아니므로(숫자 0·무신호 close 만 정상 완료 — fix-02) 빈 조회는 부재가 아니라 미확인이다.
  const noId = await run({
    override: (command, args) =>
      command === "docker" && args[0] === "run" ? exited(125) : undefined,
  });
  assert.deepEqual(noId.outcome.failures, [
    { boundary: "gate", code: "OPERATION_FAILED" },
    { boundary: "cleanup", code: "CLEANUP_UNVERIFIED" },
  ]);
  assert.deepEqual(noId.outcome.cleanup, { processGroupAbsent: true, containerAbsent: false });
  const lookup = noId.fake.calls.find((call) => call.command === "docker" && call.args[0] === "ps");
  assert.ok(lookup.args.includes(`label=afc.owner=${OWNER}`));
  assert.ok(lookup.args.some((arg) => /^name=\^\/afc-ci-m0-test-[0-9a-f]{8}\$$/.test(arg)));
  assert.ok(lookup.args.some((arg) => arg.startsWith("label=afc.run=")));
  assert.equal(noId.fake.calls.filter((call) => call.command === "pnpm").length, 0);

  // docker run 이 시간 초과했지만 컨테이너가 생겼으면 같은 방식으로 찾아 지우고 부재를 확인한다.
  const timedOut = await run({ runTimesOut: true });
  assert.deepEqual(timedOut.outcome.failures, [{ boundary: "gate", code: "TIMEOUT" }]);
  assert.deepEqual(timedOut.outcome.cleanup, { processGroupAbsent: true, containerAbsent: true });
  assert.equal(timedOut.fake.container.removed, true);

  // gate 로 보면: owned-test 는 두 boundary 를 모두 공개하고, owned-e2e 는 실행하지 않는다.
  const fake = fakeLauncher({ override: (c, a) => failTest(c, a) ?? failRm(c, a) });
  const { summary } = await syntheticMain(t, fake);
  assert.deepEqual(summary.gates.at(-2), {
    id: "owned-test",
    status: "failed",
    failures: BOTH,
    cleanup: { processGroupAbsent: true, containerAbsent: false },
  });
  assert.deepEqual(summary.gates.at(-1), { id: "owned-e2e", status: "not-run" });
  assert.equal(summary.exitCode, 1);
  assert.equal(fake.calls.filter((call) => call.command === "xvfb-run").length, 0);
});

test("codegen-drift — 실제 git 으로 추적 생성물 존재·비어 있지 않음·diff 0 을 함께 본다(미추적·빈 파일·drift 는 RED)", async (t) => {
  const repo = tempDir(t);
  const privateRoot = tempDir(t);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  const file = path.join(repo, ...CODEGEN_OUTPUT.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "export interface paths {}\n");
  const gate = gatesFor("m0").find((candidate) => candidate.id === "codegen-drift");
  let runs = 0;
  const check = async (root = repo) => {
    runs += 1;
    const results = await runGates([gate], {
      root,
      env: process.env,
      launch: realLaunch,
      writePrivate: privateSink(path.join(privateRoot, String(runs))),
    });
    return summarize("m0", { status: "passed" }, results).gates.find(
      (candidate) => candidate.id === "codegen-drift",
    );
  };
  const red = (code) => ({
    id: "codegen-drift",
    status: "failed",
    failures: [{ boundary: "gate", code }],
    cleanup: { processGroupAbsent: true },
  });
  const green = { id: "codegen-drift", status: "passed", cleanup: { processGroupAbsent: true } };
  // 미추적 생성물은 git diff 가 0 이어도 RED 다.
  assert.deepEqual(await check(), red("CODEGEN_UNTRACKED"));
  git("add", CODEGEN_OUTPUT);
  git("-c", "user.name=ci-m0", "-c", "user.email=ci-m0@example.invalid", "commit", "-q", "-m", "g");
  assert.deepEqual(await check(), green);
  // 재생성 결과가 추적본과 다르면 drift.
  writeFileSync(file, "export interface paths { changed: true }\n");
  assert.deepEqual(await check(), red("CODEGEN_DRIFT"));
  // 빈 출력·부재는 추적돼 있어도 RED.
  writeFileSync(file, "");
  assert.deepEqual(await check(), red("CODEGEN_EMPTY"));
  rmSync(file);
  assert.deepEqual(await check(), red("CODEGEN_EMPTY"));
  writeFileSync(file, "export interface paths {}\n");
  assert.deepEqual(await check(), green);
  // git 저장소가 아니면 추적 확인 자체가 실패다(합격으로 넘어가지 않는다).
  const plain = tempDir(t);
  mkdirSync(path.join(plain, "apps", "web", "lib"), { recursive: true });
  writeFileSync(path.join(plain, ...CODEGEN_OUTPUT.split("/")), "export interface paths {}\n");
  assert.deepEqual(await check(plain), red("CHILD_FAILED"));
});

test("미지원 runner·install 흔적 없음·임의 인자는 어떤 child·private 자원보다 먼저 실패한다(install 호출 0)", async () => {
  const notRun = GATE_IDS.map((id) => ({ id, status: "not-run" }));
  const webInstall = path.join("/candidate", "apps", "web", "node_modules");
  for (const [label, options, code, stage] of [
    ["GITHUB_ACTIONS 없음", { env: {}, platform: "linux" }, "UNSUPPORTED_RUNNER", "m0"],
    [
      "GITHUB_ACTIONS=false",
      { env: { GITHUB_ACTIONS: "false" }, platform: "linux" },
      "UNSUPPORTED_RUNNER",
      "m0",
    ],
    [
      "GITHUB_ACTIONS=1",
      { env: { GITHUB_ACTIONS: "1" }, platform: "linux" },
      "UNSUPPORTED_RUNNER",
      "m0",
    ],
    ["Windows", { env: { GITHUB_ACTIONS: "true" }, platform: "win32" }, "UNSUPPORTED_RUNNER", "m0"],
    ["macOS", { env: { GITHUB_ACTIONS: "true" }, platform: "darwin" }, "UNSUPPORTED_RUNNER", "m0"],
    [
      "product 도 같은 guard",
      { argv: ["--stage", "product"], env: {}, platform: "linux" },
      "UNSUPPORTED_RUNNER",
      "product",
    ],
    [
      "install 흔적 없음",
      { env: { GITHUB_ACTIONS: "true" }, platform: "linux", exists: () => false },
      "MISSING_INSTALL",
      "m0",
    ],
    [
      "web install 만 없음",
      {
        env: { GITHUB_ACTIONS: "true" },
        platform: "linux",
        root: "/candidate",
        exists: (file) => file !== webInstall,
      },
      "MISSING_INSTALL",
      "m0",
    ],
    [
      "임의 인자",
      { argv: ["--skip-db"], env: { GITHUB_ACTIONS: "true" }, platform: "linux" },
      "UNKNOWN_ARGUMENT",
      null,
    ],
    [
      "부분 실행 인자",
      {
        argv: ["--stage", "m0", "--only", "lint"],
        env: { GITHUB_ACTIONS: "true" },
        platform: "linux",
      },
      "UNKNOWN_ARGUMENT",
      null,
    ],
  ]) {
    const touched = [];
    let published;
    const exitCode = await main({
      argv: [],
      ...options,
      launch: (command) => {
        touched.push(`launch ${command}`);
        return ok();
      },
      writePrivate: (name) => touched.push(`private ${name}`),
      closeGroup: async () => {
        touched.push("close");
      },
      output: (line) => {
        published = line;
      },
    });
    assert.equal(exitCode, 1, label);
    assert.deepEqual(touched, [], label);
    assert.deepEqual(
      JSON.parse(published),
      { stage, root: { status: "failed", code }, gates: notRun, exitCode: 1 },
      label,
    );
  }
  assert.doesNotThrow(() => checkRunner({ env: { GITHUB_ACTIONS: "true" }, platform: "linux" }));
  assert.throws(
    () => checkRunner({ env: { GITHUB_ACTIONS: "true" }, platform: "win32" }),
    (error) => error.code === "UNSUPPORTED_RUNNER",
  );
  assert.doesNotThrow(() => checkInstall("/candidate", () => true));
  assert.throws(
    () => checkInstall("/candidate", () => false),
    (error) => error.code === "MISSING_INSTALL",
  );
});

test("sentinel — 실제 child 의 양 스트림·원 오류는 private 양성, 공개 stdout/stderr·summary 는 음성(모든 경계)", (t) => {
  const dir = tempDir(t);
  const sentinel = "CI_M0_PRIVATE_SENTINEL_7f3a";
  const probe = path.join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `import { main, privateSink, runGates, summarize } from ${JSON.stringify(pathToFileURL(CLI).href)};
const [mode, privateDir] = process.argv.slice(2);
const sentinel = ${JSON.stringify(sentinel)};
const sink = privateSink(privateDir);
const fail = () => {
  throw Object.assign(new Error(sentinel), { code: sentinel, argv: [sentinel] });
};
if (mode === "top-level" || mode === "argument") {
  process.exitCode = await main({
    argv: mode === "argument" ? ["--stage", sentinel] : [],
    env: { GITHUB_ACTIONS: "true", SECRET: sentinel },
    platform: "linux",
    writePrivate: sink,
    exists: mode === "top-level" ? fail : () => true,
    launch: fail,
  });
} else {
  const s = JSON.stringify(sentinel);
  const write = "process.stdout.write(" + s + ");process.stderr.write(" + s + ");";
  const body = {
    passed: write,
    exit: write + "process.exitCode=1;",
    signal: "process.stdout.write(" + s + ",()=>process.stderr.write(" + s + ",()=>process.kill(process.pid,'SIGTERM')));setTimeout(()=>{},10000);",
    timeout: write + "setTimeout(()=>{},60000);",
    overflow: write + "process.stdout.write(Buffer.alloc(34*1024*1024,120));",
    cleanup: write,
    both: write + "process.exitCode=1;",
    "private-io": write,
    abort: write + "setTimeout(()=>{},60000);",
    "owned-e2e": write,
  }[mode];
  const controller = new AbortController();
  if (mode === "abort") setTimeout(() => controller.abort(new Error(sentinel)), 2000);
  const gates = [
    mode === "spawn"
      ? { id: "bootstrap", command: privateDir + "-" + sentinel + "-missing", args: [sentinel] }
      : mode === "owned-e2e"
        ? { id: "bootstrap", ownedE2E: true, command: process.execPath, args: ["-e", body, "m0"], timeout: 60000 }
        : { id: "bootstrap", command: process.execPath, args: ["-e", body], ...(mode === "timeout" ? { timeout: 2000 } : {}) },
    { id: "fixtures", command: process.execPath, args: ["-e", ""] },
  ];
  const results = await runGates(gates, {
    root: process.cwd(),
    env: { ...process.env, SECRET: sentinel },
    signal: controller.signal,
    writePrivate: mode === "private-io" ? fail : sink,
    closeGroup: ["cleanup", "both"].includes(mode) ? fail : undefined,
  });
  const summary = summarize("m0", { status: "passed" }, results);
  console.log(JSON.stringify(summary));
  process.exitCode = summary.exitCode;
}
`,
  );
  const gate = (failures, cleanup = { processGroupAbsent: true }) => ({
    id: "bootstrap",
    status: "failed",
    failures,
    cleanup,
  });
  const gateCode = (code) => gate([{ boundary: "gate", code }]);
  const notRunAll = GATE_IDS.map((id) => ({ id, status: "not-run" }));
  for (const [mode, expectation, privatePositive] of [
    [
      "passed",
      {
        bootstrap: { id: "bootstrap", status: "passed", cleanup: { processGroupAbsent: true } },
        fixtures: "passed",
      },
      true,
    ],
    ["exit", { bootstrap: gateCode("CHILD_FAILED") }, true],
    ["signal", { bootstrap: gateCode("CHILD_FAILED") }, true],
    // 소유 PID 를 받지 못한 child — 그룹 부재는 확인된 것이 아니다(QA-01: 빈 등록 목록은 종료 증거가 아니다).
    [
      "spawn",
      {
        bootstrap: gate(
          [
            { boundary: "gate", code: "SPAWN_FAILED" },
            { boundary: "cleanup", code: "CLEANUP_UNVERIFIED" },
          ],
          { processGroupAbsent: false },
        ),
      },
      true,
    ],
    ["timeout", { bootstrap: gateCode("TIMEOUT") }, true],
    ["overflow", { bootstrap: gateCode("OUTPUT_LIMIT") }, true],
    [
      "cleanup",
      {
        bootstrap: gate([{ boundary: "cleanup", code: "CLEANUP_FAILED" }], {
          processGroupAbsent: false,
        }),
      },
      true,
    ],
    [
      "both",
      {
        bootstrap: gate(
          [
            { boundary: "gate", code: "CHILD_FAILED" },
            { boundary: "cleanup", code: "CLEANUP_FAILED" },
          ],
          { processGroupAbsent: false },
        ),
      },
      true,
    ],
    ["private-io", { bootstrap: gateCode("PRIVATE_IO") }, false],
    ["abort", { bootstrap: gateCode("ABORTED") }, true],
    // owned-e2e 전용 경계도 양 스트림은 private 에만 — phase 증거가 없으니 정상 exit 여도 정리 미확인 실패다.
    [
      "owned-e2e",
      {
        bootstrap: gate([{ boundary: "cleanup", code: "CLEANUP_UNVERIFIED" }], {
          processGroupAbsent: true,
          phaseCleanupVerified: false,
        }),
      },
      true,
    ],
    ["top-level", { root: { status: "failed", code: "OPERATION_FAILED" } }, true],
    ["argument", { root: { status: "failed", code: "UNKNOWN_ARGUMENT" } }, false],
  ]) {
    const privateDir = path.join(dir, `private-${mode}`);
    const observed = spawnSync(NODE, [probe, mode, privateDir], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    // 공개 경계: stdout 은 summary 한 줄, stderr 는 비어 있고, 둘 다 sentinel 이 없다.
    assert.equal(observed.status, 1, mode);
    assert.equal(observed.stderr, "", mode);
    assert.doesNotMatch(observed.stdout + observed.stderr, new RegExp(sentinel), mode);
    const summary = JSON.parse(observed.stdout);
    assert.equal(summary.exitCode, 1, mode);
    if (expectation.root) {
      assert.deepEqual(summary.root, expectation.root, mode);
      assert.deepEqual(summary.gates, notRunAll, mode);
      assert.equal(summary.stage, mode === "argument" ? null : "m0", mode);
    } else {
      assert.deepEqual(summary.root, { status: "passed" }, mode);
      assert.deepEqual(summary.gates[0], expectation.bootstrap, mode);
      assert.equal(summary.gates[1].status, expectation.fixtures ?? "not-run", mode);
    }
    // private 경계: 같은 sentinel 이 private 파일에는 남는다(쓰기 자체가 실패한 경계·인자 거부는 파일 0).
    const files = existsSync(privateDir) ? readdirSync(privateDir) : [];
    const text = files
      .map((name) => readFileSync(path.join(privateDir, name), "latin1"))
      .join("\n");
    if (privatePositive) assert.match(text, new RegExp(sentinel), mode);
    else assert.deepEqual(files, [], mode);
  }
});

test("실제 CLI — import 는 부작용이 없고, 미지원 runner·임의 인자는 공개 summary 한 줄만 내며 child·private 자원을 만들지 않는다", (t) => {
  const sentinel = "CI_M0_CLI_SENTINEL_51c9";
  const notRun = GATE_IDS.map((id) => ({ id, status: "not-run" }));
  const run = (argv) => {
    const temp = tempDir(t);
    // 지원 환경(GitHub Linux)에서도 guard 가 먼저 거부하도록 GITHUB_ACTIONS=false 를 명시한다(재귀 ci:m0 금지).
    const env = {
      ...process.env,
      GITHUB_ACTIONS: "false",
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
      CI_M0_SECRET: sentinel,
    };
    const observed = spawnSync(NODE, argv, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { ...observed, left: readdirSync(temp) };
  };
  for (const [args, stage, code] of [
    [[], "m0", "UNSUPPORTED_RUNNER"],
    [["--stage", "m0"], "m0", "UNSUPPORTED_RUNNER"],
    [["--stage", "product"], "product", "UNSUPPORTED_RUNNER"],
    [["--stage", sentinel], null, "UNKNOWN_ARGUMENT"],
    [["--stage=m0"], null, "UNKNOWN_ARGUMENT"],
    [["--partial"], null, "UNKNOWN_ARGUMENT"],
  ]) {
    const observed = run([CLI, ...args]);
    const label = JSON.stringify(args);
    assert.equal(observed.status, 1, label);
    assert.equal(observed.stderr, "", label);
    assert.equal(observed.stdout.trim().split("\n").length, 1, label);
    assert.deepEqual(
      JSON.parse(observed.stdout),
      { stage, root: { status: "failed", code }, gates: notRun, exitCode: 1 },
      label,
    );
    assert.doesNotMatch(observed.stdout + observed.stderr, new RegExp(sentinel), label);
    assert.deepEqual(observed.left, [], label);
  }
  const imported = run([
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
  ]);
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  assert.deepEqual(imported.left, []);
});

/**
 * OS 메모리 모델 — child·PID 그룹·stdio 보유·신호·시계를 흉내 낸다(실제 child·docker·Linux 실측이 아니다). 실제
 * privateLaunch 본문(modelLaunch)·실제 owned-e2e 경계(runGates)·실제 closeOwnedGroup 이 이 모델의 spawn/kill/timer 를
 * 소비한다. kill 은 대상 존재만 즉시 판정하고 신호는 +0ms 에 전달한다(kill(2)처럼). 정리 확인용 killNow 는 즉시 전달한다.
 * close 는 exit 뒤 그 stdio 를 쥔 프로세스가 모두 끝나야 온다(xvfb-run 이 먼저 죽어도 runner 가 쥐고 있으면 열려 있다).
 */
const PARENT_GROUP = 1;
function osModel() {
  let now = 0;
  let order = 0;
  let lastPid = 7000;
  const timers = new Map();
  const processes = [];
  const signals = [];
  const spawns = [];
  const denied = new Set();
  const members = (target) =>
    processes.filter(
      (proc) => proc.alive && (target < 0 ? proc.group === -target : proc.pid === target),
    );
  const makeProcess = (pid, group, pipes) => {
    const proc = {
      pid,
      group,
      pipes,
      alive: true,
      onTerm: undefined,
      receive(kind) {
        if (!proc.alive) return;
        if (kind === "SIGTERM" && proc.onTerm) proc.onTerm();
        else proc.exit(null, kind);
      },
      write(channel, data) {
        for (const pipe of proc.pipes) pipe.child[channel].emit("data", Buffer.from(data));
      },
      exit(code, kind) {
        if (!proc.alive) return;
        proc.alive = false;
        for (const pipe of proc.pipes) {
          pipe.holders.delete(proc);
          if (pipe.owner === proc) {
            pipe.exited = [code, kind];
            pipe.child.emit("exit", code, kind);
          }
          if (pipe.exited && pipe.holders.size === 0 && !pipe.closed) {
            pipe.closed = true;
            pipe.child.emit("close", ...pipe.exited);
          }
        }
      },
    };
    for (const pipe of pipes) pipe.holders.add(proc);
    processes.push(proc);
    return proc;
  };
  const deliver = (target, kind, immediate) => {
    if (denied.has(target)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    const found = members(target);
    if (found.length === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    if (kind === 0) return true;
    signals.push({ at: now, target, kind });
    const receive = () => found.forEach((proc) => proc.receive(kind));
    if (immediate) receive();
    else model.setTimeout(receive, 0);
    return true;
  };
  const model = {
    signals,
    spawns,
    denied,
    program: () => {},
    spawnError: () => false,
    get now() {
      return now;
    },
    setTimeout: (action, ms) => {
      order += 1;
      timers.set(order, { at: now + Math.max(0, Number(ms) || 0), action });
      return order;
    },
    clearTimeout: (id) => timers.delete(id),
    runNext: () => {
      let next;
      for (const entry of timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next) return false;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].action();
      return true;
    },
    runAll: () => {
      while (model.runNext());
    },
    sleep: (ms) => new Promise((resolve) => model.setTimeout(resolve, ms)),
    alive: (group) => members(-group).length > 0,
    kill: (target, kind) => deliver(target, kind, false),
    killNow: (target, kind) => deliver(target, kind, true),
    spawn: (command, args, options = {}) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: childStream(),
        stderr: childStream(),
      });
      const record = { at: now, command, args: [...args], options, pid: undefined };
      spawns.push(record);
      if (model.spawnError(command, args)) {
        model.setTimeout(() => {
          const error = new Error(`spawn ${command} ENOENT`);
          child.emit(
            "error",
            Object.assign(error, { code: "ENOENT", syscall: `spawn ${command}` }),
          );
          child.emit("close", -2, null);
        }, 0);
        return child;
      }
      lastPid += 1;
      const pid = lastPid;
      const pipe = {
        child,
        holders: new Set(),
        owner: undefined,
        exited: undefined,
        closed: false,
      };
      const proc = makeProcess(pid, options.detached === true ? pid : PARENT_GROUP, [pipe]);
      pipe.owner = proc;
      Object.assign(record, { pid, proc });
      Object.assign(child, {
        pid,
        kill: (kind = "SIGTERM") => {
          try {
            return deliver(pid, kind, false);
          } catch {
            return false;
          }
        },
      });
      model.setTimeout(() => model.program(proc, command, args, options), 0);
      return child;
    },
    // 같은 그룹·같은 stdio 를 쥔 하위 프로세스(xvfb-run 아래 node runner).
    fork: (parent) => {
      lastPid += 1;
      return makeProcess(lastPid, parent.group, parent.pipes);
    },
  };
  return model;
}

/** 모델 위의 비동기 실행을 끝까지 몬다 — microtask 를 비운 뒤 다음 모델 timer 를 하나씩 쏜다. */
async function drive(model, promise) {
  let state;
  promise.then(
    (value) => {
      state = { value };
    },
    (error) => {
      state = { error };
    },
  );
  for (let turn = 0; turn < 100_000 && !state; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!state && !model.runNext()) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!state) throw new Error("model run did not settle");
  if (Object.hasOwn(state, "error")) throw state.error;
  return state.value;
}

/** 실제 privateLaunch 본문(ci-e2e.mjs 그대로)을 모델 OS(spawn·kill·timer·linux)에 연결한다. */
const modelLaunch = (model) =>
  runInNewContext(`(${privateLaunch.toString()})`, {
    Buffer,
    coded: (code) => Object.assign(new Error(code), { code }),
    process: { platform: "linux", kill: model.kill },
    spawn: model.spawn,
    setTimeout: model.setTimeout,
    clearTimeout: model.clearTimeout,
  });

/** docker daemon·CLI 모델 — run/exec/inspect/ps/rm 을 모델 child 로 흉내 낸다. plan[verb](args, proc) 가 행동을 고른다. */
function dockerModel(model, plan = {}) {
  const containers = [];
  const live = () => containers.filter((container) => !container.removed);
  const create = (args) => {
    const container = {
      id: String(containers.length + 1)
        .padStart(2, "0")
        .repeat(32),
      name: "",
      labels: {},
      env: [],
      removed: false,
    };
    for (let i = 1; i < args.length - 1; i += 1) {
      const value = args[i + 1];
      if (args[i] === "--name") container.name = value;
      if (args[i] === "-e") container.env.push(value);
      if (args[i] === "--label") {
        const [key, label] = value.split(/=(.*)/s);
        container.labels[key] = label;
      }
    }
    containers.push(container);
    return container;
  };
  const describe = (container) => ({
    Id: container.id,
    Name: `/${container.name}`,
    Config: { Image: "postgres:16", Labels: { ...container.labels }, Env: [...container.env] },
    State: { Running: true },
    HostConfig: { Tmpfs: { "/var/lib/postgresql/data": "" } },
    Mounts: [],
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } },
  });
  const matches = (args) => {
    const filters = args.filter((_, i) => args[i - 1] === "--filter");
    return live().filter((container) =>
      filters.every((filter) => {
        const [kind, value] = filter.split(/=(.*)/s);
        if (kind === "id") return container.id === value;
        if (kind === "name") return value === `^/${container.name}$`;
        const [key, label] = value.split(/=(.*)/s);
        return kind === "label" && container.labels[key] === label;
      }),
    );
  };
  const reply = (proc, status, stdout = "") =>
    model.setTimeout(() => {
      if (!proc.alive) return;
      if (stdout) proc.write("stdout", stdout);
      proc.exit(status, null);
    }, 10);
  const program = (proc, args) => {
    const [verb] = args;
    const behavior = plan[verb]?.(args, proc, model);
    if (behavior === "hang") return;
    if (verb === "run") {
      // lateMs: CLI 는 멈춘 채 daemon 이 요청을 나중에 처리한다(CLI 가 죽어도 생성은 일어난다).
      if (behavior?.lateMs !== undefined) {
        model.setTimeout(() => create(args), behavior.lateMs);
        return;
      }
      const container = create(args);
      if (behavior !== "created-hang") reply(proc, 0, `${container.id}\n`);
      return;
    }
    const target = live().find((c) => c.id === args[1] || c.id === args.at(-1));
    if (verb === "exec") {
      const database = target?.env.find((entry) => entry.startsWith("POSTGRES_DB="))?.slice(12);
      reply(proc, target ? 0 : 1, args.includes("psql") ? `${database}\n` : "");
    } else if (verb === "inspect")
      reply(proc, target ? 0 : 1, JSON.stringify([target && describe(target)]));
    else if (verb === "ps")
      reply(
        proc,
        0,
        matches(args)
          .map((c) => `${c.id}\n`)
          .join(""),
      );
    else if (verb === "rm" && target) {
      target.removed = true;
      reply(proc, 0);
    } else reply(proc, 1);
  };
  return { containers, live, program };
}

/** QA-01 — 실제 runOwnedTest + 실제 privateLaunch 본문 + 실제 closeOwnedGroup 을 모델 OS 위에서 끝까지 실행한다. */
async function ownedTestOnModel(t, plan = {}) {
  const model = osModel();
  const docker = dockerModel(model, plan);
  model.program = (proc, command, args) => {
    if (command === "docker") return docker.program(proc, args);
    if (plan.denyTestGroup) model.denied.add(-proc.pid);
    model.setTimeout(() => proc.exit(plan.testStatus ?? 0, null), 1000);
  };
  if (plan.spawnError) model.spawnError = plan.spawnError;
  const controller = new AbortController();
  if (plan.abortAt !== undefined) model.setTimeout(() => controller.abort(), plan.abortAt);
  const root = syntheticRoot(t);
  const closed = [];
  const outcome = await drive(
    model,
    runOwnedTest({
      root,
      env: { PATH: "synthetic-path" },
      signal: controller.signal,
      launch: modelLaunch(model),
      writePrivate: privateSink(path.join(root, "private")),
      closeGroup: (pid) => {
        closed.push(pid);
        return closeOwnedGroup(pid, model.killNow);
      },
      delay: (ms) => model.sleep(ms),
    }),
  );
  const pids = model.spawns.filter((spawned) => spawned.pid).map((spawned) => spawned.pid);
  const verb = (name) => model.spawns.filter((s) => s.command === "docker" && s.args[0] === name);
  return { outcome, model, docker, closed, pids, verb, root };
}

test("QA-01 관리 child — docker·pg_isready 도 조기 소유 PID·자기 그룹 TERM/KILL·부재 확인 경로이고, 빈 등록·빈 조회는 부재 증거가 아니다(메모리 모델: 실제 runOwnedTest·privateLaunch·closeOwnedGroup)", async (t) => {
  const term = (pid, at) => ({ at, target: -pid, kind: "SIGTERM" });
  const gate = (code) => ({ boundary: "gate", code });
  const UNVERIFIED = { boundary: "cleanup", code: "CLEANUP_UNVERIFIED" };

  await t.test(
    "정상: 관리 child 9개 전부 detached·소유 PID, 정리에서 그룹 부재 확인, 신호 0",
    async (st) => {
      const normal = await ownedTestOnModel(st);
      assert.equal(normal.outcome.status, "passed");
      assert.deepEqual(normal.outcome.cleanup, { processGroupAbsent: true, containerAbsent: true });
      assert.equal(normal.model.spawns.length, 9);
      assert.ok(normal.model.spawns.every((s) => s.options.detached === true && s.pid));
      assert.deepEqual(normal.closed, normal.pids);
      assert.deepEqual(normal.model.signals, []);
      assert.deepEqual(normal.docker.live(), []);
    },
  );

  // CLI 의 정상 close 를 못 봤으니 빈 조회는 뒤늦은 생성을 배제하지 못한다 — 부재가 아니라 미확인이다.
  await t.test(
    "docker run 멈춤(컨테이너 없음): 5분 timeout 에 자기 그룹 TERM → 종료 → 빈 조회는 미확인",
    async (st) => {
      const hung = await ownedTestOnModel(st, { run: () => "hang" });
      const [hungRun] = hung.verb("run");
      assert.deepEqual(hung.model.signals, [term(hungRun.pid, TIMEOUTS.docker)]);
      assert.equal(hungRun.proc.alive, false);
      assert.deepEqual(hung.outcome.failures, [gate("TIMEOUT"), UNVERIFIED]);
      assert.deepEqual(hung.outcome.cleanup, { processGroupAbsent: true, containerAbsent: false });
      // 정리 중에 만든 lookup child 까지 소유 그룹 부재를 확인했다.
      assert.deepEqual(hung.closed, hung.pids);
    },
  );

  await t.test(
    "TERM 무시 docker run(컨테이너 생김): 2초 뒤 KILL → 정확 조회로 회수·부재 확인",
    async (st) => {
      const stubborn = await ownedTestOnModel(st, {
        run: (args, proc) => {
          proc.onTerm = () => {};
          return "created-hang";
        },
      });
      const [stubbornRun] = stubborn.verb("run");
      assert.deepEqual(stubborn.model.signals, [
        term(stubbornRun.pid, TIMEOUTS.docker),
        { at: TIMEOUTS.docker + 2000, target: -stubbornRun.pid, kind: "SIGKILL" },
      ]);
      assert.deepEqual(stubborn.outcome.failures, [gate("TIMEOUT")]);
      assert.deepEqual(stubborn.outcome.cleanup, {
        processGroupAbsent: true,
        containerAbsent: true,
      });
      assert.deepEqual(stubborn.docker.live(), []);
      assert.deepEqual(stubborn.closed, stubborn.pids);
    },
  );

  await t.test(
    "중단 + 지연 생성: CLI 를 끝낸 뒤 daemon 이 컨테이너를 만든다 — 그때의 빈 조회는 미확인",
    async (st) => {
      const late = await ownedTestOnModel(st, { run: () => ({ lateMs: 20_000 }), abortAt: 10_000 });
      const [lateRun] = late.verb("run");
      assert.deepEqual(late.model.signals, [term(lateRun.pid, 10_000)]);
      assert.deepEqual(late.outcome.failures, [gate("ABORTED"), UNVERIFIED]);
      assert.deepEqual(late.outcome.cleanup, { processGroupAbsent: true, containerAbsent: false });
      late.model.runAll();
      // 남은 모델 시간에 컨테이너가 생긴다 — 정리 때의 빈 조회는 부재 증거가 아니었다(그래서 미확인으로 보고했다).
      assert.equal(late.docker.live().length, 1);
    },
  );

  await t.test(
    "pg_isready 한 번 멈춤: 그 child 도 자기 그룹 TERM 으로 끝내고 재시도 뒤 정상 진행",
    async (st) => {
      let probes = 0;
      const ready = await ownedTestOnModel(st, {
        exec: (args) => {
          if (!args.includes("pg_isready")) return undefined;
          probes += 1;
          return probes === 1 ? "hang" : undefined;
        },
      });
      const [stuck] = ready.model.spawns.filter((s) => s.args.includes("pg_isready"));
      assert.deepEqual(ready.model.signals, [term(stuck.pid, stuck.at + TIMEOUTS.docker)]);
      assert.equal(ready.outcome.status, "passed");
      assert.deepEqual(ready.outcome.cleanup, { processGroupAbsent: true, containerAbsent: true });
      assert.deepEqual(ready.closed, ready.pids);
    },
  );

  await t.test(
    "spawn 실패(PID 미확보): 그 child 와 생성 요청의 빈 조회는 부재가 아니라 미확인",
    async (st) => {
      const unspawned = await ownedTestOnModel(st, {
        spawnError: (command, args) => command === "docker" && args[0] === "run",
      });
      assert.deepEqual(unspawned.outcome.failures, [gate("OPERATION_FAILED"), UNVERIFIED]);
      assert.deepEqual(unspawned.outcome.cleanup, {
        processGroupAbsent: false,
        containerAbsent: false,
      });
      assert.deepEqual(unspawned.model.signals, []);
    },
  );

  await t.test(
    "원 실패 + 정리 실패: 한 그룹 부재 확인이 거부돼도(EPERM) 나머지·자기 컨테이너 정리는 끝까지, 둘 다 보존",
    async (st) => {
      const denied = await ownedTestOnModel(st, { testStatus: 1, denyTestGroup: true });
      assert.deepEqual(denied.outcome.failures, [
        gate("CHILD_FAILED"),
        { boundary: "cleanup", code: "CLEANUP_FAILED" },
      ]);
      assert.deepEqual(denied.outcome.cleanup, {
        processGroupAbsent: false,
        containerAbsent: true,
      });
      assert.deepEqual(denied.closed, denied.pids);
      assert.deepEqual(denied.docker.live(), []);
    },
  );

  await t.test(
    "동시 이벤트: 중단과 docker run 정상 exit 가 같은 시각 — settle 1회, 원 실패 보존, 정확 조회로 회수",
    async (st) => {
      const tie = await ownedTestOnModel(st, { abortAt: 10 });
      assert.deepEqual(tie.outcome.failures, [gate("ABORTED")]);
      assert.deepEqual(tie.outcome.cleanup, { processGroupAbsent: true, containerAbsent: true });
      assert.deepEqual(tie.docker.live(), []);
      assert.deepEqual(tie.closed, tie.pids);
      const states = readdirSync(path.join(tie.root, "private")).filter((name) =>
        name.endsWith("-docker-run-state.json"),
      );
      assert.equal(states.length, 1);
    },
  );

  // fix-02: 생성 요청의 정상 완료는 숫자 0·무신호 close 뿐이다. 우리 launcher 가 아닌 바깥 신호로 CLI 가 닫혀도
  // (launcher 오류 없음·root abort 없음) daemon 의 진행 중 생성 요청이 끝났다는 증거가 아니다.
  const externalSignal = (kind) => (args, proc, model) => {
    model.setTimeout(() => proc.receive(kind), 10_000);
    return { lateMs: 20_000 };
  };
  const closeWith = (status, kind) => (args, proc, model) => {
    model.setTimeout(() => proc.exit(status, kind), 10_000);
    return { lateMs: 20_000 };
  };
  const expectUnverifiedLate = (result, label) => {
    // 우리 쪽 신호 0 — 종료는 바깥에서 왔다.
    assert.deepEqual(result.model.signals, [], label);
    assert.deepEqual(result.outcome.failures, [gate("OPERATION_FAILED"), UNVERIFIED], label);
    assert.deepEqual(
      result.outcome.cleanup,
      { processGroupAbsent: true, containerAbsent: false },
      label,
    );
    assert.deepEqual(result.closed, result.pids, label);
    result.model.runAll();
    // 정리 뒤 daemon 이 늦게 만든 자기 컨테이너 — 빈 조회를 부재 증거로 썼다면 이것을 놓친다.
    assert.equal(result.docker.live().length, 1, label);
  };

  await t.test(
    "외부 SIGKILL close(오류 없음·root abort 없음)+지연 생성: 정상 완료가 아니다 — 미확인",
    async (st) => {
      expectUnverifiedLate(
        await ownedTestOnModel(st, { run: externalSignal("SIGKILL") }),
        "SIGKILL",
      );
    },
  );

  await t.test("외부 SIGTERM close+지연 생성: 정상 완료가 아니다 — 미확인", async (st) => {
    expectUnverifiedLate(await ownedTestOnModel(st, { run: externalSignal("SIGTERM") }), "SIGTERM");
  });

  await t.test(
    "모호한 종료(status null·undefined·nonzero·숫자 0+신호)+지연 생성: 정상 완료 불인정 — 미확인",
    async (st) => {
      for (const [status, kind] of [
        [null, null],
        [undefined, null],
        [125, null],
        [0, "SIGKILL"],
      ])
        expectUnverifiedLate(
          await ownedTestOnModel(st, { run: closeWith(status, kind) }),
          `status=${String(status)} signal=${String(kind)}`,
        );
    },
  );

  await t.test(
    "음성 대조: 숫자 0·무신호 정상 close(ID 형식 아님·생성 없음)면 빈 조회는 부재다",
    async (st) => {
      const settled = await ownedTestOnModel(st, {
        run: (args, proc, model) => {
          model.setTimeout(() => {
            proc.write("stdout", "not-a-container-id\n");
            proc.exit(0, null);
          }, 10);
          return "hang";
        },
      });
      assert.deepEqual(settled.model.signals, []);
      assert.deepEqual(settled.outcome.failures, [gate("OWNERSHIP")]);
      assert.deepEqual(settled.outcome.cleanup, {
        processGroupAbsent: true,
        containerAbsent: true,
      });
      assert.deepEqual(settled.closed, settled.pids);
      settled.model.runAll();
      assert.deepEqual(settled.docker.live(), []);
    },
  );
});

/**
 * runner 모델(두 겹) — 바깥 직접 child 는 xvfb-run(그룹 G), 그 안의 node runner 는 같은 그룹에서 바깥 stdio 를 쥔다.
 * runner 는 첫 TERM 을 controller.abort 로 받고(ci-e2e main 의 process.once), phase 마다 실제 privateLaunch 본문으로
 * 별도 detached Playwright 그룹을 돌린 뒤 phase finally(소요 cleanupMs)를 마쳐야 safe phase JSON 을 쓴다(runPhase).
 * 중단 뒤 phase 는 파일 없이 건너뛰고, 정리 도중 KILL 되면 그 phase 파일은 없다.
 */
function runnerModel(model, spec) {
  const inner = modelLaunch(model);
  const state = { outer: undefined, node: undefined, written: [] };
  async function runnerMain(node, stage, root) {
    const controller = new AbortController();
    node.onTerm = () => {
      node.onTerm = undefined;
      controller.abort();
    };
    let exitCode = 0;
    for (const phase of spec.phases) {
      if (controller.signal.aborted) {
        exitCode = 1;
        continue;
      }
      spec.during?.(phase, node);
      let childPid;
      const result = await inner(
        "pnpm",
        ["exec", "playwright", "test", phase],
        {
          cwd: root,
          stdio: "pipe",
          shell: false,
          detached: true,
          timeout: 3_600_000,
          signal: controller.signal,
        },
        (pid) => {
          childPid = pid;
        },
      );
      const failed = Boolean(result.error || result.signal || result.status !== 0);
      await model.sleep(spec.cleanupMs?.(phase) ?? 1000);
      if (!node.alive) return undefined;
      if (spec.writes === false) continue;
      const cleanup = spec.cleanup?.(phase) ?? {
        processGroupAbsent: !model.alive(childPid),
        forced: false,
        exactContainerAbsent: true,
        physicalProfileAbsent: true,
        portsAbsent: true,
      };
      const cleanupFailed = ![
        "processGroupAbsent",
        "exactContainerAbsent",
        "physicalProfileAbsent",
        "portsAbsent",
      ].every((key) => cleanup[key] === true);
      const record = phaseRecord(stage, phase, {
        childPid,
        status: failed || cleanupFailed ? "failed" : "passed",
        error: failed ? "PHASE_FAILED" : cleanupFailed ? "CLEANUP_FAILED" : undefined,
        execution: failed || cleanupFailed ? undefined : { required: 1 },
        cleanup,
        ...spec.record?.(phase),
      });
      writePhase(root, record, stage);
      state.written.push(phase);
      if (failed || cleanupFailed) exitCode = 1;
    }
    await model.sleep(spec.summaryMs ?? 500); // 최종 요약(pnpm --version·execution JSON)
    return node.alive ? exitCode : undefined;
  }
  const program = (proc, command, args, options) => {
    if (command !== "xvfb-run") {
      // 안쪽 Playwright child(별도 그룹).
      if (spec.playwrightIgnoresTerm) proc.onTerm = () => {};
      const ms = spec.playwrightMs?.(args.at(-1));
      if (ms !== undefined) model.setTimeout(() => proc.exit(0, null), ms);
      return;
    }
    const node = model.fork(proc);
    Object.assign(state, { outer: proc, node });
    if (spec.xvfbExitsAt !== undefined)
      model.setTimeout(() => proc.exit(0, null), spec.xvfbExitsAt);
    runnerMain(node, args.at(-1), options.cwd).then((code) => {
      if (code === undefined) return;
      node.exit(code, null);
      proc.exit(code, null);
    });
  };
  return { program, state };
}

/** QA-02 — 실제 owned-e2e 경계(runGates)와 runner 모델 안의 실제 privateLaunch 를 같은 모델 OS 위에서 실행한다. */
async function ownedE2EOnModel(t, spec) {
  const model = osModel();
  const runner = runnerModel(model, spec);
  model.program = runner.program;
  if (spec.spawnError) model.spawnError = (command) => command === "xvfb-run";
  const root = tempDir(t);
  spec.before?.(root);
  const controller = new AbortController();
  if (spec.abortAt !== undefined) model.setTimeout(() => controller.abort(), spec.abortAt);
  const closed = [];
  const results = await drive(
    model,
    runGates([gatesFor("m0").at(-1)], {
      root,
      env: { PATH: "synthetic-path" },
      signal: controller.signal,
      spawn: model.spawn,
      timers: model,
      kill: model.kill,
      platform: "linux",
      // 수정 전 본체는 owned-e2e 를 일반 privateLaunch 로 띄웠다 — 같은 모델에 연결해 두면 그 차이가 RED 로 보인다.
      launch: modelLaunch(model),
      closeGroup: (pid) => {
        closed.push(pid);
        return closeOwnedGroup(pid, model.killNow);
      },
      writePrivate: spec.writePrivate ?? privateSink(path.join(root, "private")),
      expectedPhases: () => spec.phases,
    }),
  );
  const gate = summarize("m0", { status: "passed" }, results).gates.at(-1);
  const signalsTo = (pid) =>
    model.signals.filter((s) => s.target === -pid).map(({ at, kind }) => [at, kind]);
  const outer = runner.state.outer;
  const playwright = model.spawns.filter((s) => s.command === "pnpm").map((s) => s.pid);
  return {
    gate,
    model,
    closed,
    root,
    written: runner.state.written,
    node: runner.state.node,
    outerSignals: outer ? signalsTo(outer.pid) : [],
    innerSignals: playwright.map(signalsTo),
  };
}

const E2E_VERIFIED = { processGroupAbsent: true, phaseCleanupVerified: true };
const E2E_UNVERIFIED = { processGroupAbsent: true, phaseCleanupVerified: false };
const e2eFailed = (cleanup, ...failures) => ({
  id: "owned-e2e",
  status: "failed",
  failures,
  cleanup,
});
const gateFailure = (code) => ({ boundary: "gate", code });
const CLEANUP_UNVERIFIED = { boundary: "cleanup", code: "CLEANUP_UNVERIFIED" };

test("QA-02 owned-e2e 전용 경계 — abort·timeout 은 TERM 1회 뒤 runner 의 phase 정리를 취소 예산(180초) 안에서 기다리고, 넘을 때만 자기 그룹 KILL 이며 그때는 미확인이다(두 겹 메모리 모델)", async (t) => {
  // 설계값을 시험에 따로 고정한다 — 본체 값이 바뀌거나 빠지면 아래 시각 기대가 함께 RED 다.
  const BUDGET = 180_000;
  const one = ["m0-direct-c"];

  await t.test("취소 대기 예산은 180초 설계값이다(전체 정리 상한의 증명이 아니다)", () => {
    assert.equal(TIMEOUTS.cancel, BUDGET);
  });

  await t.test(
    "정상(2 phase): 어떤 그룹에도 신호 0, 기대 phase 전부의 새 유효 파일 → 통과·정리 확인",
    async (st) => {
      const normal = await ownedE2EOnModel(st, {
        phases: ["m0-direct-c", "m0-direct-w"],
        playwrightMs: () => 60_000,
      });
      assert.deepEqual(normal.gate, { id: "owned-e2e", status: "passed", cleanup: E2E_VERIFIED });
      assert.deepEqual(normal.model.signals, []);
      assert.deepEqual(normal.written, ["m0-direct-c", "m0-direct-w"]);
    },
  );

  // 안쪽 launcher 의 TERM→2초 KILL→settle 뒤 runner 가 정리를 끝내 파일을 쓰고 close 하는 것을 관측한다.
  await t.test(
    "abort: TERM 무시 Playwright·30초 정리 — 바깥은 TERM 1회뿐(2초 KILL 없음), 정리 완료 close 관측",
    async (st) => {
      const cooperative = await ownedE2EOnModel(st, {
        phases: one,
        playwrightIgnoresTerm: true,
        cleanupMs: () => 30_000,
        abortAt: 10_000,
      });
      assert.deepEqual(cooperative.outerSignals, [[10_000, "SIGTERM"]]);
      assert.deepEqual(cooperative.innerSignals, [
        [
          [10_000, "SIGTERM"],
          [12_000, "SIGKILL"],
        ],
      ]);
      assert.deepEqual(cooperative.written, one);
      assert.equal(cooperative.node.alive, false);
      assert.deepEqual(cooperative.gate, e2eFailed(E2E_VERIFIED, gateFailure("ABORTED")));
      const state = readdirSync(path.join(cooperative.root, "private")).find((name) =>
        name.endsWith("-main-state.json"),
      );
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(cooperative.root, "private", state), "utf8")),
        {
          status: null,
          signal: "SIGTERM",
          closed: true,
          pid: cooperative.closed[0],
          closeObserved: true,
          termSent: true,
          forced: false,
        },
      );
    },
  );

  await t.test("안쪽 정리 실패(포트 미확인): 원 abort 와 별도로 확인된 정리 실패", async (st) => {
    const cleanupFailure = await ownedE2EOnModel(st, {
      phases: one,
      playwrightIgnoresTerm: true,
      cleanupMs: () => 30_000,
      abortAt: 10_000,
      cleanup: () => ({
        processGroupAbsent: true,
        forced: false,
        exactContainerAbsent: true,
        physicalProfileAbsent: true,
        portsAbsent: false,
      }),
    });
    assert.deepEqual(
      cleanupFailure.gate,
      e2eFailed(E2E_UNVERIFIED, gateFailure("ABORTED"), {
        boundary: "cleanup",
        code: "CLEANUP_FAILED",
      }),
    );
  });

  await t.test(
    "예산 초과(정리 400초): TERM 뒤 정확히 180초에만 자기 그룹 KILL — 진행 phase 파일 없음 = 미확인",
    async (st) => {
      const over = await ownedE2EOnModel(st, {
        phases: one,
        playwrightIgnoresTerm: true,
        cleanupMs: () => 400_000,
        abortAt: 10_000,
      });
      assert.deepEqual(over.outerSignals, [
        [10_000, "SIGTERM"],
        [10_000 + BUDGET, "SIGKILL"],
      ]);
      assert.deepEqual(over.written, []);
      assert.deepEqual(
        over.gate,
        e2eFailed(E2E_UNVERIFIED, gateFailure("ABORTED"), CLEANUP_UNVERIFIED),
      );
    },
  );

  // 6 phase(안쪽 1시간 timeout 이 앞 5개를 끝낸다) 중 6번째 진행 중에 바깥 330분 timeout.
  const six = ["core-c", "persistent-c", "core-w", "native-c", "historical-c", "native-w"];
  await t.test(
    "timeout(330분)도 같은 협력 취소 — 예산 안 정리면 6개 파일 전부로 확인",
    async (st) => {
      const timeoutCooperative = await ownedE2EOnModel(st, {
        phases: six,
        cleanupMs: (phase) => (phase === "native-w" ? 30_000 : 1_000),
      });
      assert.deepEqual(timeoutCooperative.outerSignals, [[TIMEOUTS.e2e, "SIGTERM"]]);
      assert.deepEqual(timeoutCooperative.written, six);
      assert.deepEqual(timeoutCooperative.gate, e2eFailed(E2E_VERIFIED, gateFailure("TIMEOUT")));
    },
  );

  await t.test("timeout + 예산 초과: 앞 5개의 true 만 남은 입력은 미확인", async (st) => {
    const timeoutOver = await ownedE2EOnModel(st, {
      phases: six,
      cleanupMs: (phase) => (phase === "native-w" ? 400_000 : 1_000),
    });
    assert.deepEqual(timeoutOver.outerSignals, [
      [TIMEOUTS.e2e, "SIGTERM"],
      [TIMEOUTS.e2e + BUDGET, "SIGKILL"],
    ]);
    assert.deepEqual(timeoutOver.written, six.slice(0, 5));
    assert.deepEqual(
      timeoutOver.gate,
      e2eFailed(E2E_UNVERIFIED, gateFailure("TIMEOUT"), CLEANUP_UNVERIFIED),
    );
  });
});

test("QA-02 모든 종료 원인 — output-limit·스트림 I/O·exit 뒤 열린 stdio 도 같은 협력 취소이고, spawn 오류·spawn 전 중단·private 기록 실패도 정리를 성공으로 만들지 않는다(두 겹 메모리 모델)", async (t) => {
  const two = ["m0-direct-c", "m0-direct-w"];
  await t.test(
    "output-limit: 17MiB×2 — 32MiB 를 넘는 순간 TERM 1회, 계속 읽으며 정리를 기다린다",
    async (st) => {
      const overflow = await ownedE2EOnModel(st, {
        phases: two,
        cleanupMs: () => 30_000,
        during: (phase, node) => {
          if (phase !== two[0]) return;
          node.write("stdout", Buffer.alloc(17 * 1024 * 1024, 120));
          node.write("stdout", Buffer.alloc(17 * 1024 * 1024, 120));
        },
      });
      assert.deepEqual(overflow.outerSignals, [[0, "SIGTERM"]]);
      assert.deepEqual(overflow.written, [two[0]]);
      assert.deepEqual(
        overflow.gate,
        e2eFailed(E2E_UNVERIFIED, gateFailure("OUTPUT_LIMIT"), CLEANUP_UNVERIFIED),
      );
    },
  );

  await t.test("스트림 I/O 오류(PRIVATE_IO): 같은 협력 취소 — 조기 KILL 없음", async (st) => {
    const streamError = await ownedE2EOnModel(st, {
      phases: two,
      cleanupMs: () => 30_000,
      during: (phase, node) => {
        if (phase === two[0]) node.pipes[0].child.stdout.emit("error", new Error("EPIPE"));
      },
    });
    assert.deepEqual(streamError.outerSignals, [[0, "SIGTERM"]]);
    assert.deepEqual(streamError.written, [two[0]]);
    assert.deepEqual(
      streamError.gate,
      e2eFailed(E2E_UNVERIFIED, gateFailure("PRIVATE_IO"), CLEANUP_UNVERIFIED),
    );
  });

  await t.test(
    "child error(실행 중인 소유 runner): 같은 협력 취소 — 조기 KILL 없음",
    async (st) => {
      const childError = await ownedE2EOnModel(st, {
        phases: two,
        cleanupMs: () => 30_000,
        during: (phase, node) => {
          if (phase === two[0]) node.pipes[0].child.emit("error", new Error("EPERM"));
        },
      });
      assert.deepEqual(childError.outerSignals, [[0, "SIGTERM"]]);
      assert.deepEqual(childError.written, [two[0]]);
      assert.deepEqual(
        childError.gate,
        e2eFailed(E2E_UNVERIFIED, gateFailure("CHILD_FAILED"), CLEANUP_UNVERIFIED),
      );
    },
  );

  // xvfb-run 이 먼저 끝나도 runner 가 stdio 를 쥔 채 일한다.
  await t.test(
    "exit 뒤 열린 stdio: 2초 drain 뒤 TERM 1회 협력 취소, runner 의 정리 완료 close 관측(조기 KILL 없음)",
    async (st) => {
      const openStdio = await ownedE2EOnModel(st, {
        phases: [two[0]],
        xvfbExitsAt: 5_000,
        cleanupMs: () => 30_000,
      });
      assert.deepEqual(openStdio.outerSignals, [[7_000, "SIGTERM"]]);
      assert.deepEqual(openStdio.written, [two[0]]);
      assert.deepEqual(openStdio.gate, e2eFailed(E2E_VERIFIED, gateFailure("CHILD_FAILED")));
    },
  );

  await t.test(
    "spawn 오류: 소유 PID 없음 — 신호 0, 바깥 그룹 부재도 안쪽 정리도 확인된 것이 아니다",
    async (st) => {
      const unspawned = await ownedE2EOnModel(st, { phases: two, spawnError: true });
      assert.deepEqual(unspawned.model.signals, []);
      assert.deepEqual(unspawned.closed, []);
      assert.deepEqual(
        unspawned.gate,
        e2eFailed(
          { processGroupAbsent: false, phaseCleanupVerified: false },
          gateFailure("SPAWN_FAILED"),
          CLEANUP_UNVERIFIED,
        ),
      );
    },
  );

  await t.test(
    "private 기록 실패(settle 뒤): PRIVATE_IO 실패 유지, 정리 판정은 계속(확인이 실패를 통과로 바꾸지 않음)",
    async (st) => {
      const unrecorded = await ownedE2EOnModel(st, {
        phases: [two[0]],
        playwrightMs: () => 1_000,
        writePrivate: () => {
          throw new Error("EACCES");
        },
      });
      assert.deepEqual(unrecorded.model.signals, []);
      assert.deepEqual(unrecorded.gate, e2eFailed(E2E_VERIFIED, gateFailure("PRIVATE_IO")));
    },
  );

  await t.test("spawn 전 중단: runner 를 만들지 않는다(owned-e2e not-run)", async () => {
    const model = osModel();
    const controller = new AbortController();
    controller.abort();
    const results = await runGates([gatesFor("m0").at(-1)], {
      signal: controller.signal,
      spawn: model.spawn,
      launch: modelLaunch(model),
      writePrivate: () => {},
    });
    assert.equal(results.size, 0);
    assert.deepEqual(model.spawns, []);
  });
});

test("QA-02 증거 완전성 — 앞 phase 의 true·과거 파일·다른 stage 귀속·중단 뒤 건너뛴 phase·강제 종료는 이번 호출 전체의 정리 확인이 아니다", async (t) => {
  const two = ["m0-direct-c", "m0-direct-w"];
  const BUDGET = 180_000;
  await t.test(
    "앞 phase 만 true: 진행 중 phase 정리가 예산을 넘어 그 증거가 없으면 미확인",
    async (st) => {
      const earlier = await ownedE2EOnModel(st, {
        phases: two,
        playwrightMs: (phase) => (phase === two[0] ? 60_000 : undefined),
        cleanupMs: (phase) => (phase === two[0] ? 1_000 : 400_000),
        abortAt: 100_000,
      });
      assert.deepEqual(earlier.written, [two[0]]);
      assert.deepEqual(earlier.outerSignals, [
        [100_000, "SIGTERM"],
        [100_000 + BUDGET, "SIGKILL"],
      ]);
      assert.deepEqual(
        earlier.gate,
        e2eFailed(E2E_UNVERIFIED, gateFailure("ABORTED"), CLEANUP_UNVERIFIED),
      );
    },
  );

  // 현재 자료로는 완전성을 증명하지 못해 미확인이다(채택한 보수 판정 — 열린 공백 ①).
  await t.test("예산 안 협력 정리라도 중단 뒤 건너뛴 phase 는 파일이 없어 미확인", async (st) => {
    const skipped = await ownedE2EOnModel(st, {
      phases: two,
      cleanupMs: () => 30_000,
      abortAt: 10_000,
    });
    assert.deepEqual(skipped.outerSignals, [[10_000, "SIGTERM"]]);
    assert.deepEqual(skipped.written, [two[0]]);
    assert.deepEqual(
      skipped.gate,
      e2eFailed(E2E_UNVERIFIED, gateFailure("ABORTED"), CLEANUP_UNVERIFIED),
    );
  });

  await t.test(
    "정상 close 를 못 본 호출: phase 파일이 전부 유효해도 최종 요약 단계에서 예산을 넘겨 KILL 되면 미확인",
    async (st) => {
      const killedAfter = await ownedE2EOnModel(st, {
        phases: two,
        playwrightMs: () => 1_000,
        summaryMs: 400_000,
        abortAt: 10_000,
      });
      assert.deepEqual(killedAfter.written, two);
      assert.deepEqual(killedAfter.outerSignals, [
        [10_000, "SIGTERM"],
        [10_000 + BUDGET, "SIGKILL"],
      ]);
      assert.deepEqual(
        killedAfter.gate,
        e2eFailed(E2E_UNVERIFIED, gateFailure("ABORTED"), CLEANUP_UNVERIFIED),
      );
    },
  );

  await t.test(
    "과거 파일만: gate 시작 전 유효 모양 파일은 이번 호출의 증거가 아니다 — 정상 exit 여도 미확인",
    async (st) => {
      const past = await ownedE2EOnModel(st, {
        phases: two,
        playwrightMs: () => 1_000,
        writes: false,
        before: (root) => {
          for (const phase of two)
            writePhase(root, phaseRecord("m0", phase, { finishedAt: "2026-01-01T00:00:00.000Z" }));
        },
      });
      assert.deepEqual(past.model.signals, []);
      assert.deepEqual(past.gate, e2eFailed(E2E_UNVERIFIED, CLEANUP_UNVERIFIED));
    },
  );

  await t.test(
    "다른 stage 귀속(같은 디렉터리·이름 규칙): 본문 stage 가 다르면 이번 호출의 증거가 아니다",
    async (st) => {
      const otherStage = await ownedE2EOnModel(st, {
        phases: two,
        playwrightMs: () => 1_000,
        record: () => ({ stage: "product" }),
      });
      assert.deepEqual(otherStage.written, two);
      assert.deepEqual(otherStage.gate, e2eFailed(E2E_UNVERIFIED, CLEANUP_UNVERIFIED));
    },
  );
});

test("phase 정리 판정(순수) — 기대 phase 마다 유효·귀속 파일 1개와 정리 4종 true 일 때만 확인이고, 그 밖은 고정 문제 id 다", () => {
  const judge = (files) =>
    ciM0.phaseCleanupProblems({
      files,
      expected: ["m0-direct-c", "m0-direct-w"],
      stage: "m0",
      startedAt: Date.parse("2026-10-18T00:00:00.000Z"),
      endedAt: Date.parse("2026-10-18T01:00:00.000Z"),
    });
  const file = (phase, change = {}, name) => {
    const record = phaseRecord("m0", phase, { finishedAt: "2026-10-18T00:30:00.000Z", ...change });
    return { name: name ?? `${phase}-${record.run}.json`, text: JSON.stringify(record, null, 2) };
  };
  const truncated = (entry) => ({ ...entry, text: entry.text.slice(0, 40) });
  const cleanup = (change) => ({
    cleanup: {
      processGroupAbsent: true,
      forced: false,
      exactContainerAbsent: true,
      physicalProfileAbsent: true,
      portsAbsent: true,
      ...change,
    },
  });
  const failed = (error) => ({ status: "failed", error, execution: undefined });
  const summaryFile = () => ({ name: `execution-${randomUUID()}.json`, text: "{}" });
  const [c, w] = ["m0-direct-c", "m0-direct-w"];
  const run = randomUUID();
  for (const [label, files, problems] of [
    ["기대 phase 전부 유효", [file(c), file(w)], []],
    ["최종 요약 파일은 증거로 쓰지 않는다", [file(c), file(w), summaryFile()], []],
    ["실패 phase 라도 정리 4종 true 면 확인", [file(c, failed("PHASE_FAILED")), file(w)], []],
    ["앞 phase 만", [file(c)], ["missing"]],
    ["새 파일 없음", [], ["missing", "missing"]],
    ["최종 요약만", [summaryFile()], ["missing", "missing"]],
    ["같은 phase 두 파일", [file(c), file(c), file(w)], ["duplicate"]],
    ["두 phase 가 같은 run", [file(c, { run }), file(w, { run })], ["duplicate", "missing"]],
    ["기대 밖 phase", [file("core-c"), file(c), file(w)], ["unexpected-file"]],
    ["이름 규칙 밖", [{ name: `${c}.json`, text: "{}" }, file(c), file(w)], ["unexpected-file"]],
    ["부분 JSON", [truncated(file(c)), file(w)], ["invalid", "missing"]],
    ["객체가 아닌 JSON", [{ ...file(c), text: "null" }, file(w)], ["invalid", "missing"]],
    [
      "이름과 본문 run 불일치",
      [file(c, {}, `${c}-${randomUUID()}.json`), file(w)],
      ["invalid", "missing"],
    ],
    ["다른 stage", [file(c, { stage: "product" }), file(w)], ["invalid", "missing"]],
    ["다른 owner", [file(c, { owner: OWNER }), file(w)], ["invalid", "missing"]],
    ["다른 purpose", [file(c, { purpose: PURPOSE }), file(w)], ["invalid", "missing"]],
    ["허용 밖 키", [file(c, { raw: DEV_URL }), file(w)], ["invalid", "missing"]],
    [
      "정리 값이 boolean 아님",
      [file(c, cleanup({ portsAbsent: "true" })), file(w)],
      ["invalid", "missing"],
    ],
    ["허용 밖 정리 키", [file(c, cleanup({ pid: 7100 })), file(w)], ["invalid", "missing"]],
    ["공개 code 가 아닌 error", [file(c, failed("EACCES")), file(w)], ["invalid", "missing"]],
    ["passed 인데 error", [file(c, { error: "PHASE_FAILED" }), file(w)], ["invalid", "missing"]],
    ["containerId 형식", [file(c, { containerId: "abc" }), file(w)], ["invalid", "missing"]],
    ["database 형식", [file(c, { database: "afc" }), file(w)], ["invalid", "missing"]],
    ["principal 형식", [file(c, { principal: "dev-user" }), file(w)], ["invalid", "missing"]],
    ["시각 형식", [file(c, { finishedAt: "yesterday" }), file(w)], ["invalid", "missing"]],
    [
      "시작 전 시각(과거 run)",
      [file(c, { finishedAt: "2026-10-17T23:59:59.999Z" }), file(w)],
      ["stale", "missing"],
    ],
    [
      "끝난 뒤 시각(다른 호출)",
      [file(c, { finishedAt: "2026-10-18T01:00:00.001Z" }), file(w)],
      ["stale", "missing"],
    ],
    [
      "runner 가 정리 실패 기록(false)",
      [file(c, cleanup({ portsAbsent: false })), file(w)],
      ["cleanup-failed"],
    ],
    [
      "runner 가 정리 실패 code 기록",
      [file(c, failed("CLEANUP_FAILED")), file(w)],
      ["cleanup-failed"],
    ],
    [
      "정리 키 누락(확인 안 됨)",
      [
        file(c, {
          cleanup: { processGroupAbsent: true, exactContainerAbsent: true, portsAbsent: true },
        }),
        file(w),
      ],
      ["cleanup-unconfirmed"],
    ],
  ])
    assert.deepEqual(judge(files), problems, label);

  // 기대 phase 는 runner 의 선택과 같다 — manifest 의 stage 행이 고르는 runner phase(실행 순서).
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "apps", "web", "e2e", "ci-manifest.json"), "utf8"),
  );
  for (const stage of ["m0", "product"]) {
    const rows = manifest.cases.filter((row) => stage === "product" || row.stage === stage);
    assert.deepEqual(
      ciM0.expectedPhases(ROOT, stage),
      runnerPhases
        .filter((phase) => rows.some((row) => row.phase === phase.name))
        .map((p) => p.name),
      stage,
    );
  }
  assert.deepEqual(ciM0.expectedPhases(ROOT, "m0"), [
    "m0-direct-c",
    "m0-direct-w",
    "m0-proxy-c",
    "m0-proxy-w",
  ]);
});

test("공개 상태 허용 목록 — code 17개·정리 boolean 3종만 공개하고 원 필드·PID·경로·문제 목록은 싣지 않는다", () => {
  assert.deepEqual(
    [...CODES],
    [
      "UNKNOWN_ARGUMENT",
      "UNSUPPORTED_RUNNER",
      "MISSING_INSTALL",
      "SPAWN_FAILED",
      "CHILD_FAILED",
      "TIMEOUT",
      "ABORTED",
      "OUTPUT_LIMIT",
      "PRIVATE_IO",
      "TEST_REGISTRATION",
      "CODEGEN_UNTRACKED",
      "CODEGEN_EMPTY",
      "CODEGEN_DRIFT",
      "OWNERSHIP",
      "CLEANUP_FAILED",
      "CLEANUP_UNVERIFIED",
      "OPERATION_FAILED",
    ],
  );
  assert.ok(Object.isFrozen(CODES));
  assert.equal(rootCode({ code: "CLEANUP_UNVERIFIED" }), "CLEANUP_UNVERIFIED");
  const hostile = new Map([
    [
      "owned-test",
      {
        status: "passed",
        cleanup: { processGroupAbsent: true, containerAbsent: "yes", pid: 4242 },
      },
    ],
    [
      "owned-e2e",
      {
        status: "failed",
        failures: [{ boundary: "cleanup", code: "CLEANUP_UNVERIFIED", problems: ["missing"] }],
        cleanup: {
          processGroupAbsent: true,
          phaseCleanupVerified: 1,
          forced: true,
          pid: 4242,
          path: DEV_URL,
          problems: ["missing"],
        },
      },
    ],
  ]);
  const { gates } = summarize("m0", { status: "passed" }, hostile);
  assert.deepEqual(gates.at(-2), {
    id: "owned-test",
    status: "passed",
    cleanup: { processGroupAbsent: true, containerAbsent: false },
  });
  assert.deepEqual(gates.at(-1), {
    id: "owned-e2e",
    status: "failed",
    failures: [{ boundary: "cleanup", code: "CLEANUP_UNVERIFIED" }],
    cleanup: { processGroupAbsent: true, phaseCleanupVerified: false },
  });
  for (const gate of gates)
    for (const key of Object.keys(gate.cleanup ?? {}))
      assert.ok(["processGroupAbsent", "containerAbsent", "phaseCleanupVerified"].includes(key));
  assert.doesNotMatch(JSON.stringify(gates), /4242|problems|forced|postgres|missing/);
});
