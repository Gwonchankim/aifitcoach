/**
 * 사용법: <Card><h2 className="text-lg font-semibold">벤치프레스</h2>…</Card>
 * 운동 카드·요약 카드 공통 컨테이너. 강조가 필요하면 tone="raised".
 * 한 화면에 카드가 5개 넘게 쌓이는 로깅 화면은 density="tight"(p-3)로 낮춰라.
 */
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  tone?: "surface" | "raised";
  density?: "default" | "tight";
};

export function Card({ tone = "surface", density = "default", className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-border shadow-card",
        density === "tight" ? "p-3" : "p-4",
        tone === "raised" ? "bg-raised" : "bg-surface",
        className,
      )}
      {...props}
    />
  );
}
