/**
 * 사용법: <Input id="set-3-weight" label="무게 (kg)" unit="kg" defaultValue={62.5} />
 * 단위는 label 안에도 적어라(unit prop은 시각 표시 전용, 스크린리더에서 숨김).
 *
 * 칸 안쪽 우측에 조작 요소를 두려면 `trailing` 을 넘겨라(테두리 하나로 묶여 **필드 1개**로 보인다).
 *   <Input id="set-3-rir" label="3세트 RIR, 0~6, 선택 입력" hideLabel density="compact"
 *          inputMode="numeric" maxLength={1} trailing={<button …>셰브론</button>} … />
 */
import type { InputHTMLAttributes, ReactNode } from "react";
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
  /**
   * 입력칸 **안쪽 우측**에 놓을 조작 요소(F1-1 RIR 의 "고르기" 셰브론).
   * 같은 테두리 안에 들어가 시각적으로 필드가 하나로 보인다. `unit` 과 함께 쓰지 않는다.
   */
  trailing?: ReactNode;
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
  trailing,
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
            // 무게·횟수·RIR·시간이 들어오는 칸이다 → 모노 + tabular-nums(DESIGN_TOKENS §4).
            // placeholder 는 한글("무게"·"횟수"·"시간")이라 sans 로 되돌린다 — JetBrains Mono 에
            // 한글 글리프가 없어 그대로 두면 폴백 고정폭 글꼴로 튄다.
            "font-mono text-fg tabular-nums",
            "placeholder:font-sans placeholder:font-normal placeholder:text-fg-muted",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "disabled:bg-disabled disabled:text-disabled-fg",
            // 입력칸은 컨트롤이다 → 경계는 `border-control` 1px(DESIGN_TOKENS §5). 먹색은 강조 카드·보조 버튼 전용.
            invalid ? "border-danger" : "border-border-control",
            unit && "pr-10",
            trailing ? "pr-9" : null,
          )}
          {...props}
        />
        {trailing ? <div className="absolute right-1 flex items-center">{trailing}</div> : null}
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
