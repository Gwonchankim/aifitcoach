import assert from "node:assert/strict";
import { test } from "node:test";
import { phases, phaseArgs } from "./ci-e2e.mjs";

test("both browsers retain separate native and historical fresh-principal phases", () => {
  assert.equal(phases.length, 14);
  assert.equal(new Set(phases.map((phase) => phase.name)).size, 14);
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
