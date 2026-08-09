/**
 * 사용법: 0~10 통증 점수처럼 **값 하나를 고르는 눈금**을 한 줄에 담는다.
 * (RIR 은 F1-1 2차 개정으로 **입력칸 하나**가 됐다 → components/session/RirField.tsx)
 *
 *   <ScaleGroup label={`${exerciseName} 통증 점수, 0~10, 선택 입력`}>
 *     {PAIN_SCORES.map((n) => (
 *       <ScaleOption key={n} name={`pain-${id}`} label={`통증 ${n}점`}
 *         checked={score === n} onChange={() => setScore(n)}>{n}</ScaleOption>
 *     ))}
 *   </ScaleGroup>
 *
 * 왜 가로 스크롤인가: 44px 타겟 7개는 390px 화면의 세트 행 안에 다 들어가지 않는다.
 * 줄바꿈(flex-wrap)하면 행 높이가 44 → 96px 로 뛰고 15세트면 780px가 늘어난다.
 * **타겟을 줄이는 대신 가로로 넘긴다** — 세로 스크롤이 훨씬 비싸다(§7.6 44px 하한 유지).
 * 잘린 옵션이 오른쪽 끝에 반쯤 보이는 게 "더 있다"는 유일한 신호이므로 마스크·그림자로 덮지 마라.
 * 옵션이 4개 이하로 확실히 들어차는 곳에는 쓰지 마라(Chip 을 써라).
 */
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Kicker } from "./Kicker";

export type ScaleGroupProps = {
  /** 그룹 이름(스크린리더 전용). 예: "3세트 남은 반복 수(RIR), 선택 입력" */
  label: string;
  /** 눈금 왼쪽에 붙는 짧은 시각 라벨. 예: "RIR" (스크린리더에는 label 이 이미 있어 숨긴다) */
  prefix?: string;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
};

export function ScaleGroup({ label, prefix, disabled, children, className }: ScaleGroupProps) {
  return (
    <fieldset disabled={disabled} className={cn("flex min-w-0 items-center gap-2", className)}>
      <legend className="sr-only">{label}</legend>

      {prefix ? (
        // 눈금 옆의 짧은 라틴 라벨("RIR")이다 = 키커. 한글 라벨을 넣지 마라(Kicker 주석 참조).
        <Kicker aria-hidden="true" className="shrink-0">
          {prefix}
        </Kicker>
      ) : null}

      {/* py/-my 는 포커스 링(3px + offset 2px)이 스크롤 컨테이너에 잘리지 않게 하는 여유다.
          바깥 높이는 그대로 44px 로 유지된다.
          relative 는 필수다 — sr-only 라디오가 absolute 라, 컨테이닝 블록이 없으면 이 컨테이너의
          클리핑을 빠져나가 문서 폭을 밀어낸다(실측: 문서에 3px 가로 스크롤 발생). */}
      <div
        className={cn(
          "relative -my-1.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1.5",
          "[-ms-overflow-style:none] [scrollbar-width:none]",
        )}
      >
        {children}
      </div>
    </fieldset>
  );
}

export type ScaleOptionProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className" | "children"
> & {
  /** 스크린리더용 이름. 숫자만으로는 무슨 값인지 모른다. 예: "RIR 3" */
  label: string;
  /** 화면에 보이는 값(보통 숫자 1~2자리). */
  children: ReactNode;
  className?: string;
};

export function ScaleOption({ label, children, className, ...props }: ScaleOptionProps) {
  return (
    <label
      className={cn(
        "inline-flex size-tap shrink-0 cursor-pointer touch-manipulation items-center justify-center",
        // 0~10 눈금이라 값은 모노 + tabular-nums 다(§4). "9" 와 "10" 이 같은 폭 원 안에서 흔들리면 안 된다.
        // 테두리는 먹색 유지 — §5 가 "1.6px 체크·라디오·상태 마크"로 분류한 자리다(라디오).
        "rounded-full border border-border-strong bg-surface font-mono text-base font-semibold tabular-nums text-fg",
        "has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-fg",
        "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-focus",
        "has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-bg",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:border-border",
        "has-[:disabled]:bg-disabled has-[:disabled]:text-disabled-fg",
        className,
      )}
    >
      {/* 같은 name 을 공유하면 방향키 이동이 브라우저 기본 동작으로 붙는다(§7.5). */}
      <input type="radio" className="sr-only" aria-label={label} {...props} />
      <span aria-hidden="true">{children}</span>
    </label>
  );
}
