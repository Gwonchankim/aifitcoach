/**
 * 세트 1행(F1): 이전 기록 · 무게 · 횟수 · RIR(선택) · 완료 체크.
 * 입력 문자열은 행 로컬 상태로 두고, **완료 체크 시점에** 기록값으로 확정해 스토어에 넣는다
 * (F7: 완료 체크된 세트만 기록한다).
 */
"use client";

import { useState } from "react";
import type { PlannedSet } from "../../lib/api";
import { Badge, CompleteButton, Input, ScaleGroup, ScaleOption, cn } from "../ui";
import {
  asksRir,
  formatKg,
  hasWeightInput,
  missingField,
  resolveValues,
  setPrefill,
  targetLabel,
  weightBadge,
  type SetKind,
  type SetValues,
} from "./set-rules";
import type { SetDraft } from "./session-store";

const RIR_OPTIONS = [0, 1, 2, 3, 4, 5, 6];

const MISSING_HINT: Record<"weight" | "reps" | "time", string> = {
  weight: "무게를 입력해 주세요.",
  reps: "횟수를 입력해 주세요.",
  time: "유지 시간을 입력해 주세요.",
};

/** 세트 행에서 먼저 채워야 하는 입력칸의 id(포커스 이동에 쓴다). */
export function primaryInputId(set: PlannedSet, kind: SetKind): string {
  if (kind === "time") return `set-${set.id}-time`;
  if (hasWeightInput(kind)) return `set-${set.id}-weight`;
  return `set-${set.id}-reps`;
}

function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 같은 세션의 직전 완료 세트 표기. 기록이 없으면 null. */
function previousLabel(draft: SetDraft): string | null {
  const recorded = recordLabel(draft);
  return recorded ? `직전 ${recorded}` : null;
}

/** 기록값 한 줄("62.5kg × 9회", "45초"). 기록이 없으면 null. */
function recordLabel(draft: SetDraft): string | null {
  if (draft.actual_time_sec != null) return `${draft.actual_time_sec}초`;
  if (draft.actual_reps == null) return null;
  const weight = draft.actual_weight != null ? `${formatKg(draft.actual_weight)} × ` : "";
  return `${weight}${draft.actual_reps}회`;
}

export type SetRowProps = {
  set: PlannedSet;
  kind: SetKind;
  /** 스크린리더 라벨용 운동 이름. */
  exerciseName: string;
  draft?: SetDraft;
  /** 같은 운동의 앞 세트에 입력한 무게(무게 미정 세트의 2세트 이후 프리필). */
  fallbackWeight: number | null;
  /** 같은 운동의 직전 완료 세트. */
  previous: SetDraft | null;
  readOnly: boolean;
  onComplete: (values: SetValues) => void;
  onUncomplete: () => void;
};

export function SetRow({
  set,
  kind,
  exerciseName,
  draft,
  fallbackWeight,
  previous,
  readOnly,
  onComplete,
  onUncomplete,
}: SetRowProps) {
  const [weightText, setWeightText] = useState(() =>
    draft?.actual_weight != null
      ? String(draft.actual_weight)
      : kind === "weighted" && set.recommended_weight != null
        ? String(set.recommended_weight)
        : "",
  );
  const [repsText, setRepsText] = useState(() =>
    draft?.actual_reps != null
      ? String(draft.actual_reps)
      : set.recommended_reps != null
        ? String(set.recommended_reps)
        : "",
  );
  const [timeText, setTimeText] = useState(() =>
    draft?.actual_time_sec != null
      ? String(draft.actual_time_sec)
      : set.target_time_low_sec != null
        ? String(set.target_time_low_sec)
        : "",
  );
  const [rir, setRir] = useState<number | null>(draft?.actual_rir ?? null);
  const [missing, setMissing] = useState<"weight" | "reps" | "time" | null>(null);

  const completed = draft?.completed === true;
  const badge = weightBadge(kind);
  const setLabel = `${exerciseName} ${set.set_no}세트`;

  // 무게 미정 세트는 프리필이 없다. 대신 같은 운동의 앞 세트 값을 이어 쓴다(§5.2).
  const shownWeight =
    weightText !== "" || kind !== "unknown_weight" || fallbackWeight == null
      ? weightText
      : String(fallbackWeight);

  const values: SetValues = {
    weight: hasWeightInput(kind) ? parseNumber(shownWeight) : null,
    reps: kind === "time" ? null : parseNumber(repsText),
    rir: asksRir(kind) ? rir : null,
    timeSec: kind === "time" ? parseNumber(timeText) : null,
  };

  const handleToggle = () => {
    if (completed) {
      onUncomplete();
      return;
    }
    // 빈 칸은 프리필 추천값으로 확정한다(§2.4). 확정해도 비면 체크를 막는다(§5.2).
    const resolved = resolveValues(kind, values, setPrefill(kind, set));
    const blocked = missingField(kind, resolved);
    setMissing(blocked);
    if (blocked) {
      document.getElementById(`set-${set.id}-${blocked}`)?.focus();
      return;
    }
    // 확정된 값은 행에도 그대로 표기한다(사용자가 무엇이 기록됐는지 볼 수 있어야 한다).
    if (resolved.weight != null) setWeightText(String(resolved.weight));
    if (resolved.reps != null) setRepsText(String(resolved.reps));
    if (resolved.timeSec != null) setTimeText(String(resolved.timeSec));
    onComplete(resolved);
  };

  const target = targetLabel(kind, set);
  /*
    배지는 2줄로 내린다. 1줄에 같이 두면 390px 에서 입력칸이 50px 아래로 눌린다
    (314 − 체크 72 − 세트번호 40 − 배지 72 = 두 칸에 남는 폭 100px).
  */
  const badges = (
    <>
      {completed ? (
        <Badge tone="success" className="shrink-0">
          ✓ 완료
        </Badge>
      ) : null}
      {badge ? (
        <Badge aria-label={badge.label} className="shrink-0">
          {badge.text}
        </Badge>
      ) : null}
    </>
  );

  /*
    직전 기록은 "이번 세션에서 완료한 세트"만 대상이다(지난 세션 기록은 STEP 6 에서 로컬 미러가 붙은 뒤).
    목표·직전 기록은 **전용 줄을 만들지 않고** RIR 줄에 인라인으로 얹는다(세트 15개면 줄 하나가 480px 다).
  */
  const meta = [target, previous ? previousLabel(previous) : null].filter(Boolean).join(" · ");

  /*
    완료된 세션(AC-S4-3): 입력·체크 UI 를 **DOM 에 두지 않는다**(disabled 로 남기면
    "아직 시작 안 한 운동"처럼 보인다). 대신 기록 요약행이나 종료 상태를 글로 남긴다.
    기록은 이 세션 화면의 로컬 상태에서만 온다(서버 수행 기록 조회 경로는 계약에 없다).
  */
  if (readOnly) {
    const recorded = draft ? recordLabel(draft) : null;
    return (
      <li className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-bg p-3">
        <span className="shrink-0 text-sm font-semibold text-fg tabular-nums">
          {set.set_no}세트
        </span>
        {badges}
        <span className="min-w-0 text-sm text-fg-muted">
          {recorded ? `기록 ${recorded}` : "종료한 운동이라 입력할 수 없어요."}
        </span>
      </li>
    );
  }

  /*
    2줄 고정 그리드.
      1줄 = 세트번호 · 배지 · 입력칸,  2줄 = RIR · 목표/직전 기록,  오른쪽 = 완료 체크(두 줄 span).
    DOM 순서는 무게 → 횟수 → RIR → 완료 체크 그대로 두고(§7.1 탭 순서·AC-A-1),
    완료 체크만 그리드 배치로 오른쪽에 세운다(§8 엄지 반경).
  */
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5",
        "rounded-control border border-border bg-bg p-2.5",
        completed && "opacity-70",
      )}
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-sm font-semibold text-fg tabular-nums">
          {set.set_no}세트
        </span>
        <div className="flex min-w-0 flex-1 items-end gap-2">
          {kind === "time" ? (
            <Input
              id={`set-${set.id}-time`}
              label={`${setLabel} 유지 시간, 초`}
              hideLabel
              density="compact"
              unit="초"
              inputMode="numeric"
              placeholder="시간"
              value={timeText}
              disabled={readOnly || completed}
              invalid={missing === "time"}
              hint={missing === "time" ? MISSING_HINT.time : undefined}
              onChange={(event) => setTimeText(event.target.value)}
            />
          ) : (
            <>
              {hasWeightInput(kind) ? (
                <Input
                  id={`set-${set.id}-weight`}
                  label={`${setLabel} 무게, 킬로그램`}
                  hideLabel
                  density="compact"
                  unit="kg"
                  inputMode="decimal"
                  placeholder="무게"
                  value={shownWeight}
                  disabled={readOnly || completed}
                  invalid={missing === "weight"}
                  hint={missing === "weight" ? MISSING_HINT.weight : undefined}
                  onChange={(event) => setWeightText(event.target.value)}
                />
              ) : null}
              <Input
                id={`set-${set.id}-reps`}
                label={`${setLabel} 횟수, 회`}
                hideLabel
                density="compact"
                unit="회"
                inputMode="numeric"
                placeholder="횟수"
                value={repsText}
                disabled={readOnly || completed}
                invalid={missing === "reps"}
                hint={missing === "reps" ? MISSING_HINT.reps : undefined}
                onChange={(event) => setRepsText(event.target.value)}
              />
            </>
          )}
        </div>
      </div>

      {/*
        2줄: RIR 눈금(한 줄 고정 + 가로 스크롤)과 목표·직전 기록을 같은 줄에 둔다.
        `relative` 는 장식이 아니다 — 눈금의 sr-only 라디오(position:absolute)가 여기를 컨테이닝 블록으로
        삼아야 가로 스크롤 영역 안에서 잘린다. 없으면 화면 밖으로 삐져나가 **문서에 가로 스크롤**이 생긴다.
      */}
      <div className="relative col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-x-clip">
        {badges}
        {asksRir(kind) ? (
          <ScaleGroup
            label={`${setLabel} 남은 반복 수(RIR), 선택 입력`}
            prefix="RIR"
            disabled={completed}
            /* 조작하는 눈금이 읽기용 문구보다 우선이다 — 최소 폭을 먼저 확보하고 문구를 줄인다. */
            className="min-w-[8.5rem] flex-1"
          >
            {RIR_OPTIONS.map((option) => (
              <ScaleOption
                key={option}
                name={`rir-${set.id}`}
                label={`RIR ${option}`}
                checked={rir === option}
                onChange={() => setRir(option)}
              >
                {option}
              </ScaleOption>
            ))}
          </ScaleGroup>
        ) : null}
        {meta ? (
          /* 6rem 아래로는 줄이지 않는다 → 자리가 없으면 사라지지 않고 아랫줄로 접힌다. */
          <span className="min-w-[6rem] flex-1 truncate text-right text-xs text-fg-muted">
            {meta}
          </span>
        ) : null}
      </div>

      <div className="col-start-2 row-span-2 row-start-1">
        <CompleteButton
          completed={completed}
          data-set-check={set.id}
          aria-label={completed ? `${setLabel} 완료 취소` : `${setLabel} 완료 처리`}
          onClick={handleToggle}
        />
      </div>
    </li>
  );
}
