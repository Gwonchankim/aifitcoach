import assert from "node:assert/strict";
import { test } from "node:test";
import { phases, phaseArgs } from "./ci-e2e.mjs";

test("both browsers retain separate native and historical fresh-principal phases", () => {
  assert.equal(phases.length, 7);
  assert.equal(new Set(phases.map((phase) => phase.name)).size, 7);
  for (const project of ["chromium-mobile", "webkit-ios"]) {
    for (const spec of ["18-assistance-append.spec.ts", "19-assistance-historical.spec.ts"]) {
      assert.equal(
        phases.filter((phase) => phase.project === project && phase.args.includes(spec)).length,
        1,
      );
    }
  }
});

test("core selection includes 00 through 17 on both OS paths, excludes fresh-principal specs", () => {
  for (const phase of phases.filter((phase) => phase.core)) {
    const patterns = phaseArgs(phase).filter((value) => value.startsWith("^.*"));
    assert.equal(patterns.length, 18);
    for (const separator of ["/", "\\"]) {
      for (let index = 0; index < 20; index++) {
        const file = `e2e${separator}${String(index).padStart(2, "0")}-example.spec.ts`;
        assert.equal(
          patterns.some((pattern) => new RegExp(pattern).test(file)),
          index < 18,
        );
      }
    }
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
