/**
 * 사용법: <IconButton label="벤치프레스 삭제" tone="danger" onClick={remove}><TrashIcon /></IconButton>
 *
 * 글자 없는 버튼이다 → `label`(접근 이름)이 **필수**다. 아이콘만으로는 스크린리더가 읽을 게 없다.
 * 눌러도 소용없지만 사유를 알려야 하는 상태(기록이 있어 삭제 불가 등)는 `disabled` 대신
 * `aria-disabled` + `reason` 을 넘겨라 — 포커스와 클릭이 살아 있어서 사유 안내(토스트)를 띄울 수 있고,
 * 스크린리더는 이름 뒤에 사유를 함께 읽는다("벤치프레스 삭제, 기록이 있어 삭제할 수 없어요").
 * 크기는 44px 고정(§7.6 탭 타겟 하한) — 밀도가 필요해도 이 값을 내리지 마라.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type IconButtonTone = "neutral" | "danger";

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "aria-label" | "children"
> & {
  /** 접근 이름. 무엇에 대한 동작인지까지 넣어라(예: "벤치프레스 삭제"). */
  label: string;
  /** `aria-disabled` 일 때만 이름 뒤에 붙는 사유. 화면 안내(토스트)는 호출부가 띄운다. */
  reason?: string;
  tone?: IconButtonTone;
  /** 인라인 SVG 아이콘 하나(icons.tsx). */
  children: ReactNode;
};

const toneClass: Record<IconButtonTone, string> = {
  // 대비(비텍스트 3:1 기준): 다크 7.52:1 / 라이트 5.85:1
  neutral: "text-fg-muted hover:bg-raised hover:text-fg active:bg-raised",
  // 대비: 다크 5.73:1 / 라이트 6.57:1
  danger: "text-danger hover:bg-raised active:bg-raised",
};

/** Button 의 aria-disabled 톤과 같은 색을 쓴다(다크 4.40:1 / 라이트 3.78:1 — §7.6 비활성 3:1 유지). */
const inactiveClass = "bg-disabled text-disabled-fg";

export function IconButton({
  label,
  reason,
  tone = "neutral",
  className,
  "aria-disabled": ariaDisabled,
  children,
  ...props
}: IconButtonProps) {
  const inactive = ariaDisabled === true || ariaDisabled === "true";

  return (
    <button
      type="button"
      aria-disabled={ariaDisabled}
      aria-label={inactive && reason ? `${label}, ${reason}` : label}
      className={cn(
        "inline-flex size-tap shrink-0 touch-manipulation items-center justify-center",
        "rounded-control bg-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg",
        inactive ? inactiveClass : toneClass[tone],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
