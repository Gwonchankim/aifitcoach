import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  caseKey,
  inventorySpecs,
  validateManifest,
  validateDiscovery,
  validateSelections,
  validateExecution,
  validateAllocation,
  discover,
  preflight,
  makeProfile,
  profileEnv,
  profileFromEnv,
  validateProfile,
} from "./ci-e2e.manifest.mjs";
const { structuredClone } = globalThis;

test("actual CLI rejects an unknown stage without a top-level-await import deadlock", () => {
  const cli = fileURLToPath(new URL("./ci-e2e.manifest.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--stage", "future"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNKNOWN_STAGE/);
  assert.equal(result.signal, null);
});

test("preflight compares independent full discovery with actual nonempty m0 selectors", () => {
  const f = fixture();
  const smoke = { ...row(browsers[0], "m0 smoke"), stage: "m0", phase: "smoke-c" };
  f.manifest.cases.push(smoke);
  f.phases.push({ name: "smoke-c", project: browsers[0], args: ["--grep", "m0 smoke"] });
  const catalog = structuredClone(f.manifest.cases);
  const calls = [];
  const launch = (request) => {
    calls.push(request);
    const project = request.args[request.args.indexOf("--project") + 1];
    const grep = request.args[request.args.indexOf("--grep") + 1];
    const rows = catalog.filter(
      (r) =>
        (!request.args.includes("--project") || r.browser === project) &&
        (!request.args.includes("--grep") || r.case[0] === grep),
    );
    const report = {
      config: {
        rootDir: "/candidate/apps/web/e2e",
        configFile: "/candidate/apps/web/playwright.config.ts",
      },
      errors: [],
      suites: [
        {
          title: "09-offline-sync.spec.ts",
          specs: rows.map((r) => ({
            title: r.case[0],
            file: "09-offline-sync.spec.ts",
            tests: [{ projectName: r.browser }],
          })),
        },
      ],
    };
    return { status: 0, stdout: JSON.stringify(report) };
  };
  const args = (p) => ["exec", "playwright", "test", ...p.args, "--project", p.project];
  const summary = preflight({
    root: "/candidate",
    ...f,
    files: [file],
    stage: "m0",
    phaseArgs: args,
    launch,
  });
  assert.equal(summary.cases, 1);
  assert.deepEqual(
    summary.phases.map((p) => p.name),
    ["smoke-c"],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("m0 smoke"));
  f.phases.at(-1).args = ["--grep", "missing selector"];
  rejects("SELECTION_MISMATCH", () =>
    preflight({ root: "/candidate", ...f, files: [file], stage: "m0", phaseArgs: args, launch }),
  );
  f.phases.at(-1).args = ["--grep", "m0 smoke"];
  assert.equal(
    preflight({ root: "/candidate", ...f, files: [file], stage: "m0", phaseArgs: args, launch })
      .cases,
    1,
  );
});

const file = "apps/web/e2e/09-offline-sync.spec.ts";
const config = "playwright.config.ts";
const browsers = ["chromium-mobile", "webkit-ios"];
const row = (browser, title = "roundtrip") => ({
  stage: "product",
  requirement: "SYNC-ROUNDTRIP",
  file,
  case: [title],
  browser,
  config,
  phase: browser === browsers[0] ? "core-c" : "core-w",
  repeatEachIndex: 0,
  principalScope: "fresh-per-phase",
  requiredOutcome: "passed",
});
function fixture() {
  const manifest = { schemaVersion: 1, cases: browsers.map((b) => row(b)), exclusions: [] };
  const phases = browsers.map((project, i) => ({
    name: i ? "core-w" : "core-c",
    project,
    args: [],
  }));
  const discovered = manifest.cases.map((c) => ({ ...c }));
  const selected = Object.fromEntries(
    phases.map((p) => [p.name, discovered.filter((c) => c.phase === p.name)]),
  );
  return { manifest, phases, discovered, selected };
}
const rejects = (code, fn) => assert.throws(fn, (error) => error.code === code);
const check = (f) => {
  validateManifest(f.manifest, [file], f.phases, "product");
  validateDiscovery(f.manifest, f.discovered, "product");
  validateSelections(f.manifest, f.selected, f.phases, "product");
};

test("untracked spec inventory uses the filesystem, including nested files", () => {
  const tree = {
    "apps/web/e2e": [
      { name: "09-offline-sync.spec.ts", directory: false },
      { name: "nested", directory: true },
      { name: "node_modules", directory: true },
    ],
    "apps/web/e2e/nested": [{ name: "99-unmapped.spec.ts", directory: false }],
  };
  assert.deepEqual(
    inventorySpecs((dir) => tree[dir]),
    [file, "apps/web/e2e/nested/99-unmapped.spec.ts"],
  );
  const f = fixture();
  rejects("UNMAPPED_FILE", () =>
    validateManifest(f.manifest, [file, "apps/web/e2e/99-unmapped.spec.ts"], f.phases, "product"),
  );
  check(f);
});

test("a new case in an existing file is not covered by a file count", () => {
  const f = fixture();
  rejects("DISCOVERY_MISMATCH", () =>
    validateDiscovery(f.manifest, [...f.discovered, row(browsers[0], "new")], "product"),
  );
  check(f);
});

test("deleted/renamed file and case fail rather than auto-accept", () => {
  const f = fixture();
  rejects("MISSING_FILE", () => validateManifest(f.manifest, [], f.phases, "product"));
  rejects("DISCOVERY_MISMATCH", () => validateDiscovery(f.manifest, [f.discovered[0]], "product"));
  rejects("DISCOVERY_MISMATCH", () =>
    validateDiscovery(f.manifest, [row(browsers[0], "renamed"), f.discovered[1]], "product"),
  );
  check(f);
});

test("core regex omission and WebKit match/grep omission fail independently", () => {
  for (const phase of ["core-c", "core-w"]) {
    const f = fixture();
    f.selected[phase] = [];
    rejects("SELECTION_MISMATCH", () =>
      validateSelections(f.manifest, f.selected, f.phases, "product"),
    );
    check(fixture());
  }
});

test("persistent case duplicated across phases or omitted is rejected", () => {
  const f = fixture();
  f.phases.push({ name: "persistent-c", project: browsers[0], args: [] });
  f.selected["persistent-c"] = [f.discovered[0]];
  rejects("DUPLICATE_SELECTION", () =>
    validateSelections(f.manifest, f.selected, f.phases, "product"),
  );
  f.selected["persistent-c"] = [];
  rejects("EMPTY_PHASE", () => validateSelections(f.manifest, f.selected, f.phases, "product"));
  check(fixture());
});

test("reserved/fact config provenance and same-size phase substitution fail", () => {
  const f = fixture();
  const wrong = structuredClone(f.selected);
  wrong["core-c"][0].config = "playwright.v2-split.config.ts";
  rejects("CONFIG_PROVENANCE", () => validateSelections(f.manifest, wrong, f.phases, "product"));
  const substituted = structuredClone(f.selected);
  substituted["core-w"] = [{ ...substituted["core-c"][0] }];
  rejects("PHASE_PROVENANCE", () =>
    validateSelections(f.manifest, substituted, f.phases, "product"),
  );
  check(f);
});

test("unknown stage/project/config, duplicate identity and empty m0 fail closed", () => {
  const f = fixture();
  rejects("EMPTY_PHASE", () =>
    validateManifest(
      f.manifest,
      [file],
      [...f.phases, { name: "unmapped", project: browsers[0], args: [] }],
      "product",
    ),
  );
  rejects("EMPTY_STAGE", () => validateManifest(f.manifest, [file], f.phases, "m0"));
  rejects("UNKNOWN_STAGE", () => validateManifest(f.manifest, [file], f.phases, "future"));
  for (const field of ["browser", "config"]) {
    const changed = structuredClone(f.manifest);
    changed.cases[0][field] = "unknown";
    rejects("MANIFEST_SCHEMA", () => validateManifest(changed, [file], f.phases, "product"));
  }
  f.manifest.cases.push(f.manifest.cases[0]);
  rejects("DUPLICATE_CASE", () => validateManifest(f.manifest, [file], f.phases, "product"));
  check(fixture());
});

const context = {
  sha: "a".repeat(40),
  run: "run-one",
  phase: "core-c",
  selectionHash: "selection",
  root: "/candidate",
  reportPath: "/owned/run-one/results.json",
  startedAt: "2026-10-17T00:00:00.000Z",
};
function execution() {
  return {
    provenance: { ...context },
    report: {
      errors: [],
      stats: { startTime: context.startedAt },
      config: {
        rootDir: "/candidate/apps/web/e2e",
        configFile: "/candidate/apps/web/playwright.config.ts",
        projects: [{ name: browsers[0], retries: 0 }],
      },
      suites: [
        {
          title: "09-offline-sync.spec.ts",
          specs: [
            {
              title: "roundtrip",
              file: "09-offline-sync.spec.ts",
              ok: true,
              tests: [
                {
                  projectName: browsers[0],
                  expectedStatus: "passed",
                  status: "expected",
                  annotations: [],
                  results: [{ status: "passed", retry: 0 }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
test("execution requires exact provenance, a fresh nonempty report and every required identity", () => {
  const f = fixture();
  const expected = [f.manifest.cases[0]];
  const valid = execution();
  validateExecution(valid, context, expected);
  for (const key of ["sha", "run", "phase", "selectionHash", "root", "reportPath"]) {
    const e = execution();
    e.provenance[key] = "old";
    rejects("REPORT_PROVENANCE", () => validateExecution(e, context, expected));
  }
  rejects("REPORT_MISSING", () => validateExecution(null, context, expected));
  const empty = execution();
  empty.report.suites = [];
  rejects("EXECUTION_MISMATCH", () => validateExecution(empty, context, expected));
  const old = execution();
  old.report.stats.startTime = "2020-01-01T00:00:00Z";
  rejects("STALE_REPORT", () => validateExecution(old, context, expected));
  const wrongConfig = execution();
  wrongConfig.report.config.configFile = "/candidate/apps/web/playwright.v2-split.config.ts";
  rejects("CONFIG_PROVENANCE", () => validateExecution(wrongConfig, context, expected));
  validateExecution(valid, context, expected);
});

test("required runtime skip, fixme, only, failure, flaky/retry or missing result is RED", () => {
  const expected = [fixture().manifest.cases[0]];
  for (const change of [
    (s, t) => {
      t.results[0].status = "skipped";
    },
    (s, t) => {
      t.annotations.push({ type: "fixme" });
    },
    (s) => {
      s.only = true;
    },
    (s, t) => {
      t.results[0].status = "failed";
    },
    (s, t) => {
      t.status = "flaky";
    },
    (s, t) => {
      t.results[0].retry = 1;
    },
    (s, t) => {
      t.results = [];
    },
  ]) {
    const e = execution();
    const spec = e.report.suites[0].specs[0];
    change(spec, spec.tests[0]);
    rejects("REQUIRED_OUTCOME", () => validateExecution(e, context, expected));
    validateExecution(execution(), context, expected);
  }
});

test("approved selection exclusions cannot permit a skipped required case or empty stage", () => {
  const f = fixture();
  const chromiumCase = row(browsers[0], "@chromium-only case");
  f.manifest.cases.push(chromiumCase);
  f.discovered.push(chromiumCase);
  f.selected["core-c"].push(chromiumCase);
  f.manifest.exclusions = [
    {
      ...row(browsers[1], "@chromium-only case"),
      condition: "webkit-chromium-only",
      reason: "TEST_SCOPE WebKit navigation limitation",
    },
  ];
  check(f);
  rejects("DISCOVERY_MISMATCH", () =>
    validateDiscovery(f.manifest, [...f.discovered, f.manifest.exclusions[0]], "product"),
  );
  rejects("EMPTY_STAGE", () => validateManifest(f.manifest, [file], f.phases, "m0"));
});

function allocation() {
  const owner = {
    run: "r1",
    phase: "core-c",
    containerId: "id1",
    container: "afc_one",
    label: "one",
    dbPort: 45678,
    names: ["afc_one_e2e"],
    e2eUser: "user1",
    profiles: "/owned/profiles1",
    output: "/owned/output1",
    profile: makeProfile("direct", 41201, 41202),
  };
  const url = "postgresql://postgres:secret@127.0.0.1:45678/afc_one_e2e";
  const env = {
    ...profileEnv(owner.profile),
    DATABASE_URL: url,
    DIRECT_URL: url,
    E2E_DATABASE_URL: url,
    E2E_DEV_USER_ID: owner.e2eUser,
    AFC_TEST_RUN_ID: owner.run,
    AFC_POSITION_PROFILE_ROOT: owner.profiles,
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
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45678" }] } },
  };
  return { owner, env, inspect };
}
test("nonowned host/container, DIRECT_URL mismatch fail before launch without leaking URLs", () => {
  for (const change of [
    (a) => {
      a.env.DIRECT_URL += "different";
    },
    (a) => {
      for (const k of ["DATABASE_URL", "DIRECT_URL", "E2E_DATABASE_URL"])
        a.env[k] = a.env[k].replace("127.0.0.1", "remote.example");
    },
    (a) => {
      a.inspect.Config.Labels["afc.run"] = "foreign";
    },
    (a) => {
      a.inspect.Id = "foreign";
    },
    (a) => {
      a.inspect.Config.Labels["afc.owner"] = "foreign";
    },
    (a) => {
      a.inspect.Config.Labels["afc.purpose"] = "foreign";
    },
    (a) => {
      a.inspect.HostConfig.Tmpfs = {};
    },
    (a) => {
      a.inspect.Mounts = [{ Type: "volume" }];
    },
    (a) => {
      a.inspect.Config.Image = "postgres:15";
    },
    (a) => {
      a.inspect.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0";
    },
  ]) {
    const a = allocation();
    change(a);
    assert.throws(
      () => validateAllocation(a.owner, a.env, a.inspect, []),
      (e) =>
        e.code === "OWNERSHIP" &&
        !e.message.includes("secret") &&
        !e.message.includes("postgresql"),
    );
    const good = allocation();
    validateAllocation(good.owner, good.env, good.inspect, []);
  }
});

test("new direct/proxy duplicate title and missing browser cannot masquerade as a complete m0", () => {
  const f = fixture();
  f.manifest.cases = [
    {
      ...row(browsers[0]),
      stage: "m0",
      case: ["M0-06 direct", "shell consumes real API contract"],
    },
    {
      ...row(browsers[1]),
      stage: "m0",
      case: ["M0-06 direct", "shell consumes real API contract"],
    },
  ];
  validateManifest(f.manifest, [file], f.phases, "m0");
  rejects("DISCOVERY_MISMATCH", () => validateDiscovery(f.manifest, [f.manifest.cases[0]], "m0"));
  f.manifest.cases.push({ ...f.manifest.cases[0] });
  rejects("DUPLICATE_CASE", () => validateManifest(f.manifest, [file], f.phases, "m0"));
});

test("N01 exact env/profile, port collision and unsafe origins fail before launch", () => {
  for (const mode of ["direct", "proxy"]) {
    const p = makeProfile(mode, 42001, 42002);
    assert.deepEqual(profileFromEnv(profileEnv(p)), p);
    for (const change of [
      { apiPort: 0 },
      { webPort: p.apiPort },
      { apiTarget: "https://remote" },
      { apiBase: "/wrong" },
      { proxyOrigin: "http://localhost:3001" },
      { mode: "future" },
    ])
      rejects("PROFILE_INVALID", () => validateProfile({ ...p, ...change }));
    rejects("PROFILE_INVALID", () => validateProfile(p, p.apiPort));
  }
  for (const key of [
    "E2E_API_PORT",
    "E2E_WEB_PORT",
    "E2E_API_TARGET",
    "E2E_API_BASE_URL",
    "API_PROXY_ORIGIN",
  ]) {
    const a = allocation();
    a.env[key] = "sentinel-secret";
    rejects("PROFILE_INVALID", () => validateAllocation(a.owner, a.env, a.inspect, []));
  }
  const a = allocation();
  rejects("ALLOCATION_REUSE", () =>
    validateAllocation(a.owner, a.env, a.inspect, [{ dbPort: a.owner.profile.apiPort }]),
  );
});

test("principal, DB, profile, output and run reuse across phases is rejected", () => {
  const a = allocation();
  validateAllocation(a.owner, a.env, a.inspect, []);
  for (const key of ["run", "containerId", "e2eUser", "profiles", "output"]) {
    rejects("ALLOCATION_REUSE", () =>
      validateAllocation(a.owner, a.env, a.inspect, [{ [key]: a.owner[key] }]),
    );
  }
});

test("discovery adapter receives real config/project/grep args and synthetic DB env", () => {
  const seen = [];
  const f = fixture();
  const result = discover(
    "/candidate",
    ["--config", config, "--project", browsers[0], "--grep", "roundtrip"],
    (request) => {
      seen.push(request);
      return { status: 0, stdout: JSON.stringify(execution().report) };
    },
  );
  assert.equal(result.length, 1);
  assert.ok(seen[0].args.includes("--list"));
  assert.ok(seen[0].args.includes("--forbid-only"));
  assert.deepEqual(seen[0].args.slice(0, 6), [
    "--config",
    config,
    "--project",
    browsers[0],
    "--grep",
    "roundtrip",
  ]);
  assert.equal(seen[0].env.DATABASE_URL, seen[0].env.DIRECT_URL);
  assert.equal(new URL(seen[0].env.DATABASE_URL).hostname, "127.0.0.1");
  assert.ok(new URL(seen[0].env.DATABASE_URL).pathname.endsWith("_e2e"));
  assert.equal(seen[0].cwd, path.join("/candidate", "apps/web"));
  assert.equal(caseKey(result[0]), caseKey(f.manifest.cases[0]));
  for (const failure of [
    { status: 1 },
    { status: null, signal: "SIGTERM" },
    { status: 0, error: new Error("spawn") },
  ]) {
    rejects("DISCOVERY_CHILD", () => discover("/candidate", [], () => failure));
  }
});
