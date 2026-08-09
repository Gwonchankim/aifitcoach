/**
 * 디자인 토큰의 **실사용 전경/배경 조합**을 WCAG 2.1 AA 텍스트 기준(4.5:1)으로 계산 판정한다.
 *
 * 왜 필요한가: 완료 행 `opacity-70` 이 4.01:1 이었던 사건은 **사후에야** 발견됐다 — axe 는 그 상태를
 * 스캔하지 않았다(ADR-41). 게다가 `success #198146` on `success-bg #EFF8F2` 는 **4.54:1** 로 기준 대비
 * 여유가 0.04 뿐이다(ADR-51). 사람이 "괜찮아 보인다"고 판단할 여지를 없애고, 토큰 값에서 전 조합을
 * 계산해 CI 가 막는다.
 *
 * 값은 **`app/globals.css` 에서 파싱**한다. 여기에 hex 를 복사해 두면 토큰이 바뀌어도 검사는 옛 값을
 * 계속 통과시킨다 — 그게 이 스크립트가 막으려는 실패 그 자체다.
 *
 * 실행: `pnpm --filter web verify:contrast` (빌드 불필요)
 */
/* global process, console */
import fs from "node:fs";
import path from "node:path";

/** WCAG 2.1 §1.4.3 본문 텍스트. 큰 글자(3:1) 예외는 쓰지 않는다 — 토큰은 크기를 모른다. */
const TEXT_AA = 4.5;

/* ==========================================================================
   1. 대비 계산기
   ========================================================================== */

/** `#RGB` / `#RRGGBB` → [r,g,b] 0–255. 그 외(rgb(), var() 미해결)는 null. */
function parseHex(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/**
 * WCAG 상대 휘도. sRGB 채널을 **세 개 다** 선형화해야 한다 —
 * 처음 짠 계산기는 파랑 채널의 선형화를 빠뜨려 52:1 같은 값을 냈다. §2 의 자가검증이 그걸 잡는다.
 */
function luminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * **반올림하지 않는다.** 판정은 원값으로 한다 — 소수 2자리로 반올림하면 4.495~4.4999 가 4.50 으로 보여
 * 통과한다(실측: `success-bg #EEF7F1` → 4.4993 이 통과했다). 기준선 바로 아래를 놓치면 가드가 아니다.
 * 출력만 `toFixed(2)` 로 줄인다.
 */
function contrast(fgHex, bgHex) {
  const [l1, l2] = [luminance(fgHex), luminance(bgHex)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* ==========================================================================
   2. 계산기 자가검증 — 조합을 재기 전에 자를 먼저 잰다
   ========================================================================== */

const SELF_TESTS = [
  { fg: "#000000", bg: "#ffffff", expect: 21.0, note: "흑백 최대 대비" },
  { fg: "#767676", bg: "#ffffff", expect: 4.54, note: "AA 경계 회색(WebAIM 기준값)" },
  { fg: "#ffffff", bg: "#000000", expect: 21.0, note: "역순도 같아야 한다" },
];

for (const { fg, bg, expect, note } of SELF_TESTS) {
  // 판정은 원값으로 하므로(위 contrast 주석) 자가검증은 소수 2자리로 맞춰 비교한다.
  const got = Math.round(contrast(parseHex(fg), parseHex(bg)) * 100) / 100;
  if (got !== expect) {
    console.error(
      `계산기 자가검증 실패: ${fg} on ${bg} = ${got.toFixed(2)} (기대 ${expect.toFixed(2)}) — ${note}\n` +
        "대비 계산이 틀렸다. 조합 판정 결과는 믿을 수 없다.",
    );
    process.exit(1);
  }
}

/* ==========================================================================
   3. 토큰 파싱 — app/globals.css 의 `:root` 블록
   ========================================================================== */

const cssPath = path.resolve(import.meta.dirname, "..", "app", "globals.css");
const rawCss = fs.readFileSync(cssPath, "utf8");

/**
 * **주석을 먼저 지운다.** 폐기된 다크 팔레트(ADR-30)가 `/* ... *\/` 안에 `--afc-*` 를 전부
 * 다시 정의한 채로 남아 있어서, 그냥 훑으면 라이트 값이 다크 값으로 덮인다.
 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** @type {Map<string, string>} */
const rawTokens = new Map();
for (const [, name, value] of css.matchAll(/(--afc-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
  rawTokens.set(name, value.trim());
}

if (rawTokens.size === 0) {
  console.error(`${cssPath} 에서 --afc-* 토큰을 하나도 못 찾았다. 파서가 깨졌다.`);
  process.exit(1);
}

/** `var(--afc-x)` 참조를 따라간다(`--afc-done: var(--afc-success-bg)`). 순환은 깊이로 막는다. */
function resolve(name, depth = 0) {
  const value = rawTokens.get(name);
  if (value === undefined) return null;
  const ref = /^var\(\s*(--afc-[a-z0-9-]+)\s*\)$/i.exec(value);
  if (ref) return depth > 8 ? null : resolve(ref[1], depth + 1);
  return parseHex(value);
}

/* ==========================================================================
   4. 실사용 조합표

   출처: `docs/DESIGN_TOKENS.md` §2.1 / §2.2 / §3.1 / §3.1.1 + 실제 컴포넌트 사용.
   §3.1.1 은 "실제로 함께 쓰이는 21개 조합"을 재계산했다고만 적고 **표를 싣지 않았다**(미달 1건만 실었다).
   그래서 각 행에 **근거**(문서 절 또는 컴포넌트 파일)를 붙여 다시 세웠다 — 아래가 그 표다.
   판정하지 않는 것:
     - 안 쓰는 조합(예: 흰 글자 on `bg`) — 미달이어도 문제가 아니다.
     - 비텍스트 3:1(WCAG 1.4.11) — `border-control` 이 D-7 미결이다(§3.2).
     - `today-row` / `range-band` — `@theme` 이 참조하지만 `:root` 에 **값이 없다**(별도 보고).
   ========================================================================== */

const COMBOS = [
  // --- surface #FFFFFF (카드·시트 바닥) ---
  { fg: "fg", bg: "surface", use: "본문 최강조", src: "§2.1 ink" },
  { fg: "ink-2", bg: "surface", use: "본문 보조(설명 문단)", src: "§2.1 ink-2" },
  { fg: "fg-muted", bg: "surface", use: "캡션·라벨·키커", src: "§2.1 muted" },
  { fg: "primary", bg: "surface", use: "링크·추천값", src: "§2.2 primary" },
  { fg: "success", bg: "surface", use: "증량 델타 ▲·PR", src: "§3.1 보정" },
  { fg: "warn-ink", bg: "surface", use: "볼륨 권장 범위 밖 숫자", src: "§3.1 warn 역할 분리" },
  { fg: "danger", bg: "surface", use: "RIR 0 · 통증 7+", src: "§2.2 danger" },

  // --- bg #F5F7FA (화면 배경, 대기 세트 행) ---
  { fg: "fg", bg: "bg", use: "대기 세트 행 본문", src: "components/session/SetRow.tsx" },
  { fg: "ink-2", bg: "bg", use: "본문 보조", src: "§2.1 ink-2" },
  { fg: "fg-muted", bg: "bg", use: "캡션·라벨", src: "§2.1 muted (5.28 명시)" },
  { fg: "primary", bg: "bg", use: "추천값·계획과 다른 실제값", src: "§2.2 primary" },
  { fg: "success", bg: "bg", use: "증량 델타 ▲", src: "§2.2 success" },
  { fg: "warn-ink", bg: "bg", use: "범위 밖 표시", src: "§3.1 warn 역할 분리" },
  { fg: "danger", bg: "bg", use: "RIR 0", src: "§2.2 danger" },

  // --- raised #E9ECF1 (중립 배지, 아이콘 버튼 hover/active) ---
  { fg: "fg", bg: "raised", use: "중립 배지", src: "components/ui/Badge.tsx (neutral)" },
  {
    fg: "danger",
    bg: "raised",
    use: "위험 아이콘 버튼 hover",
    src: "components/ui/IconButton.tsx",
  },

  // --- disabled #F5F7FA (비활성 입력·버튼) ---
  { fg: "disabled-fg", bg: "disabled", use: "비활성 컨트롤", src: "components/ui/Button.tsx" },

  // --- done = success-bg (완료 세트 행) ---
  { fg: "fg", bg: "done", use: "완료 행 기록값 본문", src: "ADR-41 / globals.css" },
  { fg: "done-fg", bg: "done", use: "완료 행 보조 글자", src: "ADR-41 (5.23 명시)" },

  // --- 상태 면 위의 글자 ---
  { fg: "primary-fg", bg: "primary", use: "기본 버튼", src: "components/ui/Button.tsx" },
  {
    fg: "success-fg",
    bg: "success",
    use: "완료 체크·성공 배지",
    src: "components/ui/CompleteButton.tsx",
  },
  { fg: "warn-fg", bg: "warn", use: "통증 4~6 배지", src: "§3.1.1 (c) 채택 (6.09)" },
  { fg: "danger-fg", bg: "danger", use: "위험 배지·버튼", src: "components/ui/Badge.tsx" },

  // --- 연한 상태 배경 위의 글자 (§2.2 본색/배경 역할 쌍) ---
  { fg: "success", bg: "success-bg", use: "완료 강조", src: "§3.1.1 / ADR-51 (4.54 — 여유 0.04)" },
  { fg: "warn-ink", bg: "warn-bg", use: "소프트 통증 배지", src: "§3.1.1 (b) (5.14)" },
  { fg: "primary", bg: "primary-bg", use: "소프트 강조 배지", src: "§2.2 primary 역할 쌍" },
  // Sprint 3 이 세션 화면에서 실제로 만든 조합(안내 카드 본문이 muted 다). 5.26 / 5.10 으로 통과하지만
  // 표에 없으면 나중에 배경을 조정할 때 조용히 깨진다 — 화면에 존재하는 조합은 전부 표에 있어야 한다.
  {
    fg: "fg-muted",
    bg: "warn-bg",
    use: "통증·종료 안내 카드 본문",
    src: "session/PainSheet·FinishSheet",
  },
  {
    fg: "fg-muted",
    bg: "primary-bg",
    use: "편집 모드 안내 카드 본문",
    src: "session/SessionScreen",
  },
  { fg: "danger", bg: "danger-bg", use: "소프트 위험 배지", src: "§2.2 danger 역할 쌍" },
];

/* ==========================================================================
   5. 판정
   ========================================================================== */

/** @type {string[]} */
const missing = [];
/** @type {{combo: (typeof COMBOS)[number], ratio: number, fgHex: string, bgHex: string}[]} */
const failures = [];

for (const combo of COMBOS) {
  const fgName = `--afc-${combo.fg}`;
  const bgName = `--afc-${combo.bg}`;
  const fg = resolve(fgName);
  const bg = resolve(bgName);
  if (!fg || !bg) {
    missing.push(`${!fg ? fgName : bgName} — 정의가 없거나 hex 가 아니다`);
    continue;
  }
  const ratio = contrast(fg, bg);
  if (ratio < TEXT_AA) {
    failures.push({ combo, ratio, fgHex: rawTokens.get(fgName), bgHex: rawTokens.get(bgName) });
  }
}

if (missing.length) {
  console.error(`조합표가 참조하는 토큰을 찾지 못했다 (${missing.length}건):`);
  for (const line of missing) console.error(`  ${line}`);
  process.exit(1);
}

if (failures.length) {
  console.error(
    `대비 미달 ${failures.length}건 (텍스트 기준 ${TEXT_AA.toFixed(1)}:1) — app/globals.css\n`,
  );
  for (const { combo, ratio, fgHex, bgHex } of failures) {
    // 기준선 바로 아래(4.49x)는 2자리로 찍으면 "4.50 — 0.00 모자란다" 가 돼 읽는 사람이 혼란스럽다.
    // 부족분이 0.01 미만이면 자릿수를 늘려 실제로 모자란다는 걸 보인다.
    const gap = TEXT_AA - ratio;
    const digits = gap < 0.01 ? 4 : 2;
    console.error(`  text-${combo.fg} (${fgHex})  on  bg-${combo.bg} (${bgHex})`);
    console.error(
      `      ${ratio.toFixed(digits)}:1 — ${gap.toFixed(digits)} 모자란다 (필요: ${TEXT_AA.toFixed(2)}:1 이상)`,
    );
    console.error(`      용례: ${combo.use}   근거: ${combo.src}`);
  }
  console.error(
    "\n토큰 값을 고쳐라. 조합을 표에서 빼서 통과시키지 마라 — 화면에서 그 조합이 사라진 게 아니면 거짓말이다.",
  );
  console.error("값을 바꾸면 docs/DESIGN_TOKENS.md §3 의 실측표도 같이 갱신해라.");
  process.exit(1);
}

const tightest = COMBOS.map((combo) => ({
  combo,
  ratio: contrast(resolve(`--afc-${combo.fg}`), resolve(`--afc-${combo.bg}`)),
})).sort((a, b) => a.ratio - b.ratio)[0];

console.log(
  `대비 통과 — 실사용 ${COMBOS.length}개 조합 전부 ${TEXT_AA.toFixed(1)}:1 이상 ` +
    `(토큰 ${rawTokens.size}개를 app/globals.css 에서 파싱)`,
);
console.log(
  `여유가 가장 적은 조합: text-${tightest.combo.fg} on bg-${tightest.combo.bg} = ${tightest.ratio.toFixed(2)}:1`,
);
