/**
 * 사용법: <TabList label="부위"><Tab selected={t==="chest"} id="tab-chest" panelId="panel-chest" onClick={…}>가슴</Tab>…</TabList>
 * 운동 추가/교체 시트의 부위 탭(F5)용. 좌우 스크롤 + 큰 탭 타겟. 키보드 화살표 이동은 frontend가 붙인다.
 */
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "./cn";
import { selectionStateClass } from "./selection-state";

export type TabListProps = HTMLAttributes<HTMLDivElement> & {
  /** 탭 그룹의 이름(스크린리더용). 예: "부위" */
  label: string;
};

export function TabList({ label, className, ...props }: TabListProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex gap-2 overflow-x-auto border-b border-border pb-2",
        "[-ms-overflow-style:none] [scrollbar-width:none]",
        className,
      )}
      {...props}
    />
  );
}

export type TabProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "role" | "id"> & {
  selected: boolean;
  /** 탭 자신의 id. 패널의 aria-labelledby가 이 값을 가리킨다. */
  id: string;
  /** 이 탭이 여는 패널의 id. */
  panelId: string;
};

export function Tab({ selected, id, panelId, className, ...props }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      className={cn(
        "min-h-tap-lg shrink-0 touch-manipulation rounded-control border px-4 text-base",
        "transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:bg-disabled disabled:text-disabled-fg",
        selectionStateClass(selected),
        className,
      )}
      {...props}
    />
  );
}
