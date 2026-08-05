/**
 * 사용법: <Input id="set-3-weight" label="무게 (kg)" unit="kg" defaultValue={62.5} />
 * 단위는 label 안에도 적어라(unit prop은 시각 표시 전용, 스크린리더에서 숨김).
 */
import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  /** label/hint 연결에 쓰인다. 세트별로 고유해야 한다(예: `set-3-weight`). */
  id: string;
  label: string;
  /** 입력칸 오른쪽에 표시할 단위(kg, 회, 초 …). */
  unit?: string;
  /** 도움말 또는 에러 문구. invalid=true면 위험색으로 표시된다. */
  hint?: string;
  invalid?: boolean;
  /** 라벨을 시각적으로 숨긴다(스크린리더에는 남는다). */
  hideLabel?: boolean;
  /**
   * "compact" = 44px(탭 타겟 하한). 세트 행처럼 같은 입력이 15번 반복되는 화면에서 쓴다.
   * 화면당 1~2개뿐인 입력은 기본값(56px)을 그대로 둬라.
   */
  density?: "default" | "compact";
  className?: string;
};

export function Input({
  id,
  label,
  unit,
  hint,
  invalid = false,
  hideLabel = false,
  density = "default",
  inputMode = "decimal",
  className,
  ...props
}: InputProps) {
  const hintId = hint ? `${id}-hint` : undefined;

  const compact = density === "compact";

  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-1" : "gap-1.5", className)}>
      <label
        htmlFor={id}
        className={cn("text-sm font-medium text-fg-muted", hideLabel && "sr-only")}
      >
        {label}
      </label>

      <div className="relative flex items-center">
        <input
          id={id}
          inputMode={inputMode}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          className={cn(
            // 390px 에서 무게·횟수 칸이 나란히 놓이면 글자 폭이 100px 아래로 떨어진다
            // → 좌우 여백과 단위 자리를 줄여 placeholder 가 잘리지 않게 한다.
            "w-full rounded-control border bg-surface px-3 font-semibold",
            compact ? "min-h-tap text-lg" : "min-h-tap-lg text-xl",
            "text-fg tabular-nums placeholder:font-normal placeholder:text-fg-muted",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "disabled:bg-disabled disabled:text-disabled-fg",
            invalid ? "border-danger" : "border-border-strong",
            unit && "pr-10",
          )}
          {...props}
        />
        {unit ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 text-base font-medium text-fg-muted"
          >
            {unit}
          </span>
        ) : null}
      </div>

      {hint ? (
        <p id={hintId} className={cn("text-sm", invalid ? "text-danger" : "text-fg-muted")}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
