import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ExerciseMenuPopover,
  activateExerciseMenuAction,
  consumeOpenMenuCompletion,
  exerciseMenuClickIntent,
  handoffMenuFocus,
  isExerciseMenuCloseKey,
  nextExerciseMenuIndex,
} from "../components/session/ExerciseMenu";

const menu = (lockedReason: string | null = null) =>
  renderToStaticMarkup(
    createElement(ExerciseMenuPopover, {
      name: "벤치프레스",
      menuId: "bench-menu",
      triggerId: "bench-menu-trigger",
      lockedReason,
      lockedReasonId: "bench-menu-locked-reason",
      painScore: 5,
      activeIndex: 0,
      onItemFocus: () => {},
      onSelect: () => {},
      itemRef: () => {},
    }),
  );

const menuItemTexts = (html: string) =>
  [...html.matchAll(/<button[^>]*role="menuitem"[^>]*>[\s\S]*?<\/button>/g)].map((match) =>
    match[0].replace(/<[^>]*>/g, "").trim(),
  );

describe("ExerciseCard 앵커 메뉴", () => {
  it("role=menu 안에 교체·통증 기록·삭제만 둔다(건너뛰기·추가 없음)", () => {
    const html = menu();
    expect(html).toContain('role="menu"');
    expect(menuItemTexts(html)).toEqual(["교체", "통증 기록", "삭제"]);
    expect(html).not.toContain("건너뛰기");
    expect(html).not.toContain("운동 추가");
  });

  it("첫 항목만 tabindex=0이고 잠긴 교체·삭제도 focusable aria-disabled다", () => {
    const html = menu("기록이 있는 운동이라 빼거나 바꿀 수 없어요.");
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(2);
    expect((html.match(/aria-disabled="true"/g) ?? []).length).toBe(2);
    expect((html.match(/aria-describedby="bench-menu-locked-reason"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="벤치프레스 통증 5점 수정"');
  });

  it("ArrowUp/Down은 순환하고 Home/End는 양 끝으로 이동한다", () => {
    expect(nextExerciseMenuIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextExerciseMenuIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextExerciseMenuIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextExerciseMenuIndex(1, "Home", 3)).toBe(0);
    expect(nextExerciseMenuIndex(1, "End", 3)).toBe(2);
    expect(nextExerciseMenuIndex(1, "Enter", 3)).toBeNull();
    expect(isExerciseMenuCloseKey("Escape")).toBe(true);
    expect(isExerciseMenuCloseKey("Enter")).toBe(false);
  });

  it("메뉴 내부 클릭은 유지하고 외부 클릭은 닫으며 완료 체크는 별도로 소비한다", () => {
    expect(exerciseMenuClickIntent(true, false)).toBe("ignore");
    expect(exerciseMenuClickIntent(false, false)).toBe("close");
    expect(exerciseMenuClickIntent(false, true)).toBe("consume-completion");
  });

  it("잠긴 교체·삭제는 요청 콜백을 0회 호출하고 사유만 알리며 통증은 활성이다", () => {
    const callbacks = {
      onSwap: vi.fn(),
      onReportPain: vi.fn(),
      onRemove: vi.fn(),
      onBlocked: vi.fn(),
    };

    expect(activateExerciseMenuAction("swap", true, callbacks)).toBe(false);
    expect(activateExerciseMenuAction("delete", true, callbacks)).toBe(false);
    expect(callbacks.onSwap).not.toHaveBeenCalled();
    expect(callbacks.onRemove).not.toHaveBeenCalled();
    expect(callbacks.onBlocked).toHaveBeenCalledTimes(2);

    expect(activateExerciseMenuAction("pain", true, callbacks)).toBe(true);
    expect(callbacks.onReportPain).toHaveBeenCalledTimes(1);
  });

  it("시트 전환은 트리거 포커스 → 메뉴 닫기 → 표면 열기 순서로 동기 실행한다", () => {
    const order: string[] = [];
    handoffMenuFocus(
      { focus: () => order.push("trigger") },
      () => order.push("close"),
      () => order.push("surface"),
    );
    expect(order).toEqual(["trigger", "close", "surface"]);
  });

  it("메뉴가 열려 있으면 외부 완료 체크의 첫 활성화는 메뉴 닫기로 소비한다", () => {
    const close = vi.fn();
    expect(consumeOpenMenuCompletion(true, close)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(consumeOpenMenuCompletion(false, close)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
