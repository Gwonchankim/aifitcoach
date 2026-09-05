/**
 * 운동 카드(세트 행 묶음 + 3항목 앵커 메뉴). F1·F5·F7.
 * 무게 축 배지("무게 미정"·"자체중량")는 **운동 단위 성질**이라 카드 상단에 한 번만 둔다(F1-0).
 */
"use client";

import type { Exercise, PlannedSet } from "../../lib/api";
import { Badge, Card } from "../ui";
import { ExerciseMenu } from "./ExerciseMenu";
import {
  assistanceAction,
  assistanceBadge,
  reasonLabel,
  setKind,
  weightBadge,
  type SetValues,
} from "./set-rules";
import { SetRow } from "./SetRow";
import type { SetDraft } from "./session-store";

const BASELINE_NOTE =
  "첫 세션이라 추천 무게가 아직 없어요. 가볍게 워밍업하면서 오늘의 무게를 정해 보세요.";

export type ExerciseCardProps = {
  name: string;
  exercise: Exercise | null;
  /** 전환 제안의 이름도 현재 받은 권위 카탈로그에서만 읽는다. */
  catalogById?: ReadonlyMap<string, Exercise>;
  sets: PlannedSet[];
  drafts: Record<string, SetDraft>;
  readOnly: boolean;
  /** 완료 체크된 세트가 있으면 삭제·교체를 막는다(AC-S4-4, 409 예방). */
  lockedReason: string | null;
  /** 이 운동에 기록된 통증 점수(없으면 null). */
  painScore: number | null;
  /** 지금 펼쳐 둔 완료 세트(화면 전체에서 하나뿐이다, AC-SET-8). */
  expandedSetId: string | null;
  onToggleExpand: (plannedSetId: string) => void;
  /** 펼친 완료 세트의 값 수정(휴식 타이머를 열지 않는다). */
  onEdit: (set: PlannedSet, values: SetValues) => void;
  onSwap: () => void;
  onRemove: () => void;
  /** 기록이 있어 교체·삭제할 수 없을 때(메뉴 항목은 aria-disabled 라 활성화가 그대로 온다). */
  onRemoveBlocked: () => void;
  onReportPain: () => void;
  onComplete: (set: PlannedSet, values: SetValues) => void;
  onUncomplete: (set: PlannedSet) => void;
};

export function ExerciseCard({
  name,
  exercise,
  catalogById,
  sets,
  drafts,
  readOnly,
  lockedReason,
  painScore,
  expandedSetId,
  onToggleExpand,
  onEdit,
  onSwap,
  onRemove,
  onRemoveBlocked,
  onReportPain,
  onComplete,
  onUncomplete,
}: ExerciseCardProps) {
  const completedCount = sets.filter((set) => drafts[set.id]?.completed).length;
  const kinds = sets.map((set) => setKind(set, exercise?.metric, exercise?.step_kg));
  // 근거·무게 배지는 카드 단위다 → 이 종목의 축(시간/자체중량/무게)에 맞는 문구만 남긴다.
  const reason = reasonLabel(sets[0]?.reason_code ?? "", kinds[0], sets[0]);
  // 어시스트는 "덜어주는 kg" 이라 무게 배지 자리에 도움 배지가 온다(F-4b).
  const badge = (sets[0] ? assistanceBadge(sets[0]) : null) ?? weightBadge(kinds[0] ?? "weighted");
  const showBaselineNote = kinds.some((kind) => kind === "unknown_weight");
  const menuId = `exercise-${sets[0]?.exercise_id ?? "unknown"}-menu`;
  const lockedReasonId = `${menuId}-locked-reason`;
  const action = sets[0] ? assistanceAction(sets[0]) : null;
  const suggestedName = action ? catalogById?.get(action.exercise_id)?.name_ko : null;
  const lastSyllable = suggestedName
    ? suggestedName.charCodeAt(suggestedName.length - 1) - 0xac00
    : -1;
  const objectParticle =
    lastSyllable >= 0 && lastSyllable <= 11171 && lastSyllable % 28 === 0 ? "를" : "을";

  return (
    <Card density="tight" className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        {/* 이름은 남는 폭에서 두 줄까지 자연스럽게 감고, 우측에는 48px 메뉴 트리거 하나만 둔다. */}
        <h2 className="min-w-0 flex-1 text-lg font-bold text-fg">{name}</h2>
        {readOnly ? null : (
          <ExerciseMenu
            name={name}
            menuId={menuId}
            lockedReason={lockedReason}
            lockedReasonId={lockedReasonId}
            painScore={painScore}
            onSwap={onSwap}
            onReportPain={onReportPain}
            onRemove={onRemove}
            onBlocked={onRemoveBlocked}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* 카드가 세로로 쌓이면 이 카운터도 같은 자리에 서는 열이다 → 숫자만 모노 + tabular-nums.
            "세트 완료"는 한글이라 모노를 씌우지 않는다(§4). */}
        <span className="shrink-0 text-sm text-fg-muted">
          <span className="font-mono tabular-nums">
            {completedCount}/{sets.length}
          </span>{" "}
          세트 완료
        </span>
      </div>

      {reason || badge || painScore != null ? (
        <div className="flex flex-wrap items-center gap-2">
          {badge ? (
            <Badge aria-label={badge.label} density="compact">
              {badge.text}
            </Badge>
          ) : null}
          {reason ? <Badge>{reason}</Badge> : null}
          {painScore != null ? (
            <Badge tone="warn" aria-label={`기록한 통증 ${painScore}점`}>
              통증 {painScore}점
            </Badge>
          ) : null}
        </div>
      ) : null}

      {lockedReason ? (
        <p id={lockedReasonId} className="text-sm text-fg-muted">
          {lockedReason}
        </p>
      ) : null}
      {showBaselineNote ? <p className="text-sm text-fg-muted">{BASELINE_NOTE}</p> : null}
      {suggestedName ? (
        <p className="text-sm text-fg-muted">
          다음 단계로 {suggestedName}
          {objectParticle} 고려해 보세요
        </p>
      ) : null}

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
              expanded={expandedSetId === set.id}
              onToggleExpand={() => onToggleExpand(set.id)}
              onComplete={(values) => onComplete(set, values)}
              onEdit={(values) => onEdit(set, values)}
              onUncomplete={() => onUncomplete(set)}
            />
          );
        })}
      </ul>
    </Card>
  );
}
