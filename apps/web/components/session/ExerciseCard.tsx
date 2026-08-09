/**
 * 운동 카드(세트 행 묶음 + 편집 진입). F1·F5·F7.
 *
 * 액션 역할 분리(F5, 확정 2026-08-05):
 *   [교체] = 다른 운동으로 바꾸기(추가는 목록 하단의 [운동 추가]),
 *   [휴지통] = 이 운동을 루틴에서 빼기.
 * 무게 축 배지("무게 미정"·"자체중량")는 **운동 단위 성질**이라 카드 상단에 한 번만 둔다(F1-0).
 */
"use client";

import type { Exercise, PlannedSet } from "../../lib/api";
import { Badge, Button, Card, IconButton, TrashIcon } from "../ui";
import { reasonLabel, setKind, weightBadge, type SetValues } from "./set-rules";
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
  /** 지금 펼쳐 둔 완료 세트(화면 전체에서 하나뿐이다, AC-SET-8). */
  expandedSetId: string | null;
  onToggleExpand: (plannedSetId: string) => void;
  /** 펼친 완료 세트의 값 수정(휴식 타이머를 열지 않는다). */
  onEdit: (set: PlannedSet, values: SetValues) => void;
  onSwap: () => void;
  onRemove: () => void;
  /** 기록이 있어 뺄 수 없을 때(휴지통은 aria-disabled 라 클릭이 그대로 온다). */
  onRemoveBlocked: () => void;
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
  const kinds = sets.map((set) => setKind(set, exercise?.metric));
  // 근거·무게 배지는 카드 단위다 → 이 종목의 축(시간/자체중량/무게)에 맞는 문구만 남긴다.
  const reason = reasonLabel(sets[0]?.reason_code ?? "", kinds[0]);
  const badge = weightBadge(kinds[0] ?? "weighted");
  const showBaselineNote = kinds.some((kind) => kind === "unknown_weight");
  const locked = lockedReason != null;

  return (
    <Card density="tight" className="flex flex-col gap-2">
      {/* 제목은 한 줄을 통째로 쓴다 — 액션과 나란히 두면 390px 에서 운동 이름이 잘린다. */}
      <h2 className="min-w-0 text-lg font-bold text-fg">{name}</h2>

      <div className="flex items-center gap-2">
        {/* 카드가 세로로 쌓이면 이 카운터도 같은 자리에 서는 열이다 → 숫자만 모노 + tabular-nums.
            "세트 완료"는 한글이라 모노를 씌우지 않는다(§4). */}
        <span className="shrink-0 text-sm text-fg-muted">
          <span className="font-mono tabular-nums">
            {completedCount}/{sets.length}
          </span>{" "}
          세트 완료
        </span>

        {readOnly ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* 보이는 글자는 짧게, 접근 이름은 운동 이름까지 붙여 준다(WCAG 2.5.3: 보이는 글자 ⊂ 접근 이름). */}
            <Button
              variant="secondary"
              size="sm"
              onClick={onSwap}
              disabled={locked}
              aria-label={`${name} 교체`}
            >
              교체
            </Button>
            {/* 통증 보고는 세트 입력 흐름을 막지 않는 보조 액션이다(기본 접힘 → 시트). */}
            <Button
              variant="secondary"
              size="sm"
              onClick={onReportPain}
              aria-label={`${name} 통증 기록`}
            >
              통증
            </Button>
            {/*
              기록이 있으면 뺄 수 없다(409 예방). disabled 로 막으면 포커스도 클릭도 사라져
              **왜 못 빼는지 알려줄 수 없다** → aria-disabled + 사유로 둔다(AC-DEL-3/4).
            */}
            <IconButton
              label={`${name} 삭제`}
              reason={locked ? "기록이 있어 뺄 수 없어요" : undefined}
              tone="danger"
              aria-disabled={locked || undefined}
              onClick={locked ? onRemoveBlocked : onRemove}
            >
              <TrashIcon />
            </IconButton>
          </div>
        )}
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
