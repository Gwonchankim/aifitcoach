import type { Program } from "../../lib/api";
import { SPLIT_PREFERENCE_LABELS } from "./SplitPreferenceFields";

/** Only the immutable program snapshot controls this copy, never today's profile. */
export function SplitPreferenceSummary({
  snapshot,
}: {
  snapshot: Program["split_preference_snapshot"] | undefined;
}) {
  return (
    <section aria-label="이 계획의 분할 선호" className="flex flex-col gap-1 text-sm text-ink-2">
      {snapshot?.applicable && snapshot.effective_preference ? (
        <>
          <p>
            {SPLIT_PREFERENCE_LABELS[snapshot.effective_preference]} · 상체 {snapshot.upper_days}일
            · 하체 {snapshot.lower_days}일
          </p>
          {snapshot.reason === "four_day_balanced_only" ? (
            <p>주 4일은 상체 2일·하체 2일로 균형 있게 배치해요.</p>
          ) : null}
        </>
      ) : (
        <p>이 계획에는 선호가 적용되지 않았어요</p>
      )}
    </section>
  );
}
