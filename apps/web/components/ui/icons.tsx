/**
 * 인라인 SVG 아이콘. 외부 아이콘 라이브러리를 쓰지 않는다(번들·오프라인 비용).
 * 색은 `currentColor` 를 따르고, 크기는 기본 24px(`size-6`) — 부모가 className 으로 바꾼다.
 * 아이콘은 **의미를 혼자 전달하지 않는다** — 반드시 aria-label 이 있는 버튼(IconButton) 안에서 쓴다.
 */
import { cn } from "./cn";

export type IconProps = {
  className?: string;
};

/** 아래 셰브론. F1-1: RIR 입력칸 안쪽에서 "고르기 시트"를 여는 버튼 표시. */
export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("size-6", className)}
    >
      <path
        d="m7 10 5 5 5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 삭제(휴지통). F5: 운동 카드에서 편집 화면 없이 바로 삭제. */
export function TrashIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("size-6", className)}
    >
      <path
        d="M4 6.5h16M9.5 4.5h5M6.8 6.5l.8 12.2a2 2 0 0 0 2 1.8h4.8a2 2 0 0 0 2-1.8l.8-12.2M10 10.5v6M14 10.5v6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
