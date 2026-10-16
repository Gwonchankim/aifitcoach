import assert from "node:assert/strict";
import { test } from "node:test";
import {
  phases,
  phaseArgs,
  cleanContainer,
  executeOwnedPhase,
  runPhaseSeries,
  withCleanup,
} from "./ci-e2e.mjs";
import { loadManifest, validateSelections } from "./ci-e2e.manifest.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
const { structuredClone } = globalThis;

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
    phase: "cleanup-only",
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
  assert.equal(phases.length, 16);
  assert.throws(
    () => validateSelections(manifest, selected, phases, "product"),
    (e) => e.code === "DUPLICATE_SELECTION",
  );
  selected["historical-w"] = manifest.cases.filter((r) => r.phase === "historical-w");
  validateSelections(manifest, selected, phases, "product");
});

test("both browsers retain separate native and historical fresh-principal phases", () => {
  assert.equal(phases.length, 16);
  assert.equal(new Set(phases.map((phase) => phase.name)).size, 16);
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
    Config: { Labels: { "afc.run": owner.run } },
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
  };
  return {
    request: { phase: phases[0], owner, env, inspect, previous: [], context, expected },
    adapters,
    seen,
    report,
  };
}

test("owned launcher receives actual phase selectors/config/env and validates its report", () => {
  const f = ownedFixture();
  executeOwnedPhase(f.request, f.adapters);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].command, "pnpm");
  assert.deepEqual(f.seen[0].args, [
    ...phaseArgs(phases[0]),
    "--reporter=list,html,json",
    "--forbid-only",
  ]);
  assert.equal(f.seen[0].options.env, f.request.env);
  assert.equal(f.seen[0].options.cwd, path.join(f.request.context.root, "apps/web"));
  assert.equal(f.seen[0].options.shell, false);
  assert.deepEqual(f.request.previous, [f.request.owner]);
});

test("ownership and old-report faults stop the actual launcher before migration/server spawn", () => {
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
    assert.throws(() => executeOwnedPhase(f.request, f.adapters));
    assert.equal(f.seen.length, 0);
    const good = ownedFixture();
    executeOwnedPhase(good.request, good.adapters);
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
    executeOwnedPhase(good.request, good.adapters);
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
    return JSON.stringify([good.request.inspect]);
  });
  assert.deepEqual(calls, [
    ["inspect", "id1"],
    ["stop", "id1"],
    ["rm", "-v", "id1"],
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
  assert.equal((yaml.match(/- if: failure\(\)/g) ?? []).length, 2);
  assert.ok(yaml.includes("path: apps/web/C:/Users/amole/.traycer/evidence"));
});

test("pinned manifest covers the independent baseline file inventory and phase/browser partition", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = loadManifest(root);
  assert.equal(manifest.baselineSha, "7825c93ac9b1cc3ae8ae494b07ad7e693f6352cd");
  assert.equal(new Set(manifest.cases.map((r) => r.file)).size, 26);
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
