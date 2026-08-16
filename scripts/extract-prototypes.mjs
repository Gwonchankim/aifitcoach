import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PROTOTYPES = [
  ["home-dashboard", "AFC 홈 대시보드 (오프라인).html", "홈 대시보드"],
  ["history", "AFC 기록 (오프라인).html", "기록"],
  ["weekly-program", "AFC 주간 프로그램 (오프라인).html", "주간 프로그램"],
  ["session", "AFC 세션 프로토타입 (오프라인).html", "세션"],
  ["onboarding", "AFC 온보딩 (오프라인).html", "온보딩"],
  ["rir-tutorial", "AFC RIR 튜토리얼 (오프라인).html", "RIR 튜토리얼"],
  ["paywall-b", "AFC 페이월 B 확정 (오프라인).html", "페이월 B 확정"],
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeEntities(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ");
}

function normalizeCopy(value) {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function readStringLiterals(source) {
  const values = [];
  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;

    let value = "";
    let escaped = false;
    let closed = false;
    for (index += 1; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        value += character === "n" ? "\n" : character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        closed = true;
        break;
      } else {
        value += character;
      }
    }
    if (closed && /[가-힣]/.test(value)) values.push(normalizeCopy(value));
  }
  return values;
}

function extractCopy(template, runtime) {
  const entries = [];
  const seen = new Set();
  const add = (origin, value) => {
    const text = normalizeCopy(value);
    if (!text || !/[가-힣]/.test(text) || seen.has(text)) return;
    seen.add(text);
    entries.push({ origin, text });
  };

  const withoutScripts = template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  for (const match of withoutScripts.matchAll(/>([^<>{}]*[가-힣][^<>{}]*)</g)) {
    add("template", match[1]);
  }
  for (const value of readStringLiterals(runtime)) add("state-data", value);
  return entries;
}

function extractTemplate(bundle, sourceName) {
  const match = bundle.match(
    /<script\s+type=["']__bundler\/template["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) throw new Error(`${sourceName}: __bundler/template payload not found`);

  const template = JSON.parse(match[1]);
  const scripts = [...template.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const runtime = scripts.find((item) => /type=["']text\/x-dc["']/i.test(item[1]))?.[2];
  if (!runtime) throw new Error(`${sourceName}: text/x-dc runtime not found`);

  const body = template.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!body) throw new Error(`${sourceName}: body not found in embedded template`);

  const bodyWithoutRuntime = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<helmet\b[^>]*>\s*<style>\s*[\s\S]*?@font-face[\s\S]*?<\/style>\s*<\/helmet>/gi, "")
    .trim();
  const appStyles = [...template.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((item) => item[1].trim())
    .filter((css) => !css.includes("@font-face"));

  const extracted = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <meta name="afc-prototype-source" content="${sourceName}">`,
    ...appStyles.map((css) => `<style>\n${css}\n</style>`),
    "</head>",
    "<body>",
    bodyWithoutRuntime,
    "</body>",
    "</html>",
    "",
  ].join("\n");

  if (/<script\b/i.test(extracted) || /__bundler\//.test(extracted)) {
    throw new Error(`${sourceName}: runtime marker remained after extraction`);
  }
  return { template, runtime, extracted };
}

const sourceDir = path.resolve(
  arg("--source-dir", path.join(process.env.USERPROFILE ?? "", "Downloads")),
);
const outDir = path.resolve(arg("--out-dir", path.join("docs", "prototypes")));
const check = process.argv.includes("--check");
const manifest = { format: 1, extractor: "scripts/extract-prototypes.mjs", prototypes: [] };

await mkdir(outDir, { recursive: true });

for (const [slug, sourceName, title] of PROTOTYPES) {
  const sourcePath = path.join(sourceDir, sourceName);
  const bundle = await readFile(sourcePath, "utf8");
  const { template, runtime, extracted } = extractTemplate(bundle, sourceName);
  const copy = extractCopy(template, runtime);
  const copyDocument = `${JSON.stringify(
    {
      format: 1,
      source: sourceName,
      note: "정적 템플릿 텍스트와 상태 데이터의 한글 문자열을 원본 등장 순서로 중복 제거했다.",
      entries: copy,
    },
    null,
    2,
  )}\n`;
  const outputs = [
    [`${slug}.template.html`, extracted],
    [`${slug}.copy.json`, copyDocument],
  ];

  for (const [fileName, contents] of outputs) {
    const outputPath = path.join(outDir, fileName);
    if (check) {
      const current = await readFile(outputPath, "utf8");
      if (current !== contents) throw new Error(`${fileName}: generated output is stale`);
    } else {
      await writeFile(outputPath, contents, "utf8");
    }
  }

  manifest.prototypes.push({
    slug,
    title,
    source: sourceName,
    source_bytes: Buffer.byteLength(bundle),
    source_sha256: sha256(bundle),
    embedded_template_sha256: sha256(template),
    template_bytes: Buffer.byteLength(extracted),
    copy_entries: copy.length,
  });
}

const manifestDocument = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestPath = path.join(outDir, "manifest.json");
if (check) {
  const current = await readFile(manifestPath, "utf8");
  if (current !== manifestDocument) throw new Error("manifest.json: generated output is stale");
} else {
  await writeFile(manifestPath, manifestDocument, "utf8");
}

process.stdout.write(
  `${check ? "verified" : "extracted"} ${PROTOTYPES.length} prototypes in ${outDir}\n`,
);
