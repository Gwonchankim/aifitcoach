/**
 * 사용법: <Kicker>RIR</Kicker> / <Kicker as="h2">TODAY</Kicker>
 *
 * 값 위(또는 옆)에 붙는 **uppercase 모노 캡션**이다 — 9.5px · `letter-spacing:.14em` · muted
 * (DESIGN_TOKENS §4, 프로토타입 7종 합산 139회로 최다 빈도). 크기·자간은 `text-kicker` 토큰이 들고 있다.
 *
 * **한글에 쓰지 마라.** JetBrains Mono 에 한글 글리프가 없어 폴백 고정폭 글꼴로 튀고,
 * 9.5px 한글은 읽히지 않는다(§4). 한글 라벨은 `text-sm text-fg-muted` 를 그대로 써라.
 * 섹션 상단의 더 큰 키커(10.5px · `.18em`)가 필요하면 `className="text-kicker-lg"` 로 덮어쓴다.
 */
import type { ElementType, HTMLAttributes } from "react";
import { cn } from "./cn";

export type KickerProps = HTMLAttributes<HTMLElement> & {
  /** 기본은 `span`. 제목 자리에 쓰면 `h2`·`h3` 등으로 바꿔라. */
  as?: ElementType;
};

export function Kicker({ as: Tag = "span", className, ...props }: KickerProps) {
  return (
    <Tag className={cn("font-mono text-kicker uppercase text-fg-muted", className)} {...props} />
  );
}
