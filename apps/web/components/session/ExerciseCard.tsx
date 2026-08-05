/**
 * 운동 카드(세트 행 묶음 + 편집 진입). F1·F5·F7.
 */
"use client";

import type { Exercise, PlannedSet } from "../../lib/api";
import { Badge, Button, Card } from "../ui";
import { reasonLabel, setKind, type SetValues } from "./set-rules";
import { SetRow } from "./SetRow";
import type { SetDraft } from "./session-store";

const BASELINE_NOTE =
  "첫 세션이라 추천 무게가 아직 없어요. 가볍게 워밍업하면서 오늘의 무게를 정해 보세요.";

export type ExerciseCardProps = {
  name: string;
  exercise: Exercise | null;
  sets: PlannedSet[];
  drafts: Record<string, SetDraft>;
  readOnly: boolean;
  /** 완료 체크된 세트가 있으면 삭제·교체를 막는다(AC-S4-4, 409 예방). */
  lockedReason: string | null;
  /** 이 운동에 기록된 통증 점수(없으면 null). */
  painScore: number | null;
  onEdit: () => void;
  onReportPain: () => void;
  onComplete: (set: PlannedSet, values: SetValues) => void;
  onUncomplete: (set: PlannedSet) => void;
};

export function ExerciseCard({
  name,
  exercise,
  sets,
  drafts,
  readOnly,
  lockedReason,
  painScore,
  onEdit,
  onReportPain,
  onComplete,
  onUncomplete,
}: ExerciseCardProps) {
  const completedCount = sets.filter((set) => drafts[set.id]?.completed).length;
  const kinds = sets.map((set) => setKind(set, exercise?.metric));
  // 근거 배지는 카드 단위다 → 이 종목의 축(시간/자체중량/무게)에 맞는 문구만 남긴다.
  const reason = reasonLabel(sets[0]?.reason_code ?? "", kinds[0]);
  const showBaselineNote = kinds.some((kind) => kind === "unknown_weight");

  return (
    <Card density="tight" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 text-lg font-bold text-fg">{name}</h2>

        {readOnly ? null : (
          <div className="flex shrink-0 items-center gap-2">
            {/* 보이는 글자는 짧게, 접근 이름은 운동 이름까지 붙여 준다(WCAG 2.5.3: 보이는 글자 ⊂ 접근 이름). */}
            <Button
              variant="secondary"
              size="sm"
              onClick={onEdit}
              disabled={lockedReason != null}
              aria-label={`${name} 루틴 편집`}
            >
              편집
            </Button>
            {/* 통증 보고는 세트 입력 흐름을 막지 않는 보조 액션이다(기본 접힘 → 시트). */}
            <Button
              variant="secondary"
              size="sm"
              onClick={onReportPain}
              aria-label={`${name} 통증 기록`}
            >
              통증 기록
            </Button>
          </div>
        )}
      </div>

      {/* 진행 표기와 배지는 한 줄에 모은다(카드 5개 × 한 줄 = 120px). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-muted">
          {completedCount}/{sets.length} 세트 완료
        </span>
        {reason ? <Badge>{reason}</Badge> : null}
        {painScore != null ? (
          <Badge tone="warn" aria-label={`기록한 통증 ${painScore}점`}>
            통증 {painScore}점
          </Badge>
        ) : null}
      </div>
      {lockedReason ? <p className="text-sm text-fg-muted">{lockedReason}</p> : null}
      {showBaselineNote ? <p className="text-sm text-fg-muted">{BASELINE_NOTE}</p> : null}

      <ul className="flex flex-col gap-1.5">
        {sets.map((set, index) => {
          const kind = kinds[index];
          const earlier = sets.slice(0, index);
          const fallbackWeight =
            earlier
              .map((previousSet) => drafts[previousSet.id]?.actual_weight)
              .filter((weight): weight is number => weight != null)
              .at(-1) ?? null;
          const previous =
            earlier
              .map((previousSet) => drafts[previousSet.id])
              .filter((draft): draft is SetDraft => draft?.completed === true)
              .at(-1) ?? null;

          return (
            <SetRow
              key={set.id}
              set={set}
              kind={kind}
              exerciseName={name}
              draft={drafts[set.id]}
              fallbackWeight={fallbackWeight}
              previous={previous}
              readOnly={readOnly}
              onComplete={(values) => onComplete(set, values)}
              onUncomplete={() => onUncomplete(set)}
            />
          );
        })}
      </ul>
    </Card>
  );
}
