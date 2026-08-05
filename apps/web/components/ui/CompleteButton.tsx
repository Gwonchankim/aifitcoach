/**
 * 사용법: <CompleteButton completed={set.done} onClick={toggle} />  (세트 완료 체크, F1)
 * 되돌리기 가능한 토글이라 aria-pressed를 쓴다. 색 외에 아이콘+글자로도 상태를 구분한다.
 */
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type CompleteButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "aria-pressed"
> & {
  completed: boolean;
  /** 어떤 세트인지 스크린리더에 알린다(예: "3세트"). */
  setLabel?: string;
  /**
   * `lg`(72px) = 미완료 세트의 기본 크기. `md`(48px) = 완료 세트의 축약 행(높이 <= 64px)용.
   * 축약 행에 72px 버튼은 들어가지 않는다. 44px 하한은 md 도 지킨다.
   */
  size?: "lg" | "md";
};

const sizeClass: Record<"lg" | "md", string> = {
  lg: "size-tap-xl gap-1",
  md: "size-12 gap-0 [&_svg]:size-6",
};

export function CompleteButton({
  completed,
  setLabel,
  size = "lg",
  className,
  ...props
}: CompleteButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={completed}
      aria-label={setLabel ? `${setLabel} 완료` : undefined}
      className={cn(
        "flex shrink-0 touch-manipulation flex-col items-center justify-center",
        sizeClass[size],
        "rounded-control border-2 font-semibold transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:border-transparent disabled:bg-disabled",
        "disabled:text-disabled-fg",
        completed
          ? "border-success bg-success text-success-fg"
          : "border-border-strong bg-surface text-fg-muted",
        className,
      )}
      {...props}
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-7">
        {completed ? (
          <path
            d="M5 12.5 10 17.5 19 7"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
        )}
      </svg>
      <span className="text-xs">{completed ? "완료" : "체크"}</span>
    </button>
  );
}
