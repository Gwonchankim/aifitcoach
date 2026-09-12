/** GitHub's disposable Linux runner only. Preserve the existing observer boundaries. */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const epic = "94e4d6c6-1729-4f1a-8e1b-7baa84b487da";
// Existing observers resolve this literal relative to apps/web on Linux. It is a
// disposable directory inside the checkout, NOT a Windows user directory.
const ownedBase = path.resolve(web, "C:/Users/amole/.traycer");
const outputBase = path.join(web, "e2e/.artifacts-ci");
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { flag: "wx" });
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();

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

function cleanContainer(id, container, run) {
  const info = JSON.parse(docker("inspect", id))[0];
  if (info.Id !== id || info.Name !== `/${container}` || info.Config.Labels["afc.run"] !== run)
    throw new Error("Refusing cleanup: container ownership mismatch");
  docker("stop", id);
  docker("rm", "-v", id);
}

async function runPhase(phase) {
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
  mkdirSync(profiles, { recursive: true });
  mkdirSync(path.dirname(physical), { recursive: true });
  mkdirSync(physical); // Must be fresh; never reuse another process's profile.
  const descriptor = { v: 1, epic, manifestRoot: profiles, physicalRoot: physical, token: run };
  json(path.join(profiles, "physical-root.json"), descriptor);
  json(path.join(physical, ".afc-position-root.json"), descriptor);
  let id;
  try {
    id = docker(
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `afc.run=${run}`,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    );
    const info = JSON.parse(docker("inspect", id))[0];
    const port = Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort);
    const owner = { label, container, names, dbPort: port, run, e2eUser: user };
    json(path.join(output, "ownership.json"), owner);
    json(path.join(output, "container-ownership.json"), { container, names, run, containerId: id });
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
    console.log(`CI E2E phase: ${phase.name}`);
    const result = spawnSync("pnpm", phaseArgs(phase), {
      cwd: web,
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        DATABASE_URL: url,
        DIRECT_URL: url,
        E2E_DATABASE_URL: url,
        E2E_DEV_USER_ID: user,
        AFC_TEST_RUN_ID: run,
        AFC_POSITION_PROFILE_ROOT: profiles,
        AFC_POSITION_PROFILE_ALLOCATION: path.join(profiles, "physical-root.json"),
        FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outputBase, `${phase.name}-report`),
      },
    });
    if (result.error || result.status !== 0) throw new Error(`CI E2E phase failed: ${phase.name}`);
  } finally {
    if (id) cleanContainer(id, container, run);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux")
    throw new Error("This harness requires a disposable GitHub Actions Linux runner");
  mkdirSync(outputBase, { recursive: true });
  const failures = [];
  for (const phase of phases) {
    try {
      await runPhase(phase);
    } catch (error) {
      console.error(error.message);
      failures.push(phase.name);
    }
  }
  if (failures.length) {
    console.error(`Failed phases: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}
