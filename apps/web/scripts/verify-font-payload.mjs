/* global process, console */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontsRoot = path.join(appRoot, "app", "fonts");
const cssPath = path.join(fontsRoot, "pretendard-variable.css");
const assetsRoot = path.join(fontsRoot, "woff2-dynamic-subset");

const EXPECTED_FACE_COUNT = 92;
const EXPECTED_SOURCE_BYTES = 2_957_724;
const MAX_CSS_BYTES = 60_000;
const LEGACY_FILES = [
  "Pretendard-Regular.subset.woff2",
  "Pretendard-Medium.subset.woff2",
  "Pretendard-SemiBold.subset.woff2",
  "Pretendard-Bold.subset.woff2",
];

const errors = [];
const fail = (message) => errors.push(message);

if (!fs.existsSync(cssPath)) {
  fail("pretendard-variable.css가 없다.");
} else {
  const css = fs.readFileSync(cssPath, "utf8");
  const cssBytes = Buffer.byteLength(css);
  const faces = [...css.matchAll(/@font-face\s*\{[^}]+\}/g)].map((match) => match[0]);
  const variableFaces = faces.filter((face) =>
    /font-family:\s*['"]Pretendard Variable['"]/.test(face),
  );
  const urls = variableFaces
    // 두 종류의 CSS 따옴표를 모두 허용하는 공급자 파일 파서다.
    // eslint-disable-next-line no-useless-escape
    .map((face) => face.match(/url\((?:['\"])?([^)'\"]+\.woff2)/)?.[1])
    .filter(Boolean);

  if (cssBytes > MAX_CSS_BYTES) fail(`CSS ${cssBytes}B > 예산 ${MAX_CSS_BYTES}B`);
  if (variableFaces.length !== EXPECTED_FACE_COUNT) {
    fail(`가변 @font-face ${variableFaces.length}개 != ${EXPECTED_FACE_COUNT}개`);
  }
  if (new Set(urls).size !== EXPECTED_FACE_COUNT) {
    fail(`고유 WOFF2 URL ${new Set(urls).size}개 != ${EXPECTED_FACE_COUNT}개`);
  }
  if (/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    fail("폰트 CSS에 외부 URL이 있다.");
  }
  for (const face of variableFaces) {
    if (!/font-weight:\s*45\s+920\s*;/.test(face)) fail("가변 웨이트 축 45 920이 아니다.");
    if (!/font-display:\s*swap\s*;/.test(face)) fail("font-display: swap이 빠졌다.");
    if (!/unicode-range:\s*U\+/i.test(face)) fail("unicode-range가 빠졌다.");
  }

  const fallback = faces.find((face) => /font-family:\s*['"]Pretendard Fallback['"]/.test(face));
  for (const declaration of [
    "ascent-override: 93.76%",
    "descent-override: 23.75%",
    "line-gap-override: 0%",
    "size-adjust: 101.55%",
  ]) {
    if (!fallback?.includes(declaration)) fail(`수동 fallback 보정 누락: ${declaration}`);
  }

  let sourceBytes = 0;
  for (const relativeUrl of new Set(urls)) {
    const asset = path.resolve(path.dirname(cssPath), relativeUrl);
    if (!asset.startsWith(`${assetsRoot}${path.sep}`)) {
      fail(`허용 폴더 밖 폰트 URL: ${relativeUrl}`);
    } else if (!fs.existsSync(asset)) {
      fail(`폰트 파일 누락: ${relativeUrl}`);
    } else {
      sourceBytes += fs.statSync(asset).size;
    }
  }
  if (sourceBytes !== EXPECTED_SOURCE_BYTES) {
    fail(`가변 폰트 원본 ${sourceBytes}B != 승인 자산 ${EXPECTED_SOURCE_BYTES}B`);
  }
}

for (const legacy of LEGACY_FILES) {
  if (fs.existsSync(path.join(fontsRoot, legacy))) fail(`정적 4웨이트 파일이 남았다: ${legacy}`);
}

if (errors.length) {
  console.error(`Font payload verification failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log("Font payload verified: 92 variable subsets, 2,957,724B, local-only URLs.");
