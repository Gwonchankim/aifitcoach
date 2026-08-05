/**
 * 사용법: <Badge tone="success">증량</Badge> / <Badge tone="warn">통증 보고</Badge>
 * 색만으로 의미를 전달하지 않는다 — 반드시 글자(필요하면 아이콘)를 함께 넣어라.
 */
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "primary" | "success" | "warn" | "danger";

const toneClass: Record<BadgeTone, string> = {
  neutral: "bg-raised text-fg border border-border-strong",
  primary: "bg-primary text-primary-fg",
  success: "bg-success text-success-fg",
  warn: "bg-warn text-warn-fg",
  danger: "bg-danger text-danger-fg",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /**
   * `compact` 는 세트 행처럼 한 줄에 여러 요소가 경쟁하는 곳에서 쓴다.
   * 배지가 줄을 밀어내면 행이 2줄 → 3줄이 되고 15세트면 480px 가 늘어난다.
   * 글자 크기는 줄이지 않는다(판독 유지) — 좌우 여백만 줄인다.
   */
  density?: "default" | "compact";
};

const densityClass: Record<"default" | "compact", string> = {
  default: "px-2.5 py-1",
  compact: "px-1.5 py-0.5",
};

export function Badge({ tone = "neutral", density = "default", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full text-xs font-semibold",
        densityClass[density],
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
