/**
 * M0 root 명령 본체 — `pnpm ci:m0`(공통 gate 1회 + owned m0)·`pnpm ci:product`(같은 공통 gate 1회 + owned product).
 *
 *   node scripts/ci-m0.mjs                  (= pnpm ci:m0)
 *   node scripts/ci-m0.mjs --stage product  (= pnpm ci:product — 다른 점은 마지막 owned phase 실행의 stage 뿐)
 *
 * 실제 전체 실행은 GitHub Actions 의 disposable Linux/Node20/Xvfb 에서만 지원한다(ci-e2e.mjs 와 같은 runner guard).
 * 그 밖 환경은 어떤 child·자원보다 먼저 UNSUPPORTED_RUNNER 로 실패한다 — 성공·skip·부분 실행으로 바꾸는 옵션은 없다.
 * install 은 부르지 않는다: checkout/workflow 의 선행 1회가 전제이고, 흔적이 없으면 MISSING_INSTALL 로 실패한다.
 * 모든 child 의 stdout/stderr 는 처음부터 private 파일로만 간다. 공개 출력은 stdout 한 줄 JSON — 고정 gate id·상태·
 * 정규화 code·정리 확인값뿐이고, 원 오류·argv·env·자유형 message 는 넣지 않는다.
 * import 만으로는 아무것도 실행하지 않는다.
 */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { URL, fileURLToPath } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { closeOwnedGroup, phases, privateLaunch, withCleanup } from "./ci-e2e.mjs";
import { loadManifest, requiredCases, safeCode } from "./ci-e2e.manifest.mjs";
const { AbortController } = globalThis;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINUTE = 60_000;
const LOOPBACK = "127.0.0.1";
const PGDATA = "/var/lib/postgresql/data";
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const OWNED_DATABASE = /^afc_ci_m0_[0-9a-f]{8}_test$/;
/** 개발·공용·phase DB 이름 — 형식이 맞아 보여도 대상이 될 수 없다. */
const SHARED_DATABASES = new Set([
  "afc",
  "afc_test",
  "afc_e2e",
  "postgres",
  "template0",
  "template1",
]);
/** .env 는 자기 소유 대상의 근거가 아니다 — 있으면 API 시험이 주입하지 않은 키를 읽는다. */
const DOTENV = Object.freeze([".env", "apps/api/.env", "apps/web/.env"]);
/** 부모 env 에서 물려받지 않는 키: DB·비밀·실행 신원·런타임 모드. child 에는 주입값만 들어간다. */
const NOT_INHERITED =
  /^(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|FIELD_ENCRYPTION_KEY|DEV_USER_ID|AUTH_MODE|NODE_ENV|PORT|WEB_ORIGIN|NODE_OPTIONS|AFC_.*|E2E_.*|PG.*)$/i;
const READY_ATTEMPTS = 60;

export const STAGES = Object.freeze(["m0", "product"]);
/** 필수 node 시험 — 기존 4파일과 이 본체의 자체 시험. 목록에서 빠진 시험은 이 gate 가 돌리지 않는다. */
export const NODE_TESTS = Object.freeze([
  "scripts/rebuild-bootstrap.test.mjs",
  "scripts/rebuild-fixtures.test.mjs",
  "scripts/ci-e2e.test.mjs",
  "scripts/ci-e2e.manifest.test.mjs",
  "scripts/ci-m0.test.mjs",
]);
/**
 * 이 본체의 자체 시험 — NODE_TESTS 와 따로 모듈 위치에서 구한다. 자체 시험이 목록에서 빠지면 그것을 잡을 시험도
 * 돌지 않으므로, 필수 node gate 가 child 없이 TEST_REGISTRATION 으로 RED 가 된다.
 */
export const SELF_TEST = path
  .relative(ROOT, fileURLToPath(new URL("./ci-m0.test.mjs", import.meta.url)))
  .split(path.sep)
  .join("/");
export const CODEGEN_OUTPUT = "apps/web/lib/api-types.ts";
/** pnpm install 1회의 흔적. 본체는 install 을 부르지 않는다. */
export const INSTALL_MARKERS = Object.freeze([
  "node_modules/.modules.yaml",
  "apps/api/node_modules",
  "apps/web/node_modules",
  "packages/shared/node_modules",
]);
/** API 시험의 고정 "오늘"(ADR-50) — 대상 DB·실행 신원과 함께 child process env 로만 준다. */
export const TEST_TODAY = "2026-08-14";
/** owned `_test` 자원 라벨. phase `_e2e`(automation-m0-06·owned-e2e)와 겹치지 않는다. */
export const OWNER = "ci-m0-root";
export const PURPOSE = "owned-test";
/**
 * cancel 은 owned-e2e 의 취소 대기 예산(설계값)이다 — runner 에 TERM 1회 뒤 그 close 를 기다리는 상한이고, 안쪽
 * 정리 전체의 상한을 증명하지 않는다(cleanContainer 의 docker 4호출×60s·준비 구간의 sync 호출·독립 deadline 이 없는
 * cleanPhysical/freePort). 넘으면 정확한 자기 그룹만 KILL 하고, 안쪽 정리는 확인되지 않은 실패다.
 */
export const TIMEOUTS = Object.freeze({
  gate: 60 * MINUTE,
  docker: 5 * MINUTE,
  test: 120 * MINUTE,
  e2e: 330 * MINUTE,
  cancel: 3 * MINUTE,
});
/** owned-e2e 경계의 출력 상한(privateLaunch 와 같은 양 스트림 합)·exit 뒤 stdio drain·KILL 뒤 settle. */
const OUTPUT_LIMIT = 32 * 1024 * 1024;
const DRAIN_MS = 2000;
const FINAL_SETTLE_MS = 5000;
/** 공개 summary 가 쓸 수 있는 code 전부. 그 밖 값(원 오류의 code·message)은 OPERATION_FAILED 로 바뀐다. */
export const CODES = Object.freeze([
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
  // 정리 실패를 확인한 것이 아니라 정리 완료를 확인하지 못했다(미등록 child·뒤늦은 생성 가능성·phase 증거 불완전).
  "CLEANUP_UNVERIFIED",
  "OPERATION_FAILED",
]);

const coded = (code) => Object.assign(new Error(code), { code });

/** 원 오류 객체를 믿지 않는다 — 이 본체의 고정 code 만 통과시킨다(필드 getter 가 던져도 fallback). */
export function rootCode(error, fallback = "OPERATION_FAILED") {
  try {
    const code = error?.code;
    return typeof code === "string" && CODES.includes(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

const nodeGate = (id, ...args) =>
  Object.freeze({ id, command: process.execPath, args: Object.freeze(args) });
const pnpmGate = (id, ...args) => Object.freeze({ id, command: "pnpm", args: Object.freeze(args) });

/** 공통 gate — tech §11 순서이고 기존 workflow 의 개별 step 과 1:1 이다. 두 명령 모두 이 목록을 1회만 돈다. */
export const COMMON_GATES = Object.freeze([
  nodeGate("bootstrap", "scripts/rebuild-bootstrap.mjs"),
  nodeGate("fixtures", "scripts/rebuild-fixtures.mjs"),
  pnpmGate("api-types", "exec", "tsc", "-p", "scripts/tsconfig.rebuild-api-types.json", "--noEmit"),
  pnpmGate("codegen", "codegen"),
  // 생성물이 실제 tracked 파일로 존재하고 비어 있지 않으며 실행 후 drift 0 인지 함께 본다.
  Object.freeze({ id: "codegen-drift", codegen: CODEGEN_OUTPUT }),
  pnpmGate("typecheck", "typecheck"),
  Object.freeze({ ...nodeGate("node-tests", "--test", ...NODE_TESTS), requires: SELF_TEST }),
  nodeGate("discovery-product", "scripts/ci-e2e.manifest.mjs", "--stage", "product"),
  nodeGate("discovery-m0", "scripts/ci-e2e.manifest.mjs", "--stage", "m0"),
  pnpmGate("lint", "lint"),
  pnpmGate("format", "format:check"),
  pnpmGate("build", "build"),
  pnpmGate("verify-no-test-seed", "--filter", "web", "verify:no-test-seed"),
  pnpmGate("verify-contrast", "--filter", "web", "verify:contrast"),
  pnpmGate("verify-font-payload", "--filter", "web", "verify:font-payload"),
]);
export const GATE_IDS = Object.freeze([
  ...COMMON_GATES.map((gate) => gate.id),
  "owned-test",
  "owned-e2e",
]);

/** ci:m0 와 ci:product 는 마지막 owned phase 실행(xvfb-run 아래 ci-e2e.mjs)의 stage 만 다르다. */
export function gatesFor(stage) {
  if (!STAGES.includes(stage)) throw coded("UNKNOWN_ARGUMENT");
  return Object.freeze([
    ...COMMON_GATES,
    Object.freeze({ id: "owned-test", ownedTest: true }),
    Object.freeze({
      id: "owned-e2e",
      ownedE2E: true,
      command: "xvfb-run",
      args: Object.freeze([
        "--auto-servernum",
        process.execPath,
        "scripts/ci-e2e.mjs",
        "--stage",
        stage,
      ]),
      timeout: TIMEOUTS.e2e,
    }),
  ]);
}

/** 인자 없음 = m0, `--stage m0|product` 만. 그 밖(부분 실행·skip 옵션 포함)은 전부 거부한다. */
export function parseArgs(argv) {
  if (argv.length === 0) return { stage: "m0" };
  if (argv.length === 2 && argv[0] === "--stage" && STAGES.includes(argv[1]))
    return { stage: argv[1] };
  throw coded("UNKNOWN_ARGUMENT");
}

/** ci-e2e.mjs main 과 같은 runner guard. 어떤 child·자원보다 먼저 확인한다. */
export function checkRunner({ env, platform }) {
  if (env?.GITHUB_ACTIONS !== "true" || platform !== "linux") throw coded("UNSUPPORTED_RUNNER");
}

/** install 은 선행 1회가 전제다 — 흔적이 없으면 고치지 않고(install 호출 0) 실패한다. */
export function checkInstall(root, exists = existsSync) {
  if (!INSTALL_MARKERS.every((marker) => exists(path.join(root, ...marker.split("/")))))
    throw coded("MISSING_INSTALL");
}

/** private 경로는 한 번 정하고 디렉터리는 처음 쓸 때 만든다(0700/0600, 덮어쓰기 금지). */
export function privateSink(dir = path.join(tmpdir(), `afc-ci-m0-private-${randomUUID()}`)) {
  return (name, data) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, name), data, { flag: "wx", mode: 0o600 });
  };
}

/** privateLaunch 결과 → 고정 code(null 이면 성공). 원 오류 필드는 신뢰하지 않는다. */
export function launchFailure(result, signal) {
  try {
    if (signal?.aborted) return "ABORTED";
    const error = result?.error;
    if (error?.code === "ETIMEDOUT") return "TIMEOUT";
    if (error?.code === "OUTPUT_LIMIT" || error?.code === "PRIVATE_IO") return error.code;
    if (error && String(error.syscall ?? "").startsWith("spawn")) return "SPAWN_FAILED";
    if (error || result?.signal || result?.status !== 0) return "CHILD_FAILED";
    return null;
  } catch {
    return "CHILD_FAILED";
  }
}

/** 순서 번호를 붙인 private 이름 — 같은 sink 에서도 겹치지 않는다(wx). */
function sequence(prefix) {
  let count = 0;
  return (step) => {
    count += 1;
    return `${prefix}-${String(count).padStart(3, "0")}-${step}`;
  };
}

/** child 1개의 양 스트림·상태·원 오류를 private 파일에만 쓴다. 하나라도 못 쓰면 false 다. */
function recordPrivately(io, name, result, extra = {}) {
  try {
    io.writePrivate(`${name}-stdout.txt`, result?.stdout ?? "");
    io.writePrivate(`${name}-stderr.txt`, result?.stderr ?? "");
    io.writePrivate(
      `${name}-state.json`,
      JSON.stringify({
        status: result?.status ?? null,
        signal: result?.signal ?? null,
        closed: result?.closed === true,
        pid: result?.pid ?? null,
        ...extra,
      }),
    );
    if (result?.error !== undefined)
      io.writePrivate(`${name}-error.txt`, String(result.error?.stack ?? result.error));
    return true;
  } catch {
    return false;
  }
}

/**
 * child 1개를 privateLaunch 경계로 실행한다 — 관리 child(docker 포함) 전부 detached 소유 그룹이다. 시작한 child 는
 * io.launches 에 기록하고 onSpawn 으로 받은 소유 PID 는 io.pids 에 남겨, 호출자의 정리가 PID 그룹 부재를 확인하게
 * 한다. PID 를 받지 못한 기록은 부재 증거가 아니다(allOwned). 중단 뒤에는 child 를 만들지 않는다.
 * private 쓰기 실패는 PRIVATE_IO 다.
 */
async function launchPrivately(io, name, command, args, { env, timeout }) {
  const launch = io.signal?.aborted ? undefined : { name, pid: undefined, settled: false };
  let result = { status: null, error: coded("ABORTED") };
  if (launch) {
    io.launches.push(launch);
    try {
      result = await io.launch(
        command,
        args,
        {
          cwd: io.root,
          env,
          stdio: "pipe",
          shell: false,
          windowsHide: true,
          detached: true,
          timeout,
          signal: io.signal,
        },
        (pid) => {
          launch.pid = pid;
          io.pids.push(pid);
        },
      );
    } catch (error) {
      result = { status: null, error };
    }
    // 생성 요청이 스스로 끝난 증거는 숫자 status 0·무신호 정상 close 뿐이다. timeout·abort·외부 신호 종료·
    // null/undefined/nonzero status 는 docker CLI 의 요청이 daemon 에서 끝났다는 증거가 아니다(오류 없이 close 해도).
    launch.settled =
      result?.closed === true &&
      result?.error === undefined &&
      result?.status === 0 &&
      (result?.signal === null || result?.signal === undefined);
  }
  if (!recordPrivately(io, name, result)) throw coded("PRIVATE_IO");
  return result;
}

/** 시작한 child 가 전부 소유 PID 를 남겼는가 — 아니면 빈 PID 목록·그룹 부재 확인은 그 child 의 종료 증거가 아니다. */
const allOwned = (io) => io.launches.every((launch) => launch.pid !== undefined);

/** 등록된 소유 그룹을 전부(하나가 실패해도 나머지까지) 닫고 부재를 확인한다. 닫은 PID 는 목록에서 뺀다. */
async function closeRegistered(io, closeGroup) {
  let failed = false;
  while (io.pids.length > 0) {
    try {
      await closeGroup(io.pids.shift());
    } catch {
      failed = true;
    }
  }
  if (failed) throw coded("CLEANUP_FAILED");
}

/** docker CLI 도 root 관리 child 다 — 같은 private·소유 그룹 경계로 실행하고 출력은 판정에만 쓴다. */
async function docker(io, env, step, ...args) {
  const result = await launchPrivately(io, io.name(step), "docker", args, {
    env,
    timeout: TIMEOUTS.docker,
  });
  const code = launchFailure(result, io.signal);
  if (code)
    throw coded(["ABORTED", "TIMEOUT", "PRIVATE_IO"].includes(code) ? code : "OPERATION_FAILED");
  return Buffer.from(result.stdout ?? "")
    .toString("utf8")
    .trim();
}

/** TCP 로 받는 최종 서버(초기화용 임시 서버는 TCP 를 열지 않는다)와 그 안의 대상 DB 를 확인한다. */
async function waitReady(io, env, id, database, wait) {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    if (io.signal?.aborted) throw coded("ABORTED");
    const ready = await launchPrivately(
      io,
      io.name("pg-isready"),
      "docker",
      ["exec", id, "pg_isready", "-h", LOOPBACK, "-p", "5432", "-U", "postgres", "-d", database],
      { env, timeout: TIMEOUTS.docker },
    );
    if (launchFailure(ready, io.signal) === null) {
      return docker(
        io,
        env,
        "current-database",
        "exec",
        id,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-tAc",
        "select current_database()",
      );
    }
    await wait(1000);
  }
  throw coded("OPERATION_FAILED");
}

/** docker inspect 에서 판정에 쓰는 사실만 꺼낸다(Config.Env 의 비밀번호는 담지 않는다). */
function targetFacts(info, currentDatabase) {
  const bindings = info?.NetworkSettings?.Ports?.["5432/tcp"] ?? [];
  const env = info?.Config?.Env ?? [];
  return {
    id: info?.Id,
    name: info?.Name,
    labels: info?.Config?.Labels ?? {},
    image: info?.Config?.Image,
    running: info?.State?.Running === true,
    tmpfs: Object.hasOwn(info?.HostConfig?.Tmpfs ?? {}, PGDATA),
    volumes: (info?.Mounts ?? []).filter((mount) => mount?.Type === "volume").length,
    bindings: bindings.map((binding) => ({
      host: binding?.HostIp,
      port: Number(binding?.HostPort),
    })),
    port: Number(bindings[0]?.HostPort),
    database: env
      .find((entry) => String(entry).startsWith("POSTGRES_DB="))
      ?.slice("POSTGRES_DB=".length),
    currentDatabase,
  };
}

/** API 시험 child env: 부모의 DB·비밀·신원 키를 지우고 같은 URL 하나(DATABASE_URL=DIRECT_URL)와 synthetic 값만 넣는다. */
export function ownedTestEnv(base, owner, port, password) {
  const url = `postgresql://postgres:${password}@${LOOPBACK}:${port}/${owner.database}`;
  return {
    ...Object.fromEntries(Object.entries(base ?? {}).filter(([key]) => !NOT_INHERITED.test(key))),
    DATABASE_URL: url,
    DIRECT_URL: url,
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    AFC_TEST_RUN_ID: owner.run,
    AFC_TEST_TODAY: TEST_TODAY,
  };
}

/**
 * API 시험 child 직전 확인 — 정확한 ID·이름·owner/run/purpose·image·tmpfs·volume 0·loopback 단일 바인딩·고유 `_test`·
 * 컨테이너 안 current_database, 같은 URL·명시 날짜·run·synthetic key, .env 부재. 반환은 고정 문제 id 목록이다.
 */
export function ownedTestProblems({ owner, facts, env, root, exists = existsSync }) {
  const problems = [];
  const expect = (ok, problem) => {
    if (!ok) problems.push(problem);
  };
  expect(CONTAINER_ID.test(owner?.id ?? "") && facts?.id === owner.id, "container-id");
  expect(facts?.name === `/${owner?.container}`, "container-name");
  expect(facts?.labels?.["afc.owner"] === OWNER, "owner-label");
  expect(facts?.labels?.["afc.run"] === owner?.run, "run-label");
  expect(facts?.labels?.["afc.purpose"] === PURPOSE, "purpose-label");
  expect(facts?.image === "postgres:16", "image");
  expect(facts?.running === true, "running");
  expect(facts?.tmpfs === true, "tmpfs");
  expect(facts?.volumes === 0, "volume");
  const binding = facts?.bindings?.length === 1 ? facts.bindings[0] : null;
  expect(
    binding?.host === LOOPBACK &&
      Number.isInteger(binding.port) &&
      binding.port > 0 &&
      binding.port !== 5432 &&
      binding.port === facts.port,
    "binding",
  );
  const database = owner?.database;
  expect(OWNED_DATABASE.test(database ?? "") && !SHARED_DATABASES.has(database), "database-name");
  expect(facts?.database === database && facts?.currentDatabase === database, "database");
  let url = null;
  try {
    url = new URL(env?.DATABASE_URL);
  } catch {
    url = null;
  }
  expect(typeof env?.DATABASE_URL === "string" && env.DATABASE_URL === env.DIRECT_URL, "url-pair");
  expect(
    url?.protocol === "postgresql:" &&
      url.hostname === LOOPBACK &&
      url.port === String(facts?.port) &&
      url.pathname === `/${database}` &&
      url.username === "postgres" &&
      !url.search &&
      !url.hash,
    "url-target",
  );
  expect(
    !Object.entries(env ?? {}).some(
      ([key, value]) =>
        key !== "DATABASE_URL" && key !== "DIRECT_URL" && /postgres(ql)?:\/\//i.test(String(value)),
    ),
    "foreign-url",
  );
  expect(env?.AFC_TEST_TODAY === TEST_TODAY, "today");
  expect(env?.AFC_TEST_RUN_ID === owner?.run, "run-env");
  expect(Buffer.from(String(env?.FIELD_ENCRYPTION_KEY ?? ""), "base64").length === 32, "key");
  expect(
    DOTENV.every((file) => !exists(path.join(root, ...file.split("/")))),
    "dotenv",
  );
  return problems;
}

/**
 * 자기 컨테이너만 지운다 — ID 가 없으면 정확한 이름·run·owner 로만 되찾고, 라벨이 다르면 지우지 않는다(CLEANUP_FAILED).
 * "absent" = 지금 부재를 확인했다. "unverified" = 조회는 비었지만 docker run 의 숫자 0·무신호 정상 close 를 관측하지
 * 못해(timeout·abort·spawn 오류·외부 신호·null/nonzero status) daemon 의 뒤늦은 생성을 배제할 수 없다 — 빈 조회는
 * 그때 부재 증거가 아니다.
 */
async function removeOwnedContainer(io, env, owner, id, creationSettled) {
  let target = id;
  if (!CONTAINER_ID.test(target ?? "")) {
    const found = await docker(
      io,
      env,
      "cleanup-lookup",
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `name=^/${owner.container}$`,
      "--filter",
      `label=afc.run=${owner.run}`,
      "--filter",
      `label=afc.owner=${OWNER}`,
      "--format",
      "{{.ID}}",
    );
    if (found === "") return creationSettled ? "absent" : "unverified";
    if (!CONTAINER_ID.test(found)) throw coded("CLEANUP_FAILED");
    target = found;
  }
  const listed = (step) =>
    docker(
      io,
      env,
      step,
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `id=${target}`,
      "--format",
      "{{.ID}}",
    );
  const present = await listed("cleanup-ps");
  if (present === "") return "absent";
  if (present !== target) throw coded("CLEANUP_FAILED");
  const info = JSON.parse(await docker(io, env, "cleanup-inspect", "inspect", target))[0];
  const labels = info?.Config?.Labels ?? {};
  if (
    info?.Id !== target ||
    info?.Name !== `/${owner.container}` ||
    labels["afc.owner"] !== OWNER ||
    labels["afc.run"] !== owner.run ||
    labels["afc.purpose"] !== PURPOSE
  )
    throw coded("CLEANUP_FAILED");
  await docker(io, env, "cleanup-rm", "rm", "-f", "-v", target);
  if ((await listed("cleanup-absent")) !== "") throw coded("CLEANUP_FAILED");
  return "absent";
}

/**
 * owned `_test` wrapper — 새 postgres:16(tmpfs·volume 0·loopback·고유 `_test`·정확 owner/run/purpose/ID)을 만들고,
 * API 시험 child 직전에 대상과 child env 를 다시 확인한 뒤 workspace `pnpm test` 를 1회 실행하고 자기 자원만 정리한다.
 * 잘못된 대상이면 child 를 만들지 않는다(OWNERSHIP). 이 함수는 throw 하지 않고 다음을 돌려준다:
 *   { status, failures: [{ boundary: "gate"|"cleanup", code }], cleanup: { processGroupAbsent, containerAbsent }, target }
 * cleanup boundary 는 CLEANUP_FAILED(확인된 정리 실패)·CLEANUP_UNVERIFIED(소유 PID 를 못 받은 child·뒤늦은 생성을
 * 배제 못 한 빈 조회) 순서다. 원 오류·출력·비밀은 private 에만 있다. target 은 비밀이 아닌 식별자(run·이름·DB·ID·port)뿐이다.
 */
export async function runOwnedTest(options = {}) {
  const context = contextOf(options);
  const token = randomBytes(4).toString("hex");
  const io = {
    launch: context.launch,
    writePrivate: context.writePrivate,
    root: context.root,
    signal: context.signal,
    pids: [],
    launches: [],
    name: sequence(`owned-test-${token}`),
  };
  const owner = Object.freeze({
    run: randomUUID(),
    container: `afc-ci-m0-test-${token}`,
    database: `afc_ci_m0_${token}_test`,
  });
  const password = randomBytes(24).toString("hex");
  const cleanup = { processGroupAbsent: false, containerAbsent: false };
  let id;
  let port = null;
  let operationError;
  let operationFailed = false;
  let cleanupFailed = false;
  let cleanupUnverified = false;
  try {
    await withCleanup(
      async () => {
        try {
          id = await docker(
            io,
            context.env,
            "docker-run",
            "run",
            "-d",
            "--name",
            owner.container,
            "--label",
            `afc.owner=${OWNER}`,
            "--label",
            `afc.run=${owner.run}`,
            "--label",
            `afc.purpose=${PURPOSE}`,
            "--tmpfs",
            PGDATA,
            "-e",
            `POSTGRES_PASSWORD=${password}`,
            "-e",
            `POSTGRES_DB=${owner.database}`,
            "-p",
            `${LOOPBACK}::5432`,
            "postgres:16",
          );
          if (!CONTAINER_ID.test(id)) throw coded("OWNERSHIP");
          const current = await waitReady(io, context.env, id, owner.database, context.delay);
          const info = JSON.parse(
            await docker(io, context.env, "docker-inspect", "inspect", id),
          )[0];
          const facts = targetFacts(info, current);
          port = Number.isInteger(facts.port) ? facts.port : null;
          const env = ownedTestEnv(context.env, owner, facts.port, password);
          const problems = ownedTestProblems({
            owner: { ...owner, id },
            facts,
            env,
            root: context.root,
            exists: context.exists,
          });
          if (problems.length > 0) {
            try {
              io.writePrivate(`${io.name("preflight")}.json`, JSON.stringify(problems));
            } catch {
              // 거부 사유 기록 실패도 거부다 — child 는 어느 쪽이든 만들지 않는다.
            }
            throw coded("OWNERSHIP");
          }
          const result = await launchPrivately(io, io.name("pnpm-test"), "pnpm", ["test"], {
            env,
            timeout: TIMEOUTS.test,
          });
          const code = launchFailure(result, io.signal);
          if (code) throw coded(code);
        } catch (error) {
          operationFailed = true;
          operationError = error;
          throw error;
        }
      },
      async () => {
        // 정리는 중단 신호와 무관하게 끝까지 한다 — 자기 PID 그룹 → 자기 컨테이너 → 정리 중에 만든 child 의 그룹.
        const cleanupIo = { ...io, signal: undefined };
        let groupsFailed = false;
        let container = "failed";
        try {
          await closeRegistered(io, context.closeGroup);
        } catch {
          groupsFailed = true;
        }
        const creation = io.launches.find((launch) => launch.name.endsWith("-docker-run"));
        try {
          container = await removeOwnedContainer(
            cleanupIo,
            context.env,
            owner,
            id,
            creation?.settled !== false,
          );
        } catch {
          container = "failed";
        }
        try {
          await closeRegistered(io, context.closeGroup);
        } catch {
          groupsFailed = true;
        }
        cleanup.processGroupAbsent = !groupsFailed && allOwned(io);
        cleanup.containerAbsent = container === "absent";
        cleanupFailed = groupsFailed || container === "failed";
        cleanupUnverified = !allOwned(io) || container === "unverified";
        if (cleanupFailed || cleanupUnverified)
          throw coded(cleanupFailed ? "CLEANUP_FAILED" : "CLEANUP_UNVERIFIED");
      },
    );
  } catch {
    // withCleanup 이 원 실패와 정리 실패를 함께 보존한다 — 공개용 분류는 위 표지로만 한다.
  }
  const failures = [
    ...(operationFailed ? [{ boundary: "gate", code: rootCode(operationError) }] : []),
    ...(cleanupFailed ? [{ boundary: "cleanup", code: "CLEANUP_FAILED" }] : []),
    ...(cleanupUnverified ? [{ boundary: "cleanup", code: "CLEANUP_UNVERIFIED" }] : []),
  ];
  return {
    status: failures.length > 0 ? "failed" : "passed",
    failures,
    cleanup,
    target: {
      run: owner.run,
      container: owner.container,
      database: owner.database,
      containerId: CONTAINER_ID.test(id ?? "") ? id : null,
      port,
    },
  };
}

/** codegen-drift: 추적 존재(ls-files)·비어 있지 않음·drift 0(diff)을 함께 관측해야 통과다. */
async function verifyCodegen(file, context, io) {
  const tracked = await launchPrivately(
    io,
    io.name("ls-files"),
    "git",
    ["ls-files", "--error-unmatch", "--", file],
    { env: context.env, timeout: TIMEOUTS.gate },
  );
  const trackedCode = launchFailure(tracked, context.signal);
  if (trackedCode === "CHILD_FAILED" && tracked.status === 1 && !tracked.error && !tracked.signal)
    throw coded("CODEGEN_UNTRACKED");
  if (trackedCode) throw coded(trackedCode);
  let size = 0;
  try {
    const stat = statSync(path.join(context.root, ...file.split("/")));
    size = stat.isFile() ? stat.size : 0;
  } catch {
    size = 0;
  }
  if (size === 0) throw coded("CODEGEN_EMPTY");
  const diff = await launchPrivately(
    io,
    io.name("diff"),
    "git",
    ["diff", "--exit-code", "--", file],
    { env: context.env, timeout: TIMEOUTS.gate },
  );
  const diffCode = launchFailure(diff, context.signal);
  if (diffCode === "CHILD_FAILED" && diff.status === 1 && !diff.error && !diff.signal)
    throw coded("CODEGEN_DRIFT");
  if (diffCode) throw coded(diffCode);
  return {};
}

/** owned `_test`·owned e2e 의 실패 결과(원 실패·정리 실패 boundary)를 gate 결과로 그대로 옮기기 위한 표지. */
const OWNED_OUTCOMES = new WeakMap();

/**
 * owned-e2e 전용 종료 경계 — 자원을 소유한 runner(xvfb-run → ci-e2e.mjs, 그 아래 별도 detached Playwright 그룹·
 * container·profile·port)를 직접 spawn 한다. privateLaunch 처럼 첫 spawn 부터 private 양 스트림·32MiB 상한·원 오류
 * 보존·1회 settle 이지만, 어떤 종료 원인(abort·timeout·출력 상한·스트림 I/O·child error·exit 뒤 열린 stdio)도 같은
 * 협력 취소로만 간다: 자기 그룹에 TERM 1회(안쪽 main 이 controller.abort 로 받는다) → runner 의 close 를
 * TIMEOUTS.cancel 까지 기다림 → 넘을 때만 정확한 자기 그룹 KILL → FINAL_SETTLE_MS 뒤 settle. 강제 없이 관측한
 * 소유 runner 의 close 만 closeObserved 다. 정상 완료에는 신호를 보내지 않는다.
 */
function cooperativeLaunch(command, args, options, deps, onSpawn) {
  return new Promise((resolve) => {
    const { signal: abortSignal, timeout, ...spawnOptions } = options;
    const chunks = { stdout: [], stderr: [] };
    const timers = [];
    let bytes = 0;
    let child;
    let pid;
    let error;
    let status = null;
    let signal = null;
    let settled = false;
    let cancelling = false;
    let termSent = false;
    let forced = false;
    const later = (ms, action) => timers.push(deps.setTimeout(action, ms));
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) deps.clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (!closed) {
        error ??= coded("CHILD_FAILED");
        child?.stdout?.destroy();
        child?.stderr?.destroy();
      }
      resolve({
        status,
        signal,
        error,
        pid,
        closed,
        closeObserved: closed && !forced && pid !== undefined,
        termSent,
        forced,
        stdout: Buffer.concat(chunks.stdout),
        stderr: Buffer.concat(chunks.stderr),
      });
    };
    const send = (kind) => {
      try {
        if (deps.platform === "linux") deps.kill(-pid, kind);
        else child.kill(kind);
        return true;
      } catch {
        return false;
      }
    };
    const cancel = (reason) => {
      if (settled) return;
      error ??= reason;
      if (cancelling) return;
      cancelling = true;
      // 소유 PID 가 없으면 신호를 보낼 곳이 없다 — 신호 없이 유한하게 settle 한다(closeObserved 는 false).
      if (pid === undefined) {
        later(FINAL_SETTLE_MS, () => finish(false));
        return;
      }
      termSent = send("SIGTERM");
      later(TIMEOUTS.cancel, () => {
        forced = true;
        send("SIGKILL");
        later(FINAL_SETTLE_MS, () => finish(false));
      });
    };
    const onAbort = () => cancel(coded("ABORTED"));
    if (abortSignal?.aborted) {
      error = coded("ABORTED");
      finish(false);
      return;
    }
    try {
      child = deps.spawn(command, args, spawnOptions);
    } catch (caught) {
      error = caught;
      finish(false);
      return;
    }
    pid =
      spawnOptions.detached === true && Number.isInteger(child.pid) && child.pid > 1
        ? child.pid
        : undefined;
    for (const channel of ["stdout", "stderr"]) {
      child[channel].on("data", (data) => {
        if (settled) return;
        bytes += data.length;
        // 상한을 넘으면 더 저장하지 않되 계속 읽는다 — 막힌 pipe 때문에 runner 가 정리를 못 끝내지 않게.
        if (bytes <= OUTPUT_LIMIT) chunks[channel].push(data);
        else cancel(coded("OUTPUT_LIMIT"));
      });
      child[channel].on("error", () => cancel(coded("PRIVATE_IO")));
    }
    child.on("error", cancel);
    child.on("exit", (code, kind) => {
      status = code;
      signal = kind;
      // 취소 중에는 exit 뒤 열린 stdio 를 강제 종료로 키우지 않는다 — close 는 예산 안에서 기다린다.
      if (!settled && !cancelling) later(DRAIN_MS, () => cancel(coded("CHILD_FAILED")));
    });
    child.on("close", (code, kind) => {
      status = code;
      signal = kind;
      finish(true);
    });
    if (timeout > 0)
      later(timeout, () =>
        cancel(Object.assign(new Error("Owned runner timed out"), { code: "ETIMEDOUT" })),
      );
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (pid !== undefined) onSpawn(pid);
    } catch (caught) {
      cancel(caught);
    }
    if (abortSignal?.aborted) onAbort();
  });
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_ID = new RegExp(`^${UUID}$`);
const PHASE_FILE = new RegExp(`^(.+)-(${UUID})\\.json$`);
const EXECUTION_FILE = new RegExp(`^execution-${UUID}\\.json$`);
/** runner safe phase JSON(ci-e2e runPhase 끝)의 키 전부 — 그 밖 키는 증거로 받지 않는다. */
const PHASE_KEYS = new Set([
  "phase",
  "run",
  "stage",
  "profile",
  "containerId",
  "database",
  "principal",
  "owner",
  "purpose",
  "childPid",
  "status",
  "error",
  "execution",
  "cleanup",
  "finishedAt",
]);
/** runner 가 phase finally 에서 확인해 남기는 정리 4종(forced 는 부가 boolean). */
const PHASE_CLEANUP = Object.freeze([
  "processGroupAbsent",
  "exactContainerAbsent",
  "physicalProfileAbsent",
  "portsAbsent",
]);
const PHASE_DATABASE = /^afc_gen_s03_ci_[0-9a-f]{8}_e2e$/;

/** runner(ci-e2e main 의 selectedPhases)와 같은 선택 — 이번 stage 의 manifest 가 고르는 phase 이름(실행 순서). */
export function expectedPhases(root, stage) {
  const cases = requiredCases(loadManifest(root), stage);
  return phases
    .filter((phase) => cases.some((row) => row.phase === phase.name))
    .map((phase) => phase.name);
}

function phaseRowValid(row, phase, run, stage) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(row) || !Object.keys(row).every((key) => PHASE_KEYS.has(key))) return false;
  return (
    row.phase === phase &&
    row.run === run &&
    row.stage === stage &&
    row.owner === "automation-m0-06" &&
    row.purpose === "owned-e2e" &&
    (row.containerId === null ||
      (typeof row.containerId === "string" && CONTAINER_ID.test(row.containerId))) &&
    typeof row.database === "string" &&
    PHASE_DATABASE.test(row.database) &&
    typeof row.principal === "string" &&
    RUN_ID.test(row.principal) &&
    (row.childPid === undefined || (Number.isInteger(row.childPid) && row.childPid > 1)) &&
    (row.profile === undefined || object(row.profile)) &&
    (row.execution === undefined || object(row.execution)) &&
    (row.status === "passed"
      ? row.error === undefined
      : row.status === "failed" &&
        typeof row.error === "string" &&
        safeCode({ code: row.error }) === row.error) &&
    object(row.cleanup) &&
    Object.entries(row.cleanup).every(
      ([key, value]) =>
        (PHASE_CLEANUP.includes(key) || key === "forced") && typeof value === "boolean",
    ) &&
    typeof row.finishedAt === "string" &&
    !Number.isNaN(Date.parse(row.finishedAt))
  );
}

/**
 * owned-e2e 안쪽 정리 판정(순수). files 는 이번 gate 동안 새로 생긴 이름과 내용뿐이다(시작 전 목록과의 차집합 —
 * 과거 파일은 들어오지 않는다). 시작 전후 시각 밖·형식/귀속 불일치·중복·기대 밖 파일은 증거가 아니다. 기대 phase 마다
 * 유효 파일이 정확히 1개이고 정리 4종이 모두 true 여야 한다. 반환은 고정 문제 id 목록이며 빈 배열만 확인 완료다:
 * unexpected-file·invalid·stale·duplicate·missing·cleanup-failed(runner 가 정리 실패를 기록)·cleanup-unconfirmed.
 * 차집합과 시각은 "이번 호출의 새 파일" 선별 근거일 뿐 시작된 자원의 완전 목록이 아니다 — 그래서 하나라도 빠지면 미확인이다.
 */
export function phaseCleanupProblems({ files, expected, stage, startedAt, endedAt }) {
  const problems = [];
  const valid = new Map(expected.map((phase) => [phase, []]));
  const runs = new Set();
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, text } of ordered) {
    // runner 최종 요약은 main 이 끝까지 돈 경우의 보조 산출일 뿐 정리 증거가 아니다.
    if (EXECUTION_FILE.test(name)) continue;
    const match = PHASE_FILE.exec(name);
    if (!match || !valid.has(match[1])) {
      problems.push("unexpected-file");
      continue;
    }
    let row;
    try {
      row = JSON.parse(text);
    } catch {
      problems.push("invalid");
      continue;
    }
    if (!phaseRowValid(row, match[1], match[2], stage)) {
      problems.push("invalid");
      continue;
    }
    const finished = Date.parse(row.finishedAt);
    if (!(finished >= startedAt && finished <= endedAt)) {
      problems.push("stale");
      continue;
    }
    if (runs.has(row.run)) {
      problems.push("duplicate");
      continue;
    }
    runs.add(row.run);
    valid.get(row.phase).push(row);
  }
  for (const rows of valid.values()) {
    if (rows.length === 0) problems.push("missing");
    else if (rows.length > 1) problems.push("duplicate");
    else if (
      rows[0].error === "CLEANUP_FAILED" ||
      PHASE_CLEANUP.some((key) => rows[0].cleanup[key] === false)
    )
      problems.push("cleanup-failed");
    else if (!PHASE_CLEANUP.every((key) => rows[0].cleanup[key] === true))
      problems.push("cleanup-unconfirmed");
  }
  return problems;
}

function listNames(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** runner 1개 — 전용 경계로 실행하고 양 스트림·상태를 private 에만 쓴다. 쓰기 실패는 recorded=false(판정은 계속). */
async function launchRunner(io, context, name, command, args, timeout) {
  // 중단 뒤에는 경계가 spawn 하지 않는다(같은 동기 구간의 판정) — 시작하지 않은 runner 는 소유 기록에 넣지 않는다.
  const launch = { name, pid: undefined, settled: false };
  if (!context.signal?.aborted) io.launches.push(launch);
  const result = await cooperativeLaunch(
    command,
    args,
    {
      cwd: io.root,
      env: context.env,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
      detached: true,
      timeout,
      signal: context.signal,
    },
    {
      spawn: context.spawn,
      setTimeout: context.timers.setTimeout,
      clearTimeout: context.timers.clearTimeout,
      kill: context.kill,
      platform: context.platform,
    },
    (pid) => {
      launch.pid = pid;
      io.pids.push(pid);
    },
  );
  launch.settled = result.closed === true && result.error === undefined;
  const recorded = recordPrivately(io, name, result, {
    closeObserved: result.closeObserved,
    termSent: result.termSent,
    forced: result.forced,
  });
  return { ...result, recorded };
}

/**
 * owned-e2e — runner 를 전용 경계로 실행하고, 이번 gate 동안 새로 생긴 safe phase 파일로 안쪽 정리를 판정한다.
 * 정상 close 관측(예산 안·강제 없음) ∧ 기대 phase 전부의 유효 귀속 파일 1개씩 ∧ 각 정리 4종 true 일 때만
 * phaseCleanupVerified 다. 그 밖은 원 실패와 별도로 cleanup boundary 의 CLEANUP_FAILED(runner 가 정리 실패를 기록)·
 * CLEANUP_UNVERIFIED(확인 불가)다. 바깥 PID 그룹 부재는 안쪽 자원 정리의 증거가 아니고, cleanup 확인은 gate 실패를
 * 통과로 바꾸지 않는다.
 */
async function runOwnedE2E(gate, context, io) {
  const stage = gate.args.at(-1);
  const dir = path.join(context.root, "apps", "web", "e2e", ".artifacts-ci", stage);
  let before;
  try {
    before = new Set(listNames(dir));
  } catch {
    before = undefined;
  }
  const startedAt = context.now();
  const result = await launchRunner(
    io,
    context,
    io.name("main"),
    gate.command,
    gate.args,
    gate.timeout,
  );
  const endedAt = context.now();
  let code = launchFailure(result, context.signal) ?? (result.recorded ? null : "PRIVATE_IO");
  const problems = result.closeObserved ? [] : ["close-unobserved"];
  let expected;
  try {
    expected = context.expectedPhases(stage);
    if (!before) throw coded("PRIVATE_IO");
    const files = listNames(dir)
      .filter((name) => !before.has(name))
      .map((name) => ({ name, text: readText(path.join(dir, name)) }));
    problems.push(...phaseCleanupProblems({ files, expected, stage, startedAt, endedAt }));
  } catch {
    problems.push("unreadable");
  }
  try {
    io.writePrivate(
      `${io.name("phase-evidence")}.json`,
      JSON.stringify({ stage, expected, problems }),
    );
  } catch {
    code ??= "PRIVATE_IO";
  }
  const failures = [
    ...(code ? [{ boundary: "gate", code }] : []),
    ...(problems.includes("cleanup-failed")
      ? [{ boundary: "cleanup", code: "CLEANUP_FAILED" }]
      : []),
    ...(problems.some((problem) => problem !== "cleanup-failed")
      ? [{ boundary: "cleanup", code: "CLEANUP_UNVERIFIED" }]
      : []),
  ];
  const cleanup = { phaseCleanupVerified: problems.length === 0 };
  if (failures.length === 0) return cleanup;
  const error = coded(failures[0].code);
  OWNED_OUTCOMES.set(error, { status: "failed", failures, cleanup });
  throw error;
}

async function executeGate(gate, context, io) {
  if (gate.ownedTest) {
    const outcome = await runOwnedTest(context);
    if (outcome.status !== "passed") {
      const error = coded(outcome.failures[0]?.code ?? "OPERATION_FAILED");
      OWNED_OUTCOMES.set(error, outcome);
      throw error;
    }
    return outcome.cleanup;
  }
  if (gate.ownedE2E) return runOwnedE2E(gate, context, io);
  if (gate.codegen) return verifyCodegen(gate.codegen, context, io);
  // 필수 node gate 는 자체 시험이 목록에 있을 때만 실행한다(누락 = child 없이 RED).
  if (gate.requires !== undefined && !gate.args.includes(gate.requires))
    throw coded("TEST_REGISTRATION");
  const result = await launchPrivately(io, io.name("main"), gate.command, gate.args, {
    env: context.env,
    timeout: gate.timeout ?? TIMEOUTS.gate,
  });
  const code = launchFailure(result, context.signal);
  if (code) throw coded(code);
  return {};
}

/**
 * gate 1개: 실행 → 소유 PID 그룹 정리·부재 확인. 원 실패와 정리 실패를 둘 다 boundary 로 남긴다. 소유 PID 를 남기지
 * 못한 child 가 있으면 그룹 부재는 확인된 것이 아니다(CLEANUP_UNVERIFIED).
 */
async function runGate(gate, context) {
  const io = {
    launch: context.launch,
    writePrivate: context.writePrivate,
    root: context.root,
    signal: context.signal,
    pids: [],
    launches: [],
    name: sequence(gate.id),
  };
  let facts = {};
  let operationError;
  let operationFailed = false;
  let groupsAbsent = false;
  let cleanupFailed = false;
  try {
    await withCleanup(
      async () => {
        try {
          facts = (await executeGate(gate, context, io)) ?? {};
        } catch (error) {
          operationFailed = true;
          operationError = error;
          throw error;
        }
      },
      async () => {
        try {
          await closeRegistered(io, context.closeGroup);
          groupsAbsent = true;
        } catch {
          cleanupFailed = true;
          throw coded("CLEANUP_FAILED");
        }
      },
    );
  } catch (error) {
    if (!operationFailed && !cleanupFailed) {
      operationFailed = true;
      operationError = error;
    }
  }
  const owned = operationFailed ? OWNED_OUTCOMES.get(operationError) : undefined;
  const ownedCleanup = owned?.cleanup ?? facts;
  const unowned = !allOwned(io);
  const cleanup = {
    processGroupAbsent: groupsAbsent && !unowned && ownedCleanup?.processGroupAbsent !== false,
  };
  if (gate.ownedTest) cleanup.containerAbsent = ownedCleanup?.containerAbsent === true;
  if (gate.ownedE2E) cleanup.phaseCleanupVerified = ownedCleanup?.phaseCleanupVerified === true;
  // 고정 순서: 원 실패 → 확인된 정리 실패 → 정리 미확인(같은 code 는 한 번).
  const ownedFailures = owned?.failures ?? [];
  let gateCode;
  if (operationFailed)
    gateCode = owned
      ? ownedFailures.find((failure) => failure.boundary === "gate")?.code
      : rootCode(operationError);
  const failed = cleanupFailed || ownedFailures.some((f) => f.code === "CLEANUP_FAILED");
  const unverified = unowned || ownedFailures.some((f) => f.code === "CLEANUP_UNVERIFIED");
  const failures = [
    ...(gateCode ? [{ boundary: "gate", code: gateCode }] : []),
    ...(failed ? [{ boundary: "cleanup", code: "CLEANUP_FAILED" }] : []),
    ...(unverified ? [{ boundary: "cleanup", code: "CLEANUP_UNVERIFIED" }] : []),
  ];
  return failures.length > 0
    ? { status: "failed", failures, cleanup }
    : { status: "passed", cleanup };
}

function contextOf(options = {}) {
  const root = options.root ?? ROOT;
  return {
    root,
    env: options.env ?? process.env,
    signal: options.signal,
    launch: options.launch ?? privateLaunch,
    writePrivate: options.writePrivate ?? privateSink(),
    closeGroup: options.closeGroup ?? closeOwnedGroup,
    exists: options.exists ?? existsSync,
    delay: options.delay ?? delay,
    // owned-e2e 경계의 OS 연결 — 시험은 메모리 모델(spawn·시계·신호·플랫폼)을 주입한다.
    spawn: options.spawn ?? spawn,
    timers: options.timers ?? { setTimeout, clearTimeout },
    kill: options.kill ?? ((target, kind) => process.kill(target, kind)),
    platform: options.platform ?? process.platform,
    expectedPhases: options.expectedPhases ?? ((stage) => expectedPhases(root, stage)),
    now: options.now ?? Date.now,
  };
}

/** gate 를 순서대로 1회씩 실행하고 첫 실패에서 멈춘다(뒤 gate 는 실행하지 않는다). 결과는 results 에 바로 쌓는다. */
export async function runGates(gates, options = {}, results = new Map()) {
  const context = contextOf(options);
  for (const gate of gates) {
    if (context.signal?.aborted) break;
    const result = await runGate(gate, context);
    results.set(gate.id, result);
    if (result.status !== "passed") break;
  }
  return results;
}

/** 공개 정리 확인값 — 고정 boolean 3종뿐이다(owned-test 의 containerAbsent·owned-e2e 의 phaseCleanupVerified). */
function publicCleanup(cleanup) {
  const safe = { processGroupAbsent: cleanup?.processGroupAbsent === true };
  for (const key of ["containerAbsent", "phaseCleanupVerified"])
    if (cleanup !== null && typeof cleanup === "object" && Object.hasOwn(cleanup, key))
      safe[key] = cleanup[key] === true;
  return safe;
}

function publicGate(id, result) {
  try {
    if (!result) return { id, status: "not-run" };
    const cleanup = publicCleanup(result.cleanup);
    if (result.status === "passed") return { id, status: "passed", cleanup };
    const failures = (Array.isArray(result.failures) ? result.failures : []).map((failure) => ({
      boundary: failure?.boundary === "cleanup" ? "cleanup" : "gate",
      code: rootCode(failure),
    }));
    return {
      id,
      status: "failed",
      failures: failures.length > 0 ? failures : [{ boundary: "gate", code: "OPERATION_FAILED" }],
      cleanup,
    };
  } catch {
    return { id, status: "failed", failures: [{ boundary: "gate", code: "OPERATION_FAILED" }] };
  }
}

/**
 * 공개 summary — 고정 gate id 목록 위에서 다시 계산한다. 결과가 없는 gate 는 not-run 이고, root 와 17개 gate 가
 * 전부 passed 일 때만 exit 0 이다(뒤의 성공·결과 누락이 앞선 실패를 지우지 못한다).
 */
export function summarize(stage, root, results) {
  const gates = GATE_IDS.map((id) => publicGate(id, results?.get(id)));
  const rootStatus =
    root?.status === "passed" ? { status: "passed" } : { status: "failed", code: rootCode(root) };
  const exitCode =
    rootStatus.status === "passed" && gates.every((gate) => gate.status === "passed") ? 0 : 1;
  return { stage: STAGES.includes(stage) ? stage : null, root: rootStatus, gates, exitCode };
}

/**
 * CLI 본체: 인자 → runner guard → install 흔적 → gate 순서 실행 → 공개 summary 한 줄. 어떤 경로도 throw 하지 않는다.
 * 시험은 runner/platform/launcher 를 주입한다 — guard 를 통과시키는 시험은 합성 launcher 만 쓴다.
 */
export async function main({
  argv = process.argv.slice(2),
  platform = process.platform,
  output = (line) => console.log(line),
  ...options
} = {}) {
  const context = contextOf(options);
  const results = new Map();
  let stage = null;
  let root = { status: "passed" };
  try {
    ({ stage } = parseArgs(argv));
    checkRunner({ env: context.env, platform });
    checkInstall(context.root, context.exists);
    await runGates(gatesFor(stage), context, results);
    if (context.signal?.aborted) root = { status: "failed", code: "ABORTED" };
  } catch (error) {
    const code = rootCode(error);
    root = { status: "failed", code };
    if (code === "OPERATION_FAILED") {
      try {
        context.writePrivate("root-error.txt", String(error?.stack ?? error));
      } catch {
        // 공개하지 않는다 — summary 의 code 가 남는다.
      }
    }
  }
  const summary = summarize(stage, root, results);
  output(JSON.stringify(summary));
  return summary.exitCode;
}

const invokedAsCli = () => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
};

if (invokedAsCli()) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  main({ signal: controller.signal }).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
