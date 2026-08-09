/**
 * 사용법: <Sheet open={open} id="rest-timer" title="휴식" footer={<Button size="lg" fullWidth>휴식 종료</Button>}>…</Sheet>
 * 한 손 조작을 위해 모달은 전부 하단 시트로 낸다(휴식 타이머 F2, 운동 추가/교체 F5).
 * 포커스 트랩·Esc 닫기·바디 스크롤 잠금은 frontend가 붙인다(여기는 마크업·스타일만).
 */
import type { ReactNode } from "react";
import { cn } from "./cn";

export type SheetProps = {
  open: boolean;
  /** 페이지 내 고유 id. 제목은 `${id}-title`로 연결된다. */
  id: string;
  title: string;
  children: ReactNode;
  /** 하단 고정 액션 영역(엄지 반경). */
  footer?: ReactNode;
  /** 배경(스크림) 탭으로 닫기. 넘기지 않으면 스크림은 반응하지 않는다. */
  onScrimClick?: () => void;
  className?: string;
};

export function Sheet({ open, id, title, children, footer, onScrimClick, className }: SheetProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-overlay" aria-hidden="true" onClick={onScrimClick} />

      <div
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={cn(
          "relative flex max-h-[85dvh] w-full max-w-md flex-col overflow-y-auto",
          // 그림자 없음(DESIGN_TOKENS §5). 시트가 떠 있다는 신호는 스크림 + 상단 1px 실선이 낸다.
          "rounded-t-sheet border-t border-border bg-raised px-4 pt-3",
          "pb-[calc(1rem_+_env(safe-area-inset-bottom))]",
          className,
        )}
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-border-strong" />

        <h2 id={`${id}-title`} className="text-xl font-bold text-fg">
          {title}
        </h2>

        <div className="mt-3">{children}</div>

        {footer ? <div className="mt-4">{footer}</div> : null}
      </div>
    </div>
  );
}
