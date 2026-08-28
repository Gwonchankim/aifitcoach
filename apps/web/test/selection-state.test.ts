import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NATIVE_CHECKED_SELECTION_CLASS,
  selectionStateClass,
} from "../components/ui/selection-state";
import { Chip } from "../components/ui/Chip";
import { Tab } from "../components/ui/Tabs";

describe("선택 상태 3신호 계약", () => {
  it("선택은 연한 채움·진한 테두리·굵은 글자를 함께 쓴다", () => {
    const selected = selectionStateClass(true);
    expect(selected).toContain("bg-primary-bg");
    expect(selected).toContain("border-action");
    expect(selected).toContain("font-semibold");
    expect(selected).not.toContain("bg-action");
  });

  it("미선택은 흰 면·얇은 회색 테두리·보통 글자다", () => {
    const unselected = selectionStateClass(false);
    expect(unselected).toContain("bg-surface");
    expect(unselected).toContain("border-border-control");
    expect(unselected).toContain("font-medium");
    expect(unselected).not.toContain("bg-primary-bg");
  });

  it("native radio도 같은 세 신호를 checked variant로 쓴다", () => {
    expect(NATIVE_CHECKED_SELECTION_CLASS).toContain("has-[:checked]:bg-primary-bg");
    expect(NATIVE_CHECKED_SELECTION_CLASS).toContain("has-[:checked]:border-action");
    expect(NATIVE_CHECKED_SELECTION_CLASS).toContain("has-[:checked]:font-semibold");
  });

  it("Chip은 aria-pressed와 공용 선택 표현을 함께 낸다", () => {
    const selected = renderToStaticMarkup(createElement(Chip, { selected: true }, "덤벨"));
    const unselected = renderToStaticMarkup(createElement(Chip, { selected: false }, "바벨"));
    expect(selected).toContain('aria-pressed="true"');
    expect(selected).toContain("bg-primary-bg");
    expect(unselected).toContain('aria-pressed="false"');
    expect(unselected).not.toContain("bg-primary-bg");
  });

  it("Tab은 aria-selected와 공용 선택 표현을 함께 낸다", () => {
    const markup = renderToStaticMarkup(
      createElement(Tab, { selected: true, id: "tab", panelId: "panel" }, "가슴"),
    );
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("bg-primary-bg");
  });
});
