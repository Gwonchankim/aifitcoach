/**
 * 사용법: <ProgressBar value={remainingPct} label="휴식 남은 시간" />
 * 휴식 타이머는 100%→0%로 줄어든다(F2). value는 "남은 비율"을 그대로 넣으면 된다.
 */
import { cn } from "./cn";

export type ProgressBarProps = {
  /** 0~100. 범위를 벗어나면 잘라낸다. */
  value: number;
  /** 스크린리더용 이름. 시각 라벨이 따로 있으면 그 텍스트와 같게 쓴다. */
  label: string;
  className?: string;
};

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, Math.round(value)));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn("h-3 w-full overflow-hidden rounded-full bg-border", className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
