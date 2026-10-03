"use client";

import { useId } from "react";
import type { SplitPreference } from "./draft";

export const SPLIT_PREFERENCE_LABELS: Record<SplitPreference, string> = {
  balanced: "균형 있게",
  upper_priority: "상체 우선",
  lower_priority: "하체 우선",
};

export function SplitPreferenceFields({
  value,
  onChange,
  disabled = false,
  supported,
  days,
}: {
  value: SplitPreference | null;
  onChange: (value: SplitPreference | null) => void;
  disabled?: boolean;
  supported?: boolean;
  /** Profile can save any preference; only generation constrains days. */
  days?: number;
}) {
  const id = useId();
  const priorityDisabled = supported === true && days !== undefined && days !== 5;
  return (
    <fieldset disabled={disabled} aria-describedby={`${id}-hint`} className="flex flex-col gap-2">
      <legend className="mb-2 text-base font-semibold text-fg">운동 분할 선호</legend>
      <div className="grid grid-cols-2 gap-2">
        {(["balanced", "upper_priority", "lower_priority", null] as const).map((preference) => (
          <label
            key={preference ?? "clear"}
            className="flex min-h-12 items-center gap-2 rounded-control border border-border px-3 text-sm text-fg has-[:disabled]:text-fg-muted"
          >
            <input
              type="radio"
              name={id}
              value={preference ?? ""}
              checked={value === preference}
              disabled={
                disabled ||
                (priorityDisabled &&
                  (preference === "upper_priority" || preference === "lower_priority"))
              }
              onChange={() => onChange(preference)}
              className="h-4 w-4 accent-action focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus"
            />
            {preference === null ? "선호 없음" : SPLIT_PREFERENCE_LABELS[preference]}
          </label>
        ))}
      </div>
      <p id={`${id}-hint`} className="text-sm text-ink-2">
        {supported === false
          ? "선호는 저장할 수 있지만 지금 계획 방식에는 아직 적용되지 않아요."
          : supported === true && days === 5
            ? "균형 있게(기본)와 상체 우선은 상체 3일·하체 2일, 하체 우선은 상체 2일·하체 3일로 배치해요."
            : days === 4
              ? "주 4일은 상체 2일·하체 2일로 균형 있게 배치해요."
              : days !== undefined && days !== 5
                ? "주 2·3·6일 계획에는 분할 선호가 적용되지 않아요."
                : "새 계획을 만들 때 반영해요. 지금 계획은 바뀌지 않아요."}
      </p>
    </fieldset>
  );
}
