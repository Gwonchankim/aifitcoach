/**
 * 사용법: <Chip selected={sel} onClick={toggle}>가슴</Chip>  (다중 선택 필터·부위 선택)
 * 하나만 고르는 탭 전환에는 Chip 대신 Tabs를 써라.
 */
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";
import { selectionStateClass } from "./selection-state";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-pressed"> & {
  selected?: boolean;
};

export function Chip({ selected = false, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex min-h-tap touch-manipulation items-center justify-center gap-1.5",
        "rounded-control border px-4 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:border-transparent disabled:bg-disabled",
        "disabled:text-disabled-fg",
        selectionStateClass(selected),
        className,
      )}
      {...props}
    />
  );
}
