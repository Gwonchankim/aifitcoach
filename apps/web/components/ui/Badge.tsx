/**
 * 사용법: <Badge tone="success">증량</Badge> / <Badge tone="warn">통증 보고</Badge>
 * 색만으로 의미를 전달하지 않는다 — 반드시 글자(필요하면 아이콘)를 함께 넣어라.
 */
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "primary" | "success" | "warn" | "danger";

/**
 * 상태 배지는 **소프트**다(D-4 (b) 안): 면 `*-bg` + 글자 `*`/`*-ink` + 1px `*-border`.
 * `*-bg` 는 흰 카드 위에서 1.08:1 이라 거의 안 보인다 — **배지 모양을 만드는 건 테두리**다. 빼면 글자만 남는다.
 * 대비(계산은 `scripts/verify-contrast.mjs` 가 토큰 값에서 다시 잰다):
 *   success on `success-bg` **4.54:1** (ADR-51 — 여유가 0.04뿐이라 `success-bg` 는 변경 금지)
 *   `warn-ink` on `warn-bg` **5.14:1** / danger on `danger-bg` **5.61:1** / `fg` on `raised` **14.76:1**
 * `primary` 만 아직 솔리드다 — 쓰는 곳이 없어 이번 Sprint 범위에서 뺐다.
 * neutral 테두리는 `border-strong`(먹색)에서 `border`로 내렸다. 비인터랙티브 라벨이라
 * 강조 카드/현재 항목용 먹색 경계를 쓸 자리가 아니다(DESIGN_TOKENS §5).
 */
const toneClass: Record<BadgeTone, string> = {
  neutral: "bg-raised text-fg border border-border",
  primary: "border border-primary-border bg-primary-bg text-primary",
  success: "bg-success-bg text-success border border-success-border",
  warn: "bg-warn-bg text-warn-ink border border-warn-border",
  danger: "bg-danger-bg text-danger border border-danger-border",
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
        "inline-flex items-center gap-1 rounded-control text-xs font-semibold",
        densityClass[density],
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
