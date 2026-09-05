/**
 * 시트(모달)에 접근성 동작을 붙인다(UX_STATES §7.2).
 * design 의 `Sheet` 는 마크업·스타일만 담당하므로 트랩·Esc·스크롤 잠금·포커스 복귀는 여기서 한다.
 */
"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * @param open 시트가 열려 있는지
 * @param sheetId `Sheet` 에 넘긴 id(= dialog 엘리먼트 id)
 * @param onClose Esc·배경 탭으로 닫을 때 실행
 * @param initialFocusId 초기 포커스를 받을 요소의 id(없으면 첫 포커스 가능 요소)
 * @param returnFocusTarget 명시적 열기 요소(없으면 기존 activeElement 복원)
 */
export function useModal(
  open: boolean,
  sheetId: string,
  onClose: () => void,
  initialFocusId?: string,
  returnFocusTarget?: HTMLElement | null,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialog = () => document.getElementById(sheetId);
    const focusables = () =>
      Array.from(dialog()?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (element) => element.offsetParent !== null,
      );

    // 시트가 그려진 뒤에 포커스를 옮긴다.
    const focusTimer = window.setTimeout(() => {
      const target = initialFocusId ? document.getElementById(initialFocusId) : null;
      (target ?? focusables()[0])?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusables();
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active != null && dialog()?.contains(active) === true;

      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (returnFocusTarget) {
        if (
          returnFocusTarget.isConnected &&
          !returnFocusTarget.matches(':disabled, [aria-disabled="true"]')
        )
          returnFocusTarget.focus();
      } else {
        previouslyFocused?.focus?.();
      }
    };
  }, [open, sheetId, initialFocusId, returnFocusTarget]);
}
