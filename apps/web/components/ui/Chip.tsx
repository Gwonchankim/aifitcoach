/**
 * 사용법: <Chip selected={sel} onClick={toggle}>가슴</Chip>  (다중 선택 필터·부위 선택)
 * 하나만 고르는 탭 전환에는 Chip 대신 Tabs를 써라.
 */
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

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
        "rounded-control border px-4 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:border-transparent disabled:bg-disabled",
        "disabled:text-disabled-fg",
        selected
          ? "border-primary bg-primary text-primary-fg"
          : // 컨트롤 경계는 `border-control` 1px 이다(DESIGN_TOKENS §5). 먹색 1.5px 은 강조 카드·보조 버튼 전용이라
            // 칩 한 줄에 6개가 놓이면 화면이 먹선으로 덮인다.
            "border-border-control bg-surface text-fg hover:bg-raised",
        className,
      )}
      {...props}
    />
  );
}
