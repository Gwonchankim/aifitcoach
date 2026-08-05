/**
 * 사용법: <Checkbox label="무릎" value="knee" checked={checked} onChange={onChange} />
 * 통증 부위(8종 고정)·옵션 다중 선택용. 라벨 전체가 탭 영역(56px)이다.
 */
import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  /** 라벨 아래 보조 설명(선택). */
  description?: string;
  className?: string;
};

export function Checkbox({ label, description, className, ...props }: CheckboxProps) {
  return (
    <label
      className={cn(
        "flex min-h-tap-lg w-full cursor-pointer touch-manipulation items-center gap-3",
        "rounded-control border border-border bg-surface px-4 py-2",
        "has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed has-[:disabled]:bg-disabled",
        className,
      )}
    >
      <input type="checkbox" className="peer sr-only" {...props} />

      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md border-2",
          "border-border-strong text-transparent",
          "peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-fg",
          "peer-focus-visible:ring-3 peer-focus-visible:ring-focus",
          "peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg",
          "peer-disabled:border-disabled-fg",
        )}
      >
        <svg viewBox="0 0 20 20" fill="none" className="size-4">
          <path
            d="M4 10.5 8 14.5 16 6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <span className="flex flex-col text-left text-fg peer-disabled:text-disabled-fg">
        <span className="text-base font-medium">{label}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}
