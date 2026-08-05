/**
 * 사용법: <Card><Stat label="총 볼륨" value="1,250kg" note="지난주보다 +120kg" /></Card>
 * 화면 건너 읽는 큰 수치(--text-metric) 전용. 2~3개를 `grid grid-cols-2 gap-3` 에 넣어 쓴다.
 * value 는 이미 포맷된 문자열을 넣어라(단위·자릿수 규칙은 lib 쪽 포맷터가 정한다).
 */
import { cn } from "./cn";

export type StatProps = {
  label: string;
  value: string;
  /** 값 아래 보조 문구(선택). 없으면 렌더하지 않는다 — 빈 줄을 남기지 마라. */
  note?: string;
  className?: string;
};

export function Stat({ label, value, note, className }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="text-metric font-bold tabular-nums text-fg">{value}</p>
      {note ? <p className="text-sm text-fg-muted">{note}</p> : null}
    </div>
  );
}
