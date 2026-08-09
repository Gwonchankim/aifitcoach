/**
 * 사용법: <Button variant="primary" size="lg" fullWidth>운동 종료</Button>
 * 하단 고정 주요 액션은 size="lg"(72px) + fullWidth, 보조 액션은 size="sm"(44px).
 * 눌러도 소용없지만 포커스는 남겨야 하는 상태(휴식 10분 상한 등)는 `disabled` 대신
 * `aria-disabled`를 넘겨라 — 클릭은 그대로 오고 색만 비활성 톤이 된다.
 */
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonBase = cn(
  "inline-flex select-none touch-manipulation items-center justify-center gap-2",
  "rounded-control font-semibold transition-colors",
  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
  "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  "disabled:pointer-events-none disabled:border-transparent disabled:bg-disabled",
  "disabled:text-disabled-fg disabled:shadow-none",
);

/**
 * aria-disabled 전용 톤. 네이티브 disabled 와 **같은 색**을 쓰되 pointer-events 는 살려 둔다
 * (상한 도달 시 눌러도 사유 안내가 떠야 한다 — UX_STATES §4.5).
 * 대비: 다크 disabled-fg/disabled = 4.40:1, 라이트 3.78:1 → §7.6 "비활성도 3:1 유지" 충족.
 */
const inactiveClass = "border border-transparent bg-disabled text-disabled-fg shadow-none";

const variantClass: Record<ButtonVariant, string> = {
  primary: "bg-action text-action-fg hover:bg-action/90 active:bg-action/80",
  secondary: "border border-border-strong bg-surface text-fg hover:bg-raised active:bg-raised",
  danger: "bg-danger text-danger-fg hover:bg-danger/90 active:bg-danger/80",
  ghost: "bg-transparent text-fg hover:bg-surface active:bg-raised",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "min-h-tap px-4 text-sm",
  md: "min-h-tap-lg px-5 text-base",
  lg: "min-h-tap-xl px-6 text-lg",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  type = "button",
  className,
  "aria-disabled": ariaDisabled,
  ...props
}: ButtonProps) {
  // hover/active 클래스를 통째로 빼기 위해 변형 클래스 자체를 갈아 끼운다
  // (CSS 우선순위 다툼 없이 확실하게 흐려진다).
  const inactive = ariaDisabled === true || ariaDisabled === "true";

  return (
    <button
      type={type}
      aria-disabled={ariaDisabled}
      className={cn(
        buttonBase,
        inactive ? inactiveClass : variantClass[variant],
        sizeClass[size],
        fullWidth && "w-full",
        className,
      )}
      {...props}
    />
  );
}
