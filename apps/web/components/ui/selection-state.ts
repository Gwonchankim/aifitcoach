/** 선택은 연한 채움 + 진한 테두리 + 굵은 글자라는 공용 시각 계약이다(ADR-52). */
export const SELECTED_SELECTION_CLASS =
  "border-action bg-primary-bg font-semibold text-fg hover:bg-primary-bg";

export const UNSELECTED_SELECTION_CLASS =
  "border-border-control bg-surface font-medium text-fg hover:bg-raised";

export const NATIVE_CHECKED_SELECTION_CLASS =
  "has-[:checked]:border-action has-[:checked]:bg-primary-bg has-[:checked]:font-semibold";

export function selectionStateClass(selected: boolean): string {
  return selected ? SELECTED_SELECTION_CLASS : UNSELECTED_SELECTION_CLASS;
}
