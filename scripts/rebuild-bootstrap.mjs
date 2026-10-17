/**
 * 재구축 bootstrap 검사 — 기준선 ledger·git object·후보 작업 트리를 **바이트**로 대조한다.
 *
 *   pnpm ci:bootstrap            (= node scripts/rebuild-bootstrap.mjs, 기본 --stage m0-dd1-docs)
 *
 * 기준선 SHA·행 수·목록 digest·승인 분류 digest 는 BASELINE 상수로 고정한다. CLI 에는 이 값을 바꾸는 인자가 없다 —
 * 합성 저장소 시험만 runChecks() 에 expected 를 넣는다. ledger 에 적힌 해시를 스스로 믿지 않고
 * 매번 git object 를 다시 읽어 재계산한다. 비교는 전부 Buffer 기준이라 CRLF blob 도 그대로 맞는다.
 * import 만으로는 아무것도 실행하지 않는다(검사는 CLI 로 실행할 때만 돈다).
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const BASELINE = Object.freeze({
  sha: "7825c93ac9b1cc3ae8ae494b07ad7e693f6352cd",
  rows: 837,
  digest: "d71228fb86896ac9de620e77324aecbc16ea1ec2da62555a09fc870dfff1a97e",
  // 승인 path→type 분류(`path\ttype\n`). 기준선 목록 6개 표에서 산출했다 — 후보 ledger 에서 만들지 않는다.
  typeDigest: "098259acf3816cda51a43077a71eb3a759943399b21c9d71d2abe4a38fa3af61",
});

export const LEDGER_PATH = "regression/ledger.json";
export const TYPES = Object.freeze(["N", "R", "F", "T", "G", "D", "S", "E", "K", "O"]);
export const STATUSES = Object.freeze([
  "active",
  "pending-replacement",
  "preserved-unported",
  "ported",
  "contract-replaced",
  "retired",
]);
const ROW_KEYS = Object.freeze([
  "path",
  "blob",
  "sha256",
  "type",
  "owner",
  "stage",
  "status",
  "candidate_ref",
  "evidence",
  "decision_ref",
]);
/** 이 상태들만 기준선 바이트를 그대로 유지해야 한다. 나머지는 증거가 있어야 존재할 수 있다. */
const BASELINE_BYTES = Object.freeze(["active", "pending-replacement", "preserved-unported"]);
const DEP_SECTIONS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies"]);

export const initialStatus = (type) =>
  type === "N" ? "pending-replacement" : type === "T" ? "preserved-unported" : "active";

/**
 * 단계별 규칙. 알 수 없는 단계는 실패한다 — 미래 단계를 성공 no-op 으로 두지 않는다.
 * m0-01: package.json 의 ci:bootstrap 추가와 아래 신규 3파일만 허용. 기준선 바이트·상태 전환 0.
 * m0-03: 허용 신규 파일만 누적(m0-01 3 + 원천 fixture 검증 2 + 생성 타입 소비 검사 2). 그 밖 보호는 m0-01 그대로.
 * m0-02a: 신규 파일을 더 누적(m0-03 7 + CI manifest 3)하고, approvedChanges 의 정확한 기존 3경로만
 *   이 단계에서 바이트 변경을 허용한다(검사 3). 삭제·부재는 여전히 실패다. 그 밖 보호는 m0-01 그대로.
 * m0-04: 신규 파일을 더 누적(m0-02a 10 + seed helper·기반 spec 2)하고 approvedChanges 에 seed 1경로를 더한다
 *   (검사 3·4 의 바이트 대조에서만 뺀다). contractReplaced 의 정확한 6경로만 ledger 상태를 contract-replaced 로
 *   바꿀 수 있고, 바꾼 행만 바이트 차이를 허용한다(검사 3·4). 이 6경로는 refs 가 있어도 같은 경로에 파일이
 *   있어야 한다. 그 밖 보호는 m0-02a 그대로.
 * m0-05: m0-04 에 FE 기반 spec 1(신규 13), verify 스크립트 2(바이트 예외 6), 셸 7(전환 대상 13)만 더한다.
 *   목록에 넣는 것은 기술적 허용일 뿐 개별 재사용·완료 승인이 아니다 — 전환 전 셸 행은 pending 이고 바이트가
 *   바뀌면 실패한다. 일부만 전환하고 나머지를 원문·pending 으로 두는 것도 통과한다. 그 밖 보호는 m0-04 그대로.
 * m0-06: m0-05 에 E2E shell·API spec 1(신규 14)과 base Playwright config 1·API 시험 1(바이트 예외 8)만 더한다.
 *   전환 13 은 그대로다. 경로 허용일 뿐 spec·config 의 실제 구현·승계가 아니다 — 같은 디렉터리의 derived config 는
 *   예외 밖이고, 승인 경로도 부재는 실패다. API 시험(cardio-program.spec)은 다음 suite 를 오염시키던 종료 정리
 *   누락만 고친 T행 하나의 격리 결함 예외다 — ledger 상태·T 집계는 그대로이고 이관·ported 로 세지 않는다.
 *   그 밖 보호는 m0-05 그대로.
 * m0-final-commands: m0-06 에 root 명령 본체·자체 시험 2(신규 16)와 package script 2(ci:m0·ci:product —
 *   scriptAdditions 3)만 더한다. 승인 8·전환 13 은 그대로고, script 는 정확한 이름·명령일 때만 허용하며 둘 다
 *   있어야 한다. docs 경로 예외는 없다. 그 밖 보호는 m0-06 그대로.
 * m0-dd1-docs: m0-final-commands 에 D-D1 docs 정확 2경로(DESIGN_TOKENS·ARCHITECTURE)의 바이트 예외(승인 10)만
 *   더한다. 신규 16·전환 13·script 3 은 그대로다. 정확한 경로 문자열만 — docs prefix·형제 경로의 해제가 아니고
 *   부재는 실패다. ledger 의 두 D행(원문 blob/sha256·active)은 그대로 두고, 바뀐 바이트는 승인 예외 보고 줄로만
 *   드러낸다. 그 밖 보호는 m0-final-commands 그대로.
 */
const stages = {
  "m0-01": Object.freeze({
    newFiles: Object.freeze([
      LEDGER_PATH,
      "scripts/rebuild-bootstrap.mjs",
      "scripts/rebuild-bootstrap.test.mjs",
    ]),
    manifestPath: "package.json",
    scriptAdditions: Object.freeze({ "ci:bootstrap": "node scripts/rebuild-bootstrap.mjs" }),
    lockPath: "pnpm-lock.yaml",
    frozenPrefixes: Object.freeze(["apps/", "packages/", "docs/"]),
    lifecycleInputs: Object.freeze([
      "apps/api/prisma/schema.prisma",
      "packages/shared/tsconfig.build.json",
      "packages/shared/src/index.ts",
      "apps/web/scripts/add-generated-banner.mjs",
    ]),
    importers: Object.freeze({
      ".": "package.json",
      "apps/api": "apps/api/package.json",
      "apps/web": "apps/web/package.json",
      "packages/shared": "packages/shared/package.json",
    }),
  }),
};
stages["m0-03"] = Object.freeze({
  ...stages["m0-01"],
  newFiles: Object.freeze([
    ...stages["m0-01"].newFiles,
    "scripts/rebuild-fixtures.mjs",
    "scripts/rebuild-fixtures.test.mjs",
    "scripts/rebuild-api-types.check.ts",
    "scripts/tsconfig.rebuild-api-types.json",
  ]),
});
stages["m0-02a"] = Object.freeze({
  ...stages["m0-03"],
  newFiles: Object.freeze([
    ...stages["m0-03"].newFiles,
    "scripts/ci-e2e.manifest.mjs",
    "scripts/ci-e2e.manifest.test.mjs",
    "apps/web/e2e/ci-manifest.json",
  ]),
  // 정확한 경로 문자열만 — prefix·glob 이 아니다. 기준선 행의 path/blob/sha256·status 는 그대로 둔다.
  approvedChanges: Object.freeze([
    ".github/workflows/ci.yml",
    "scripts/ci-e2e.mjs",
    "scripts/ci-e2e.test.mjs",
  ]),
});
stages["m0-04"] = Object.freeze({
  ...stages["m0-02a"],
  newFiles: Object.freeze([
    ...stages["m0-02a"].newFiles,
    "apps/api/prisma/seed-load-semantics.ts",
    "apps/api/test/rebuild-foundation.spec.ts",
  ]),
  // seed 는 R·active·기준선 해시를 그대로 둔다. 실제 diff 가 import 한 줄뿐인지는 이 예외가 보증하지 않는다.
  approvedChanges: Object.freeze([
    ...stages["m0-02a"].approvedChanges,
    "apps/api/prisma/seed-exercises.ts",
  ]),
  // 같은 경로 교체(in-place)만 — 이동·삭제·형제 경로·prefix 가 아니다.
  contractReplaced: Object.freeze([
    "apps/api/src/main.ts",
    "apps/api/src/app.module.ts",
    "apps/api/src/prisma/prisma.module.ts",
    "apps/api/src/prisma/prisma.service.ts",
    "apps/api/src/common/date/utc-day.ts",
    "apps/api/src/common/http/error-envelope.filter.ts",
  ]),
});
stages["m0-05"] = Object.freeze({
  ...stages["m0-04"],
  newFiles: Object.freeze([
    ...stages["m0-04"].newFiles,
    "apps/web/test/rebuild-foundation.test.tsx",
  ]),
  approvedChanges: Object.freeze([
    ...stages["m0-04"].approvedChanges,
    "apps/web/scripts/verify-no-test-seed.mjs",
    "apps/web/scripts/verify-contrast.mjs",
  ]),
  contractReplaced: Object.freeze([
    ...stages["m0-04"].contractReplaced,
    "apps/web/app/layout.tsx",
    "apps/web/app/page.tsx",
    "apps/web/app/providers.tsx",
    "apps/web/app/globals.css",
    "apps/web/app/sw.ts",
    "apps/web/components/navigation/app-shell.tsx",
    "apps/web/components/ui/cn.ts",
  ]),
});
stages["m0-06"] = Object.freeze({
  ...stages["m0-05"],
  newFiles: Object.freeze([...stages["m0-05"].newFiles, "apps/web/e2e/m0-06-shell-api.spec.ts"]),
  approvedChanges: Object.freeze([
    ...stages["m0-05"].approvedChanges,
    "apps/web/playwright.config.ts",
    "apps/api/test/cardio-program.spec.ts",
  ]),
});
stages["m0-final-commands"] = Object.freeze({
  ...stages["m0-06"],
  newFiles: Object.freeze([
    ...stages["m0-06"].newFiles,
    "scripts/ci-m0.mjs",
    "scripts/ci-m0.test.mjs",
  ]),
  scriptAdditions: Object.freeze({
    ...stages["m0-06"].scriptAdditions,
    "ci:m0": "node scripts/ci-m0.mjs",
    "ci:product": "node scripts/ci-m0.mjs --stage product",
  }),
});
stages["m0-dd1-docs"] = Object.freeze({
  ...stages["m0-final-commands"],
  // 정확한 경로 문자열만 — docs prefix·형제 경로가 아니다. ledger 의 두 D행은 원문 그대로 둔다.
  approvedChanges: Object.freeze([
    ...stages["m0-final-commands"].approvedChanges,
    "docs/DESIGN_TOKENS.md",
    "docs/ARCHITECTURE.md",
  ]),
});
export const STAGES = Object.freeze(stages);

/** 인자 없는 CLI(pnpm ci:bootstrap)와 runChecks 가 같은 단계를 검사하도록 기본값을 한곳에서 정한다. */
const DEFAULT_STAGE = "m0-dd1-docs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toAbs = (root, file) => path.join(root, ...file.split("/"));

function git(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], { input, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} 실패: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
}

const CONTENT_LINE = (entry) => `${entry.path}\t${entry.blob}\t${entry.sha256}\n`;
const TYPE_LINE = (entry) => `${entry.path}\t${entry.type}\n`;

/**
 * 기준선 목록 digest: 경로 바이트순으로 line(entry) 을 이어 붙인 UTF-8 의 SHA-256.
 * 기본은 내용 `path\tblob\tsha256\n`, 분류 digest 는 TYPE_LINE(`path\ttype\n`) 으로 같은 정렬을 쓴다.
 */
export function inventoryDigest(entries, line = CONTENT_LINE) {
  const lines = [...entries]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))
    .map(line)
    .join("");
  return sha256(Buffer.from(lines, "utf8"));
}

function readTree(root, sha) {
  const tree = new Map();
  for (const record of git(root, ["ls-tree", "-r", "-z", "--full-tree", sha])
    .toString("utf8")
    .split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    tree.set(record.slice(tab + 1), { mode, type, oid });
  }
  return tree;
}

function readBlobs(root, oids) {
  const unique = [...new Set(oids)];
  const out = git(root, ["cat-file", "--batch"], unique.join("\n") + "\n");
  const blobs = new Map();
  let position = 0;
  for (const oid of unique) {
    const newline = out.indexOf(0x0a, position);
    const [headerOid, headerType, headerSize] = out
      .subarray(position, newline)
      .toString("utf8")
      .split(" ");
    if (headerOid !== oid || headerType !== "blob") {
      throw new Error(`git object ${oid} 을 blob 으로 읽지 못했다(${headerType})`);
    }
    const size = Number(headerSize);
    blobs.set(oid, out.subarray(newline + 1, newline + 1 + size));
    position = newline + 1 + size + 1;
  }
  return blobs;
}

function readWorking(root, file) {
  try {
    const abs = toAbs(root, file);
    return statSync(abs).isFile() ? readFileSync(abs) : null;
  } catch {
    return null;
  }
}

const unquote = (value) => value.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");

/**
 * pnpm lockfile v9 의 importers 절에서 specifier 만 읽는 좁은 스캐너다. 범용 YAML 파서가 아니며
 * 형식이 다르면 실패한다. 의존 graph 유지의 1차 근거는 lock 바이트 고정이고 이 대조는 보조다.
 */
export function lockImporters(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "lockfileVersion: '9.0'") throw new Error("lockfileVersion '9.0' 형식이 아니다");
  const start = lines.indexOf("importers:");
  if (start < 0) throw new Error("importers 절이 없다");
  const importers = new Map();
  let importer = null;
  let section = null;
  let dependency = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const importerLine = line.match(/^ {2}(\S.*):$/);
    if (importerLine) {
      importer = new Map();
      importers.set(unquote(importerLine[1]), importer);
      section = null;
      continue;
    }
    const sectionLine = line.match(/^ {4}(\S.*):$/);
    if (sectionLine) {
      section = DEP_SECTIONS.includes(sectionLine[1]) ? sectionLine[1] : null;
      dependency = null;
      continue;
    }
    const dependencyLine = line.match(/^ {6}(\S.*):$/);
    if (dependencyLine) {
      dependency = unquote(dependencyLine[1]);
      continue;
    }
    const specifier = line.match(/^ {8}specifier: (.*)$/);
    if (specifier && importer && section && dependency !== null) {
      importer.set(`${section}:${dependency}`, unquote(specifier[1]));
    }
  }
  return importers;
}

function manifestDeclarations(manifest) {
  const declarations = new Map();
  for (const section of DEP_SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      declarations.set(`${section}:${name}`, spec);
    }
  }
  return declarations;
}

function rowProblems(row) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return ["객체가 아니다"];
  const problems = [];
  const keys = Object.keys(row);
  for (const key of ROW_KEYS) if (!keys.includes(key)) problems.push(`${key} 없음`);
  for (const key of keys) if (!ROW_KEYS.includes(key)) problems.push(`알 수 없는 필드 ${key}`);
  if (typeof row.path !== "string" || !row.path || /\\|^\/|(^|\/)\.\.(\/|$)/.test(row.path)) {
    problems.push("path 형식");
  }
  if (!/^[0-9a-f]{40}$/.test(row.blob)) problems.push("blob 형식");
  if (!/^[0-9a-f]{64}$/.test(row.sha256)) problems.push("sha256 형식");
  if (!TYPES.includes(row.type)) problems.push(`type ${row.type}`);
  if (!STATUSES.includes(row.status)) problems.push(`status ${row.status}`);
  for (const key of ["owner", "stage"]) {
    if (typeof row[key] !== "string" || !row[key]) problems.push(`${key} 형식`);
  }
  for (const key of ["candidate_ref", "evidence", "decision_ref"]) {
    if (row[key] !== null && (typeof row[key] !== "string" || !row[key])) {
      problems.push(`${key} 형식`);
    }
  }
  return problems;
}

/** 검사 1: ledger 정합 — 행 수·필수 필드·status enum·중복·기준선 digest·승인 분류 digest. */
function checkLedger(ledger, expected, fail) {
  if (ledger?.schema !== 1) fail(1, "schema 가 1 이 아니다");
  if (ledger?.baseline_sha !== expected.sha) fail(1, `baseline_sha 가 ${expected.sha} 가 아니다`);
  if (ledger?.inventory_digest !== expected.digest) {
    fail(1, `inventory_digest 가 ${expected.digest} 가 아니다`);
  }
  const list = Array.isArray(ledger?.rows) ? ledger.rows : [];
  if (!Array.isArray(ledger?.rows)) fail(1, "rows 배열이 없다");
  if (list.length !== expected.rows) {
    fail(1, `rows ${list.length}행 — 기준선 ${expected.rows}행과 다르다`);
  }
  const rows = new Map();
  list.forEach((row, index) => {
    const where = `rows[${index}]${typeof row?.path === "string" ? ` ${row.path}` : ""}`;
    const problems = rowProblems(row);
    if (problems.length > 0) fail(1, `${where}: ${problems.join(", ")}`);
    else if (rows.has(row.path)) fail(1, `${where}: 경로 중복`);
    else rows.set(row.path, row);
  });
  const digest = inventoryDigest(rows.values());
  if (digest !== expected.digest) {
    fail(1, `ledger 의 path·blob·sha256 digest ${digest} 가 기준선 digest 와 다르다`);
  }
  // type 을 status 와 함께 바꾸면 초기 상태 규칙(검사 4)이 바뀐 type 기준으로 통과하므로 분류를 따로 고정한다.
  if (!expected.typeDigest) {
    fail(1, "기대 분류 digest(typeDigest)가 없다 — 분류 검증을 건너뛰지 않는다");
  } else {
    const types = inventoryDigest(rows.values(), TYPE_LINE);
    if (types !== expected.typeDigest) {
      fail(1, `ledger 의 path→type 분류 digest ${types} 가 승인 분류 digest 와 다르다`);
    }
  }
  return rows;
}

/** 검사 2: 기준선 git tree·object 를 다시 읽어 ledger 와 대조한다(ledger 자기값만 믿지 않는다). */
function checkBaseline(root, rows, expected, fail) {
  let tree;
  let blobs;
  try {
    tree = readTree(root, expected.sha);
    blobs = readBlobs(
      root,
      [...tree.values()].filter((entry) => entry.type === "blob").map((entry) => entry.oid),
    );
  } catch (error) {
    fail(2, `기준선 ${expected.sha} 를 git 에서 읽지 못했다: ${error.message}`);
    return null;
  }
  if (tree.size !== expected.rows)
    fail(2, `기준선 tree ${tree.size}개 — ${expected.rows}개가 아니다`);
  const computed = [];
  for (const [file, entry] of tree) {
    if (entry.type !== "blob") {
      fail(2, `${file}: blob 이 아닌 기준선 엔트리(${entry.type})`);
      continue;
    }
    const digest = sha256(blobs.get(entry.oid));
    computed.push({ path: file, blob: entry.oid, sha256: digest });
    const row = rows.get(file);
    if (!row) fail(2, `${file}: 기준선 tree 에 있으나 ledger 에 없다`);
    else if (row.blob !== entry.oid) fail(2, `${file}: ledger blob 이 git object 와 다르다`);
    else if (row.sha256 !== digest) fail(2, `${file}: ledger sha256 이 git object 바이트와 다르다`);
  }
  for (const file of rows.keys()) {
    if (!tree.has(file)) fail(2, `${file}: ledger 에 있으나 기준선 tree 에 없다`);
  }
  const treeDigest = inventoryDigest(computed);
  if (treeDigest !== expected.digest) {
    fail(2, `기준선 tree 재계산 digest ${treeDigest} 가 ${expected.digest} 가 아니다`);
  }
  return { tree, blobs };
}

/**
 * 검사 3: 상태 × 존재. 부재는 상태가 설명해야 하고, 기준선 유지 상태는 바이트가 같아야 한다.
 * 단계가 승인한 정확한 경로(approvedChanges)만 바이트 대조에서 빼고, 실제로 달라졌으면 보고에 남긴다.
 * 같은 경로 교체(contractReplaced) 경로는 refs 가 있어도 부재를 설명하지 못한다.
 */
function checkWorkingTree(root, rows, rules, fail, summary) {
  const working = new Map();
  const approved = rules.approvedChanges ?? [];
  const inPlace = rules.contractReplaced ?? [];
  summary.approvedChanged = [];
  for (const row of rows.values()) {
    const bytes = readWorking(root, row.path);
    working.set(row.path, bytes);
    const replaced = row.status === "ported" || row.status === "contract-replaced";
    if (replaced && (!row.candidate_ref || !row.evidence)) {
      fail(3, `${row.path}: ${row.status} 에는 candidate_ref 와 evidence 가 필요하다`);
    }
    if (row.status === "retired" && !row.decision_ref) {
      fail(3, `${row.path}: retired 에는 승인 decision_ref 가 필요하다`);
    }
    if (bytes === null && inPlace.includes(row.path)) {
      fail(
        3,
        `${row.path}: 같은 경로 교체 대상인데 파일이 없다 — refs 가 있어도 부재를 허용하지 않는다`,
      );
      continue;
    }
    if (bytes === null) {
      const explained =
        (replaced && row.candidate_ref && row.evidence) ||
        (row.status === "retired" && row.decision_ref);
      if (!explained) {
        fail(
          3,
          `${row.path}: 기준선 경로가 없다 — status '${row.status}' 가 부재를 설명하지 못한다`,
        );
      }
      continue;
    }
    // package.json 의 허용 변경(scripts 추가)은 검사 4 가 JSON 으로 판정한다.
    if (row.path === rules.manifestPath || !BASELINE_BYTES.includes(row.status)) continue;
    if (approved.includes(row.path)) {
      if (sha256(bytes) !== row.sha256) summary.approvedChanged.push(row.path);
      continue;
    }
    if (sha256(bytes) !== row.sha256) {
      fail(3, `${row.path}: 바이트가 기준선과 다르다(status ${row.status})`);
    }
  }
  return working;
}

function checkManifest(baseBytes, currentBytes, rules, fail) {
  let base;
  let current;
  try {
    base = JSON.parse(baseBytes.toString("utf8"));
    current = JSON.parse(currentBytes.toString("utf8"));
  } catch (error) {
    fail(4, `${rules.manifestPath} JSON 을 해석하지 못했다: ${error.message}`);
    return;
  }
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (key !== "scripts" && !isDeepStrictEqual(base[key], current[key])) {
      fail(
        4,
        `${rules.manifestPath} '${key}' 가 기준선과 다르다 — 이 단계는 scripts 추가만 허용한다`,
      );
    }
  }
  const baseScripts = base.scripts ?? {};
  const currentScripts = current.scripts ?? {};
  for (const [name, command] of Object.entries(baseScripts)) {
    if (currentScripts[name] !== command) fail(4, `scripts.${name} 이 기준선과 다르다`);
  }
  for (const [name, command] of Object.entries(currentScripts)) {
    if (!Object.hasOwn(baseScripts, name) && rules.scriptAdditions[name] !== command) {
      fail(4, `scripts.${name} 은 이 단계에서 허용한 추가가 아니다`);
    }
  }
  for (const [name, command] of Object.entries(rules.scriptAdditions)) {
    if (currentScripts[name] !== command) fail(4, `scripts.${name} = "${command}" 가 없다`);
  }
}

/**
 * 검사 4: 단계 보존 규칙 — 상태 전환은 contractReplaced 의 정확한 경로가 contract-replaced 가 되는 것만,
 * manifest 는 scripts 추가만, lock·apps/packages/docs 는 바이트 고정이다. apps/packages/docs 아래에서
 * 바이트 차이를 허용하는 것은 approvedChanges 의 정확한 경로와 전환된 contractReplaced 행뿐이고, 부재는
 * 어느 쪽에도 허용하지 않는다(검사 3 과 독립으로 집행한다).
 */
function checkStage(rows, baseline, working, rules, fail, summary) {
  const inPlace = rules.contractReplaced ?? [];
  const approved = rules.approvedChanges ?? [];
  const transitioned = (row) => inPlace.includes(row.path) && row.status === "contract-replaced";
  for (const row of rows.values()) {
    if (row.status === initialStatus(row.type) || transitioned(row)) continue;
    const allowed = inPlace.includes(row.path)
      ? `'${initialStatus(row.type)}' 또는 'contract-replaced'`
      : `초기 상태 '${initialStatus(row.type)}'`;
    fail(4, `${row.path}: 이 단계에서는 ${allowed} 만 허용한다('${row.status}')`);
  }
  summary.contractReplaced = [...rows.values()].filter(transitioned).map((row) => row.path);
  const manifestRow = rows.get(rules.manifestPath);
  const baseManifest =
    manifestRow && baseline?.blobs.get(baseline.tree.get(rules.manifestPath)?.oid);
  const currentManifest = working.get(rules.manifestPath);
  if (!baseManifest || !currentManifest) {
    fail(4, `${rules.manifestPath} 를 기준선과 후보 양쪽에서 읽지 못했다`);
  } else {
    checkManifest(baseManifest, currentManifest, rules, fail);
  }
  const lockRow = rows.get(rules.lockPath);
  const lockBytes = working.get(rules.lockPath);
  if (!lockRow || !lockBytes || sha256(lockBytes) !== lockRow.sha256) {
    fail(4, `${rules.lockPath} 바이트가 기준선과 다르다`);
  }
  let frozen = 0;
  const changed = [];
  for (const row of rows.values()) {
    if (!rules.frozenPrefixes.some((prefix) => row.path.startsWith(prefix))) continue;
    frozen += 1;
    const bytes = working.get(row.path);
    const exempt = approved.includes(row.path) || transitioned(row);
    if (!bytes || (!exempt && sha256(bytes) !== row.sha256)) changed.push(row.path);
  }
  if (changed.length > 0) {
    fail(
      4,
      `${rules.frozenPrefixes.join("·")} 아래 ${changed.length}개 경로가 기준선과 다르다(검사 3 참조)`,
    );
  }
  summary.frozenRows = frozen;
}

/** 검사 5: tracked+untracked(ignore 규칙 밖) 중 기준선 밖 파일은 이 단계 allowlist 여야 한다. */
function checkNewFiles(root, baselinePaths, rules, fail, summary) {
  let listed;
  try {
    listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    fail(5, `후보 파일 목록을 읽지 못했다: ${error.message}`);
    return;
  }
  const extra = [...new Set(listed)].filter((file) => !baselinePaths.has(file)).sort();
  for (const file of extra) {
    if (!rules.newFiles.includes(file))
      fail(5, `${file}: 기준선 밖 파일이 이 단계 allowlist 에 없다`);
  }
  summary.newFiles = extra.filter((file) => rules.newFiles.includes(file));
}

/** 검사 6: lifecycle 입력 존재·원문, manifest 4개 ↔ lock importer 의존 선언 대조. */
function checkLifecycle(root, rows, working, rules, fail, summary) {
  for (const file of rules.lifecycleInputs) {
    const row = rows.get(file);
    const bytes = working.get(file) ?? readWorking(root, file);
    if (!bytes) fail(6, `${file}: lifecycle 입력이 없다`);
    else if (!row) fail(6, `${file}: lifecycle 입력이 ledger 기준선에 없다`);
    else if (sha256(bytes) !== row.sha256)
      fail(6, `${file}: lifecycle 입력이 기준선 원문과 다르다`);
  }
  const lockBytes = working.get(rules.lockPath) ?? readWorking(root, rules.lockPath);
  if (!lockBytes) {
    fail(6, `${rules.lockPath} 가 없다`);
    return;
  }
  let importers;
  try {
    importers = lockImporters(lockBytes.toString("utf8"));
  } catch (error) {
    fail(6, `${rules.lockPath}: ${error.message}`);
    return;
  }
  for (const name of importers.keys()) {
    if (!Object.hasOwn(rules.importers, name))
      fail(6, `lock importer '${name}' 에 대응 manifest 가 없다`);
  }
  let matched = 0;
  for (const [name, manifestPath] of Object.entries(rules.importers)) {
    const lock = importers.get(name);
    const bytes = readWorking(root, manifestPath);
    if (!lock || !bytes) {
      fail(6, `importer '${name}': lock 항목 또는 ${manifestPath} 가 없다`);
      continue;
    }
    let declared;
    try {
      declared = manifestDeclarations(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      fail(6, `${manifestPath} JSON 을 해석하지 못했다: ${error.message}`);
      continue;
    }
    for (const [key, spec] of declared) {
      if (lock.get(key) === spec) matched += 1;
      else fail(6, `${manifestPath} ${key}=${spec} — lock specifier ${lock.get(key) ?? "없음"}`);
    }
    for (const key of lock.keys()) {
      if (!declared.has(key))
        fail(6, `lock importer '${name}' 의 ${key} 가 ${manifestPath} 에 없다`);
    }
  }
  summary.lockDeclarations = matched;
}

/**
 * 전체 검사. expected 기본값은 고정 BASELINE 이다(합성 저장소 시험만 다른 값을 넣는다).
 * 반환: { ok, failures: [{ check, message }], summary }
 */
export function runChecks({ root, expected = BASELINE, stage = DEFAULT_STAGE }) {
  const failures = [];
  const fail = (check, message) => failures.push({ check, message });
  // ran: 실제로 실행한 검사 번호. 조기 반환하면 뒤 검사는 빠지고 formatReport 가 '미실행'으로 적는다.
  const summary = { stage, baseline: expected, ran: [0] };
  const rules = Object.hasOwn(STAGES, stage) ? STAGES[stage] : null;
  if (!rules) {
    fail(0, `알 수 없는 단계 '${stage}' — 지원: ${Object.keys(STAGES).join(", ")}`);
    return { ok: false, failures, summary };
  }
  summary.ran.push(1);
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(toAbs(root, LEDGER_PATH), "utf8"));
  } catch (error) {
    fail(1, `${LEDGER_PATH} 를 읽지 못했다: ${error.message}`);
    return { ok: false, failures, summary };
  }
  const rows = checkLedger(ledger, expected, fail);
  const baseline = checkBaseline(root, rows, expected, fail);
  const working = checkWorkingTree(root, rows, rules, fail, summary);
  checkStage(rows, baseline, working, rules, fail, summary);
  checkNewFiles(
    root,
    baseline ? new Set(baseline.tree.keys()) : new Set(rows.keys()),
    rules,
    fail,
    summary,
  );
  checkLifecycle(root, rows, working, rules, fail, summary);
  summary.ran.push(2, 3, 4, 5, 6);

  summary.statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  summary.unported = {};
  for (const row of rows.values()) {
    summary.statusCounts[row.status] += 1;
    if (row.status !== "preserved-unported") continue;
    const owner = (summary.unported[row.owner] ??= {});
    owner[row.stage] = (owner[row.stage] ?? 0) + 1;
  }
  return { ok: failures.length === 0, failures, summary };
}

export function parseArgs(argv) {
  let stage = DEFAULT_STAGE;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stage" && index + 1 < argv.length) stage = argv[++index];
    else if (arg.startsWith("--stage=")) stage = arg.slice("--stage=".length);
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return { stage };
}

const CHECK_NAMES = {
  0: "단계",
  1: "ledger 정합",
  2: "기준선 git 재계산",
  3: "상태×존재",
  4: "단계 보존 규칙",
  5: "신규 파일 allowlist",
  6: "lifecycle 입력·lock 대조",
};

export function formatReport(result) {
  const { summary, failures } = result;
  const lines = [
    `rebuild-bootstrap · stage ${summary.stage} · baseline ${summary.baseline.sha} · ` +
      `${summary.baseline.rows}행 · digest ${summary.baseline.digest}`,
  ];
  if (summary.statusCounts) {
    lines.push(
      `상태별: ${Object.entries(summary.statusCounts)
        .map(([status, count]) => `${status} ${count}`)
        .join(" · ")}`,
    );
    const byName = ([a], [b]) => a.localeCompare(b);
    const unported = Object.entries(summary.unported)
      .sort(byName)
      .map(([owner, stages]) => {
        const parts = Object.entries(stages)
          .sort(byName)
          .map(([stage, count]) => `${stage} ${count}`);
        return `${owner}(${parts.join(", ")})`;
      })
      .join(" · ");
    lines.push(`preserved-unported 담당·단계: ${unported || "없음"}`);
  }
  if (summary.newFiles) lines.push(`허용 신규 파일: ${summary.newFiles.join(", ") || "없음"}`);
  // 승인된 단계 예외라도 실제로 바뀐 경로는 따로 적는다 — 기준선 바이트가 전부 같다고 읽히지 않게.
  if (summary.approvedChanged) {
    lines.push(`승인된 단계 예외(바이트 상이): ${summary.approvedChanged.join(", ") || "없음"}`);
  }
  // 상태 전환은 검사 형식만 본다 — 이 줄이 전환 증거의 진실성을 뜻하지 않는다.
  if (summary.contractReplaced) {
    lines.push(`같은 경로 계약 교체 전환: ${summary.contractReplaced.join(", ") || "없음"}`);
  }
  if (summary.frozenRows !== undefined)
    lines.push(`apps·packages·docs 기준선 경로: ${summary.frozenRows}`);
  if (summary.lockDeclarations !== undefined) {
    lines.push(`manifest↔lock 일치 의존 선언: ${summary.lockDeclarations}`);
  }
  for (const [check, name] of Object.entries(CHECK_NAMES)) {
    const mine = failures.filter((failure) => failure.check === Number(check));
    if (Number(check) === 0 && mine.length === 0) continue;
    // 실패가 없다는 이유로 실행하지 않은 검사를 통과로 적지 않는다.
    if (!summary.ran.includes(Number(check))) {
      lines.push(`검사 ${check} ${name}: 미실행`);
      continue;
    }
    lines.push(`검사 ${check} ${name}: ${mine.length === 0 ? "통과" : `실패 ${mine.length}건`}`);
    for (const failure of mine.slice(0, 20)) lines.push(`  - ${failure.message}`);
    if (mine.length > 20) lines.push(`  … 외 ${mine.length - 20}건`);
  }
  lines.push(result.ok ? "결과: 통과" : `결과: 실패 ${failures.length}건`);
  return lines.join("\n");
}

function main(argv) {
  let stage;
  try {
    ({ stage } = parseArgs(argv));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const root = process.cwd();
  let top;
  try {
    top = path.resolve(git(root, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
  } catch (error) {
    console.error(`git 저장소에서 실행해야 한다: ${error.message}`);
    return 1;
  }
  const same = (a, b) =>
    process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(top, path.resolve(root))) {
    console.error(`저장소 루트에서 실행해야 한다(현재 ${root}, 루트 ${top})`);
    return 1;
  }
  const result = runChecks({ root, stage });
  console.log(formatReport(result));
  return result.ok ? 0 : 1;
}

const invokedAsCli = () => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
};

if (invokedAsCli()) process.exitCode = main(process.argv.slice(2));
