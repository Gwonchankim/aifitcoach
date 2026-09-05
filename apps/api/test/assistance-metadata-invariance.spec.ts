import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { assistanceSessionVerdict, type AssistanceSessionRow } from "shared";
import type * as Adapter from "../src/programs/assistance-migration";

const original = readFileSync(
  path.join(__dirname, "support/assistance-migration-baseline.fixture"),
  "utf8",
);
const current = readFileSync(
  path.join(__dirname, "../src/programs/assistance-migration.ts"),
  "utf8",
);
type AdapterModule = typeof Adapter & {
  toSessionRow(row: Adapter.AssistanceTargetRow): AssistanceSessionRow;
};

/** Execute the fixed f8627cb adapter against the SAME current shared predicate as the new adapter. */
function loadAdapter(source: string): AdapterModule {
  const compiled = ts.transpileModule(`${source}\nexport { toSessionRow };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    createRequire(__filename),
    module,
    module.exports,
  );
  return module.exports as AdapterModule;
}
const oldAdapter = loadAdapter(original);
const newAdapter = loadAdapter(current);

describe("approved action metadata preserves raw safety and protected code", () => {
  it("pins the historical adapter and keeps every non-adapter function AST unchanged", () => {
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "0d4d6b4cb9bc76a181b0a0508de1ba367846bda469c8a128f2208bffe3cfab35",
    );
    const printer = ts.createPrinter();
    const functions = (source: string) => {
      const file = ts.createSourceFile("adapter.ts", source, ts.ScriptTarget.Latest, true);
      return Object.fromEntries(
        file.statements
          .filter(ts.isFunctionDeclaration)
          .filter(
            (node) =>
              !["recommendedActionFor", "toRawTargetRow", "toSessionRow"].includes(node.name!.text),
          )
          .map((node) => [node.name!.text, printer.printNode(ts.EmitHint.Unspecified, node, file)]),
      );
    };
    expect(functions(current)).toEqual(functions(original));
  });

  it("1440 normal/malformed raw fixtures retain exact verdict, reasons, cohorts and non-action fields", () => {
    let checked = 0;
    const cases = [
      { reasonCode: "ASSISTANCE_MINIMUM_REACHED", recommendedWeight: 2.5 },
      { reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET", recommendedWeight: 17.5 },
      { reasonCode: "SUBSTITUTE_PAIN", recommendedWeight: null },
      { reasonCode: "INVALID_INPUT", recommendedWeight: null },
      { reasonCode: "ASSISTANCE_CALIBRATION_NEEDED", recommendedWeight: null },
      { reasonCode: "ASSISTANCE_MINIMUM_REACHED", recommendedWeight: 0 },
    ];
    for (const exerciseId of [
      "e_assisted_pullup",
      "e_assisted_dips",
      undefined,
      "unknown",
      "e_bench_press",
    ])
      for (const loadSemantics of ["assistance", "external_load"] as const)
        for (const assistanceProvenance of [
          "native",
          "remediated",
          "legacy_performed",
          null,
        ] as const)
          for (const rulesVersion of ["2026.08.2", "2026.08.1", "unknown"])
            for (const variant of cases)
              for (const performed of [false, true]) {
                const row: Adapter.AssistanceTargetRow = {
                  exerciseId,
                  loadSemantics,
                  assistanceProvenance,
                  rulesVersion,
                  assistanceStepKg: loadSemantics === "assistance" ? 2.5 : null,
                  confidence: 0.85,
                  hasServerAppliedPerformedFact: performed,
                  ...variant,
                };
                const before = oldAdapter.toSessionRow(row);
                const after = newAdapter.toSessionRow(row);
                expect({ ...after, recommended_action: null }).toEqual({
                  ...before,
                  recommended_action: null,
                });
                expect(assistanceSessionVerdict([after])).toEqual(
                  assistanceSessionVerdict([before]),
                );
                expect(newAdapter.rawAssistanceSafetyStatus(row)).toBe(
                  oldAdapter.rawAssistanceSafetyStatus(row),
                );
                expect(newAdapter.classifyTargetCohort([row])).toBe(
                  oldAdapter.classifyTargetCohort([row]),
                );
                expect(newAdapter.classifySourceCohort([row])).toBe(
                  oldAdapter.classifySourceCohort([row]),
                );
                expect(newAdapter.toRawTargetRow(row, performed)).toEqual({
                  ...oldAdapter.toRawTargetRow(row, performed),
                  exerciseId,
                });
                expect(after.recommended_action).toEqual(
                  newAdapter.recommendedActionFor(row.reasonCode, exerciseId, loadSemantics),
                );
                checked += 1;
              }
    expect(checked).toBe(1440);
  });
});
