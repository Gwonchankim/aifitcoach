/** 운동 카드에 앵커된 비모달 3항목 메뉴(D-14·D-17). */
"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { cn } from "../ui";

export type ExerciseMenuAction = "swap" | "pain" | "delete";

export type ExerciseMenuCallbacks = {
  onSwap: () => void;
  onReportPain: () => void;
  onRemove: () => void;
  onBlocked: () => void;
};

const ACTIONS: readonly ExerciseMenuAction[] = ["swap", "pain", "delete"];

export function nextExerciseMenuIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function isExerciseMenuCloseKey(key: string): boolean {
  return key === "Escape";
}

export type ExerciseMenuClickIntent = "ignore" | "close" | "consume-completion";

export function exerciseMenuClickIntent(
  insideMenu: boolean,
  completedCheck: boolean,
): ExerciseMenuClickIntent {
  if (completedCheck) return "consume-completion";
  return insideMenu ? "ignore" : "close";
}

/** 잠긴 교체·삭제는 도메인 콜백 대신 안내만 실행한다. */
export function activateExerciseMenuAction(
  action: ExerciseMenuAction,
  locked: boolean,
  callbacks: ExerciseMenuCallbacks,
): boolean {
  if (locked && action !== "pain") {
    callbacks.onBlocked();
    return false;
  }
  if (action === "swap") callbacks.onSwap();
  else if (action === "pain") callbacks.onReportPain();
  else callbacks.onRemove();
  return true;
}

/** 새 시트가 캡처할 유효한 복귀점을 먼저 만든다. 지연된 메뉴 포커스 복귀는 두지 않는다. */
export function handoffMenuFocus(
  trigger: Pick<HTMLElement, "focus"> | null,
  close: () => void,
  openSurface: () => void,
) {
  trigger?.focus();
  close();
  openSurface();
}

/** 메뉴가 열렸다면 완료 체크의 첫 활성화는 완료 처리 대신 닫기로 소비한다. */
export function consumeOpenMenuCompletion(open: boolean, close: () => void): boolean {
  if (!open) return false;
  close();
  return true;
}

export type ExerciseMenuPopoverProps = {
  name: string;
  menuId: string;
  triggerId: string;
  lockedReason: string | null;
  lockedReasonId: string;
  painScore: number | null;
  activeIndex: number;
  onItemFocus: (index: number) => void;
  onSelect: (action: ExerciseMenuAction) => void;
  itemRef: (index: number, element: HTMLButtonElement | null) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

/** 정적 마크업 계약도 단위 테스트할 수 있게 메뉴 표면을 분리한다. */
export function ExerciseMenuPopover({
  name,
  menuId,
  triggerId,
  lockedReason,
  lockedReasonId,
  painScore,
  activeIndex,
  onItemFocus,
  onSelect,
  itemRef,
  onKeyDown,
}: ExerciseMenuPopoverProps) {
  const locked = lockedReason != null;
  const labels: Record<ExerciseMenuAction, string> = {
    swap: "교체",
    pain: "통증 기록",
    delete: "삭제",
  };

  return (
    <div
      id={menuId}
      role="menu"
      aria-labelledby={triggerId}
      className="absolute right-0 top-full z-30 mt-1 w-44 rounded-control border border-border bg-surface p-1"
      onKeyDown={onKeyDown}
    >
      {ACTIONS.map((action, index) => {
        const disabled = locked && action !== "pain";
        const ariaLabel =
          action === "pain" && painScore != null
            ? `${name} 통증 ${painScore}점 수정`
            : `${name} ${labels[action]}`;
        return (
          <button
            key={action}
            ref={(element) => itemRef(index, element)}
            type="button"
            role="menuitem"
            tabIndex={activeIndex === index ? 0 : -1}
            aria-label={ariaLabel}
            aria-disabled={disabled || undefined}
            aria-describedby={disabled ? lockedReasonId : undefined}
            className={cn(
              "flex min-h-tap w-full items-center rounded-control px-3 text-left text-sm font-semibold",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
              disabled
                ? "bg-disabled text-disabled-fg"
                : action === "delete"
                  ? "text-danger hover:bg-raised"
                  : "text-fg hover:bg-raised",
            )}
            onFocus={() => onItemFocus(index)}
            onClick={() => onSelect(action)}
          >
            {labels[action]}
          </button>
        );
      })}
    </div>
  );
}

export type ExerciseMenuProps = {
  name: string;
  menuId: string;
  lockedReason: string | null;
  lockedReasonId: string;
  painScore: number | null;
} & ExerciseMenuCallbacks;

export function ExerciseMenu({
  name,
  menuId,
  lockedReason,
  lockedReasonId,
  painScore,
  onSwap,
  onReportPain,
  onRemove,
  onBlocked,
}: ExerciseMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const triggerId = `${menuId}-trigger`;

  const closeMenu = useCallback(() => {
    triggerRef.current?.focus();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const intent = exerciseMenuClickIntent(
        rootRef.current?.contains(target) === true,
        target.closest("[data-set-check]") != null,
      );
      // 모든 카드의 완료 체크를 대상으로 한다. 캡처 단계에서 막아 SetRow와 타이머가 실행되지 않는다.
      if (intent === "consume-completion") {
        if (consumeOpenMenuCompletion(true, closeMenu)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (intent === "close") closeMenu();
    };
    document.addEventListener("click", onDocumentClick, true);
    return () => document.removeEventListener("click", onDocumentClick, true);
  }, [closeMenu, open]);

  const callbacks: ExerciseMenuCallbacks = { onSwap, onReportPain, onRemove, onBlocked };

  const select = (action: ExerciseMenuAction) => {
    const locked = lockedReason != null;
    if (locked && action !== "pain") {
      activateExerciseMenuAction(action, locked, callbacks);
      return;
    }
    handoffMenuFocus(
      triggerRef.current,
      () => setOpen(false),
      () => {
        activateExerciseMenuAction(action, locked, callbacks);
      },
    );
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isExerciseMenuCloseKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    const next = nextExerciseMenuIndex(activeIndex, event.key, ACTIONS.length);
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        aria-label={`${name} 메뉴`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={cn(
          "inline-flex size-12 shrink-0 touch-manipulation items-center justify-center",
          "rounded-control bg-transparent text-2xl font-semibold text-fg-muted transition-colors",
          "hover:bg-raised hover:text-fg active:bg-raised",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        )}
        onClick={() => {
          if (open) closeMenu();
          else {
            setActiveIndex(0);
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {open ? (
        <ExerciseMenuPopover
          name={name}
          menuId={menuId}
          triggerId={triggerId}
          lockedReason={lockedReason}
          lockedReasonId={lockedReasonId}
          painScore={painScore}
          activeIndex={activeIndex}
          onItemFocus={setActiveIndex}
          onSelect={select}
          itemRef={(index, element) => {
            itemRefs.current[index] = element;
          }}
          onKeyDown={handleKeyDown}
        />
      ) : null}
    </div>
  );
}
