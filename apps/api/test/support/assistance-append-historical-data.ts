/** Test-only derivation from pinned oracle bytes; never imports/runs the Jest suite or SQL.
 * The matrix supplies raw values, not historical-writer evidence. Migration (b) supplies
 * the remediated prescription correction. Source changes require an explicit review.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import type { Prisma } from "@prisma/client";
import ts from "typescript";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MATRIX = {
  file: "test/session-set-assistance-wire.spec.ts",
  sha256: "ec19104563e8e46bd044d7a908aaba5f5d5258e329ffa8208336f7cdbcd1fe7c",
};
const MIGRATION = {
  file: "prisma/migrations/20260827180000_f3_fixup_assistance_lifecycle/migration.sql",
  sha256: "c60ebf12d66d399d8d50a9606871c226a4d3fc15a3c0e234497244040a9aa21e",
};
const ITEM_IDS = {
  external: [
    "external assisted ID e_assisted_pullup external snapshot sample0",
    "external assisted ID e_assisted_dips external snapshot sample0",
  ],
  remediated: [
    "allowed assistance e_assisted_pullup remediated calibration null sample0",
    "allowed assistance e_assisted_dips remediated calibration null sample0",
  ],
};
type Raw = Omit<Prisma.PlannedSetCreateManyInput, "id" | "sessionId" | "clientCorrelationId">;

function pinned(source: { file: string; sha256: string }) {
  const bytes = readFileSync(path.resolve(__dirname, "../..", source.file));
  if (sha(bytes) !== source.sha256) throw new Error("FIXTURE_SOURCE_HASH");
  return bytes.toString("utf8");
}
function only<T>(values: T[]): T {
  if (values.length !== 1) throw new Error("FIXTURE_SOURCE_SELECTION");
  return values[0];
}

export function deriveAssistanceHistoricalData(mode: keyof typeof ITEM_IDS) {
  const matrix = pinned(MATRIX);
  const sql = pinned(MIGRATION);
  const source = ts.createSourceFile(MATRIX.file, matrix, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Expression[]>();
  const titles = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      declarations.set(name, [...(declarations.get(name) ?? []), node.initializer]);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === "it.each" &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      titles.set(node.expression.arguments[0].getText(source), node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const expression = (name: string) => only(declarations.get(name) ?? []).getText(source);
  const names = [
    "IDS",
    "SAMPLES",
    "assistance",
    "assistanceStates",
    "allowedAssistance",
    "externalAssisted",
  ];
  // Only these pinned pure declarations and the fixture's actual base expression run.
  // No require/import, Jest lifecycle, clock, Prisma or filesystem is exposed to the VM.
  const code =
    names.map((name) => `const ${name} = ${expression(name)};`).join("\n") +
    `
    [...allowedAssistance.map(row => ({ ...row, title: ${JSON.stringify(titles.get("allowedAssistance"))} })),
     ...externalAssisted.map(row => ({ ...row, title: ${JSON.stringify(titles.get("externalAssisted"))} }))]
    .map(scenario => {
      const exerciseId = scenario.raw.exerciseId;
      const base = ${expression("base")};
      return { itemId: scenario.title.replace("$name", scenario.name), raw: { ...base, ...scenario.raw } };
    });`;
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText;
  const cases = JSON.parse(
    JSON.stringify(
      runInNewContext(compiled, Object.create(null), {
        timeout: 1_000,
        contextCodeGeneration: { strings: false, wasm: false },
      }),
    ),
  ) as { itemId: string; raw: Raw }[];

  // Parse the pinned migration (b) SET literals; never execute UPDATE or repeat its values by hand.
  const correctionSql = only([
    ...sql.matchAll(
      /UPDATE "planned_sets"\s+SET ([\s\S]*?)\s+WHERE "assistance_provenance" = 'remediated';/g,
    ),
  ]);
  const correction = Object.fromEntries(
    correctionSql[1].split(",").map((assignment) => {
      const match = /^\s*"([a-z_]+)" = (NULL|'[^']*'|\d+)\s*$/.exec(assignment);
      if (!match) throw new Error("FIXTURE_MIGRATION_LITERAL");
      const key = match[1].replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const literal = match[2];
      return [
        key,
        literal === "NULL"
          ? null
          : literal.startsWith("'")
            ? literal.slice(1, -1)
            : Number(literal),
      ];
    }),
  );
  const selected = ITEM_IDS[mode].map((itemId) =>
    only(cases.filter((row) => row.itemId === itemId)),
  );
  return {
    rows: selected.map(({ raw }) => (mode === "remediated" ? { ...raw, ...correction } : raw)),
    provenance: {
      matrix: MATRIX,
      items: selected,
      migration: { ...MIGRATION, correctionSql: correctionSql[0] },
      appliedCorrection: mode === "remediated" ? correction : null,
    },
  };
}
