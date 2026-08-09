/**
 * **"파랑 = 상태/정보, ink = 액션"** 규칙을 고정한다 (ADR-52).
 *
 * 왜 별도 그물이 필요한가: 주 CTA 를 파랑으로 되돌려도 **대비 게이트가 잡지 못한다** —
 * ink 17.48:1 / primary 7.09:1 로 둘 다 AA 를 넘기 때문이다. axe 도 통과한다.
 * 즉 이 규칙은 자동 검사의 사각지대다. 실제로 M-UIa 가 끝날 때까지 파랑 CTA 가 남아 있었고,
 * evaluator 가 스크린샷을 눈으로 보고서야 발견했다.
 *
 * 판정 대상은 **소스의 토큰 사용**이다(렌더 결과가 아니라). 규칙은 "어떤 토큰을 쓰는가"이고,
 * 그걸 어긴 순간을 잡는 게 목적이다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

/** 누를 수 있는 면 = ink 반전. 파랑 면을 쓰면 안 된다. */
const ACTION_SURFACES: { file: string; what: string }[] = [
  { file: "components/ui/Button.tsx", what: "주 버튼(primary variant)" },
  { file: "components/ui/Chip.tsx", what: "선택된 분절 칩" },
  { file: "components/ui/Tabs.tsx", what: "선택된 탭" },
  { file: "components/dashboard/DashboardScreen.tsx", what: "대시보드 주 CTA(LinkAction)" },
  { file: "app/program/ProgramScreen.tsx", what: "프로그램 화면 주 CTA" },
  { file: "components/session/SessionSummary.tsx", what: "요약 화면 주 CTA" },
];

describe("액션 면은 ink 다 (ADR-52)", () => {
  it.each(ACTION_SURFACES)("$what 은 bg-action 을 쓴다", ({ file }) => {
    expect(read(file)).toContain("bg-action");
  });

  it.each(ACTION_SURFACES)("$what 은 bg-primary 를 액션 면으로 쓰지 않는다", ({ file }) => {
    const source = read(file);
    // `bg-primary-bg`(연파랑 면)는 상태 표시라 허용된다 — 솔리드 `bg-primary` 만 막는다.
    const solidPrimarySurface = /\bbg-primary(?![a-z-])/.exec(source);
    expect(
      solidPrimarySurface,
      `${file}: 액션 면에 솔리드 bg-primary 를 쓰면 "파랑 = 상태" 규칙이 깨진다. bg-action 을 써라`,
    ).toBeNull();
  });

  /**
   * 파랑이 남아도 되는 자리 — 여기까지 ink 로 바꾸면 "지금·추천"을 나타낼 색이 사라진다.
   * 이 목록이 줄어들면(= 파랑이 더 사라지면) 그것도 규칙 위반이라 함께 고정한다.
   */
  it("상태·정보 표시는 파랑을 유지한다", () => {
    expect(read("components/ui/Checkbox.tsx"), "체크 표시").toContain("bg-primary");
    expect(read("components/ui/ScaleGroup.tsx"), "눈금 선택 채움").toContain("bg-primary");
    expect(read("components/ui/ProgressBar.tsx"), "진행 바 채움").toContain("bg-primary");
    expect(read("components/ui/Badge.tsx"), "상태 배지는 소프트 파랑").toContain("bg-primary-bg");
  });

  it("액션 토큰이 ink 값으로 정의돼 있다", () => {
    const css = read("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/--afc-action:\s*#151a21;/i);
    expect(css).toMatch(/--afc-action-fg:\s*#ffffff;/i);
  });
});
