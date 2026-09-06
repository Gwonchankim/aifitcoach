/**
 * 세트 1행(F1 / F1-0): **최대 2줄**이다.
 *   주(1줄)  = 무게 · 횟수 · RIR · 완료 체크
 *   보조(2줄) = 목표 · 목표 RIR · 직전 기록 (작게, 한 줄로 줄여서)
 *
 * 입력 문자열은 행 로컬 상태로 두고, **완료 체크 시점에** 기록값으로 확정해 스토어에 넣는다
 * (F7: 완료 체크된 세트만 기록한다).
 *
 * 밀도 규칙(F1-0):
 *  - "무게 미정"·"자체중량" 배지는 **세트마다 반복하지 않는다** — 운동 카드 상단에 한 번만 둔다.
 *  - 직전 기록은 전용 줄을 만들지 않고 보조 줄에 얹는다.
 *  - 완료한 세트는 **한 줄로 축약**하고(§2.4.3), 그 줄 자체가 디스클로저 버튼이다 —
 *    탭하면 **완료를 유지한 채** 펼쳐져 값을 고친다. 값만 고칠 때는 휴식 타이머를 열지 않는다.
 */
"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { PlannedSet } from "../../lib/api";
import { Badge, CompleteButton, Input, cn } from "../ui";
import { RirField } from "./RirField";
import {
  asksRir,
  formatKg,
  hasWeightInput,
  missingField,
  nonNegativeWeight,
  resolveValues,
  setPrefill,
  targetLabel,
  weightAxisLabel,
  type SetKind,
  type SetValues,
} from "./set-rules";
import type { SetDraft } from "./session-store";

const MISSING_HINT: Record<"weight" | "reps" | "time", string> = {
  weight: "무게를 입력해 주세요.",
  reps: "횟수를 입력해 주세요.",
  time: "유지 시간을 입력해 주세요.",
};

/**
 * 완료 행의 되돌리기 버튼은 `size="md"`(48px)다 — 72px 이 들어가면 한 줄(≤64px)이 도로 88px 이 된다.
 * 되돌리기는 "완료 체크"(72px, §8 엄지 반경)와 달리 자주 누르는 동작이 아니고,
 * 48px 은 §7.6 의 완료 체크 하한을 그대로 지킨다.
 */

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

/**
 * 무게 미정 세트는 앞 세트 무게를 **건드리기 전까지만** 이어받는다.
 *
 * 직접 편집한 뒤 빈 문자열이 된 상태를 다시 fallback 으로 해석하면 `30 → 3 → ""` 삭제의
 * 마지막 단계에서 30이 되살아난다. 모바일에서는 controlled value 재적용 때문에 캐럿이 튄 것처럼
 * 보인다. `edited`는 빈 값도 사용자의 최신 의도임을 구분한다.
 */
export function shownWeightText(
  weightText: string,
  kind: SetKind,
  fallbackWeight: number | null,
  edited: boolean,
): string {
  return weightText !== "" || edited || kind !== "unknown_weight" || fallbackWeight == null
    ? weightText
    : String(fallbackWeight);
}

/** 한글·단위는 본문 글꼴로 두고 기록의 숫자 조각만 모노로 렌더한다. */
function recordContent(draft: SetDraft): ReactNode | null {
  const number = (value: string | number) => (
    <span className="font-mono tabular-nums">{value}</span>
  );

  if (draft.actual_time_sec != null) return <>{number(draft.actual_time_sec)}초</>;
  if (draft.actual_reps == null) return null;
  return (
    <>
      {draft.actual_weight != null ? (
        <>{number(formatKg(draft.actual_weight).replace("kg", ""))}kg × </>
      ) : null}
      {number(draft.actual_reps)}회
      {draft.actual_rir != null ? <> · RIR {number(draft.actual_rir)}</> : null}
    </>
  );
}

function previousContent(draft: SetDraft): ReactNode | null {
  const recorded = recordContent(draft);
  return recorded ? <>직전 {recorded}</> : null;
}

/** 기록값 한 줄("62.5kg × 9회", "45초"). 기록이 없으면 null. */
function recordLabel(draft: SetDraft): string | null {
  if (draft.actual_time_sec != null) return `${draft.actual_time_sec}초`;
  if (draft.actual_reps == null) return null;
  const weight = draft.actual_weight != null ? `${formatKg(draft.actual_weight)} × ` : "";
  const rir = draft.actual_rir != null ? ` · RIR ${draft.actual_rir}` : "";
  return `${weight}${draft.actual_reps}회${rir}`;
}

/**
 * 축약 행의 접근 이름(AC-SET-6). 스크린리더는 화면 글자가 아니라 이 문장을 읽으므로
 * **기록값 전부**(무게·횟수 또는 시간·RIR·완료)가 들어가야 한다. `kg` 는 "킬로그램"으로 편다.
 */
function collapsedLabel(setLabel: string, draft: SetDraft | undefined): string {
  const spoken = draft ? spokenRecord(draft) : null;
  const record = spoken ? `기록, ${spoken},` : "기록 없음,";
  return `${setLabel} ${record} 완료. 수정하려면 누르세요`;
}

function spokenRecord(draft: SetDraft): string | null {
  if (draft.actual_time_sec != null) return `${draft.actual_time_sec}초`;
  if (draft.actual_reps == null) return null;
  const weight =
    draft.actual_weight != null
      ? `${formatKg(draft.actual_weight).replace("kg", "킬로그램")} `
      : "";
  const rir = draft.actual_rir != null ? `, RIR ${draft.actual_rir}` : "";
  return `${weight}${draft.actual_reps}회${rir}`;
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
  /** 완료 행이 펼쳐져 있는지(F6-1 값 수정). 한 번에 하나만 펼친다 — 상태는 부모가 갖는다(AC-SET-8). */
  expanded: boolean;
  active?: boolean;
  focusOnExpand?: boolean;
  onActivate?: () => void;
  onToggleExpand: () => void;
  onComplete: (values: SetValues) => void;
  /** 펼친 완료 행에서 값을 고칠 때. 완료 상태·휴식 타이머를 건드리지 않는다(§2.4.3). */
  onEdit: (values: SetValues) => void;
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
  expanded,
  active = false,
  focusOnExpand = true,
  onActivate,
  onToggleExpand,
  onComplete,
  onEdit,
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
  // A delayed mirror/pull update must not replace a value the user has typed but
  // not yet committed with the completion check. Focus alone is insufficient on
  // mobile engines because native input helpers may blur between input events.
  const hasUncommittedInput = useRef(false);
  // 빈 문자열도 직접 편집 결과일 수 있다. fallback 재적용과 구분해야 마지막 자리까지 지울 수 있다.
  const weightEdited = useRef(false);

  // Pull may create or replace a draft after this row mounted. Keep the controlled inputs in sync
  // without remounting the row (a remount would steal focus while the user edits a completed set).
  // An active field is newer unsaved UI intent: an overlapping local acknowledgement or remote pull
  // must not replace text the user is currently typing. Its completion write will enter the outbox.
  useEffect(() => {
    if (!draft) return;
    if (hasUncommittedInput.current && !draft.completed) return;
    if (
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLInputElement &&
      document.activeElement.id.startsWith(`set-${set.id}-`)
    )
      return;
    setWeightText(
      draft.actual_weight != null
        ? String(draft.actual_weight)
        : kind === "weighted" && set.recommended_weight != null
          ? String(set.recommended_weight)
          : "",
    );
    setRepsText(
      draft.actual_reps != null
        ? String(draft.actual_reps)
        : set.recommended_reps != null
          ? String(set.recommended_reps)
          : "",
    );
    setTimeText(
      draft.actual_time_sec != null
        ? String(draft.actual_time_sec)
        : set.target_time_low_sec != null
          ? String(set.target_time_low_sec)
          : "",
    );
    setRir(draft.actual_rir ?? null);
  }, [draft, kind, set.id, set.recommended_reps, set.recommended_weight, set.target_time_low_sec]);

  const completed = draft?.completed === true;
  /** 완료 상태를 유지한 채 값을 고치는 중(F6-1 / AC-SET-7). */
  const editing = completed && expanded;
  const setLabel = `${exerciseName} ${set.set_no}세트`;
  const errorId = `set-${set.id}-error`;
  const rirTargetId = `set-${set.id}-rir-target`;

  // 펼치면 바로 고칠 수 있게 첫 입력칸으로 포커스를 옮긴다(탭한 이유가 수정이다).
  const primaryId = primaryInputId(set, kind);
  useEffect(() => {
    if (!editing || !focusOnExpand) return;
    document.getElementById(primaryId)?.focus();
  }, [editing, primaryId, focusOnExpand]);

  const positionAttributes = {
    id: `session-set-${set.id}`,
    "data-planned-set-id": set.id,
    "data-exercise-id": set.exercise_id,
    "data-session-current": String(active),
    "data-expanded": String(editing),
    onFocusCapture: readOnly ? undefined : onActivate,
    onChangeCapture: readOnly ? undefined : onActivate,
  };

  // 무게 미정 세트는 프리필이 없다. 대신 같은 운동의 앞 세트 값을 이어 쓴다(§5.2).
  const shownWeight = shownWeightText(weightText, kind, fallbackWeight, weightEdited.current);

  const valuesFrom = (
    weight: string,
    reps: string,
    time: string,
    rirValue: number | null,
  ): SetValues => ({
    weight: hasWeightInput(kind) ? nonNegativeWeight(parseNumber(weight)) : null,
    reps: kind === "time" ? null : parseNumber(reps),
    rir: asksRir(kind) ? rirValue : null,
    timeSec: kind === "time" ? parseNumber(time) : null,
  });

  const values = valuesFrom(shownWeight, repsText, timeText, rir);

  /** 펼친 완료 행에서는 입력이 바뀔 때마다 기록이 즉시 갱신된다(다시 체크할 필요가 없다). */
  const commit = (next: SetValues) => {
    if (editing) onEdit(next);
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

  /*
    세트 번호는 행마다 같은 자리에 서는 **열**이라 모노 + tabular-nums 다(DESIGN_TOKENS §4) —
    9 → 10 으로 자릿수가 늘어도 오른쪽 입력칸이 밀리지 않는다.
    완료 행에서는 색을 `done-fg`(보조 글자)로 낮춘다 — 최강조로 남길 것은 기록값뿐이다(ADR-41).
  */
  const setNo = (tone: string) => (
    <span className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", tone)}>
      {set.set_no}
      <span className="sr-only">세트</span>
    </span>
  );

  /*
    보조 줄. 목표·목표 RIR·직전 기록을 **한 줄**에 모으고 넘치면 줄인다(truncate).
    줄바꿈(flex-wrap)을 쓰지 않는다 — 390px 에서 한 요소만 넘쳐도 줄이 하나 더 생기고,
    15세트면 그것만으로 300px 가 늘어난다.

    "RIR 목표 n" 만 span 으로 따로 감싼다 — 입력칸 오른쪽에 나란히 둘 폭이 없어(§2.4.1 폭 예산)
    여기 두는 대신 `aria-describedby` 로 RIR 칸에 연결하기 때문이다(AC-RIR-4).
  */
  const showRirTarget = asksRir(kind) && set.target_rir != null;
  const meta: ReactNode[] = [
    targetLabel(kind, set),
    showRirTarget ? (
      <span key="rir-target" id={rirTargetId}>{`RIR 목표 ${set.target_rir}`}</span>
    ) : null,
    previous ? previousContent(previous) : null,
  ].filter(Boolean);

  /*
    완료된 세션(AC-S4-3): 입력·체크 UI 를 **DOM 에 두지 않는다**(disabled 로 남기면
    "아직 시작 안 한 운동"처럼 보인다). 대신 기록 요약행이나 종료 상태를 글로 남긴다.
    기록은 이 세션 화면의 로컬 상태에서만 온다(서버 수행 기록 조회 경로는 계약에 없다).
  */
  if (readOnly) {
    const recorded = draft ? recordLabel(draft) : null;
    return (
      <li
        {...positionAttributes}
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-control border p-3",
          // 읽기 전용 화면에서도 완료 구분은 완료 전용 토큰으로 한다(ADR-41: opacity 금지).
          completed ? "border-done-border bg-done" : "border-border bg-bg",
        )}
      >
        <span className="shrink-0 text-sm font-semibold text-fg">
          {/* "세트"는 한글이라 모노를 씌우지 않는다(JetBrains Mono 에 한글 글리프가 없다, §4). */}
          <span className="font-mono tabular-nums">{set.set_no}</span>세트
        </span>
        {completed ? (
          <Badge tone="success" density="compact" className="shrink-0">
            ✓ 완료
          </Badge>
        ) : null}
        {/* 기록값 본문은 흐리지 않는다(ADR-41). 기록이 없을 때의 안내 문구만 보조색이다. */}
        <span className={cn("min-w-0 text-sm", recorded ? "text-fg" : "text-fg-muted")}>
          {draft && recorded ? (
            <>기록 {recordContent(draft)}</>
          ) : (
            "종료한 운동이라 입력할 수 없어요."
          )}
        </span>
      </li>
    );
  }

  /*
    완료 행(F1-0 "완료된 세트는 축약"): 한 줄이다.
    입력칸을 disabled 로 남기지 않고 **텍스트로** 보여준다 — 비활성 입력칸은 대비가 떨어져
    "기록"을 읽기 나쁘다. 흐리게(opacity) 하지 않고 완료 배경(bg-done)으로 구분한다.
    요약 텍스트 전체가 디스클로저 버튼이라 탭 한 번으로 펼쳐 고칠 수 있고(F6-1),
    오른쪽 완료 체크는 그대로 되돌리기(완료 취소)다.
  */
  if (completed && !expanded) {
    return (
      <li
        {...positionAttributes}
        className={cn(
          // p-1.5: 48px 버튼 + 여백 12 + 테두리 2 = 62px → 완료 행 한 줄(≤64px) 기준을 지킨다.
          "flex items-center gap-2 rounded-control border p-1.5",
          "border-done-border bg-done",
        )}
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label={collapsedLabel(setLabel, draft)}
          onClick={onToggleExpand}
          className={cn(
            "flex min-h-tap min-w-0 flex-1 items-center gap-2 rounded-control px-1 text-left",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          )}
        >
          {setNo("text-done-fg")}
          <Badge tone="success" density="compact" className="shrink-0">
            ✓ 완료
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
            {(draft ? recordContent(draft) : null) ?? "기록 없음"}
          </span>
        </button>
        <CompleteButton
          completed
          size="md"
          data-set-check={set.id}
          aria-label={`${setLabel} 완료 취소`}
          onClick={handleToggle}
        />
      </li>
    );
  }

  /*
    2줄·5열 고정 그리드: 세트(16) · 입력(1fr) · 입력(1fr) · RIR(46) · 완료(48).
    맨몸은 횟수가 두 입력 열을, 시간 종목은 시간 입력이 세 입력 열을 차지한다.
    DOM 순서는 무게 → 횟수 → RIR → 완료 체크 그대로 둔다(§7.1 탭 순서·AC-A-1).
  */
  return (
    <li
      {...positionAttributes}
      className={cn(
        "grid grid-cols-[16px_minmax(0,1fr)_minmax(0,1fr)_46px_48px] items-center gap-x-1.5 gap-y-1",
        "rounded-control border border-border bg-bg p-2",
      )}
    >
      <div className="col-start-1 row-start-1 flex min-w-0 items-center justify-center">
        {/* 펼친 완료 행에서는 세트 번호 자리가 접기 버튼이 된다(펼친 행은 한 번에 하나뿐이다). */}
        {editing ? (
          <button
            type="button"
            aria-expanded
            aria-label={`${setLabel} 기록 접기`}
            onClick={onToggleExpand}
            className={cn(
              "flex min-h-tap w-4 shrink-0 items-center justify-center rounded-control",
              "font-mono text-sm font-semibold tabular-nums text-fg",
              "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            )}
          >
            {set.set_no}
          </button>
        ) : (
          setNo("text-fg")
        )}
      </div>

      {kind === "time" ? (
        <div className="col-span-3 col-start-2 row-start-1 min-w-0">
          <Input
            id={`set-${set.id}-time`}
            label={`${setLabel} 유지 시간, 초`}
            hideLabel
            density="compact"
            unit="초"
            inputMode="numeric"
            placeholder="시간"
            value={timeText}
            invalid={missing === "time"}
            aria-describedby={missing === "time" ? errorId : undefined}
            onChange={(event) => {
              hasUncommittedInput.current = true;
              setTimeText(event.target.value);
              commit(valuesFrom(shownWeight, repsText, event.target.value, rir));
            }}
          />
        </div>
      ) : (
        <>
          {hasWeightInput(kind) ? (
            <div className="col-start-2 row-start-1 min-w-0">
              <Input
                id={`set-${set.id}-weight`}
                label={`${setLabel} ${weightAxisLabel(set)}, 킬로그램`}
                hideLabel
                density="compact"
                type="text"
                inputMode="decimal"
                placeholder={weightAxisLabel(set)}
                value={shownWeight}
                invalid={missing === "weight"}
                aria-describedby={missing === "weight" ? errorId : undefined}
                onChange={(event) => {
                  hasUncommittedInput.current = true;
                  weightEdited.current = true;
                  setWeightText(event.target.value);
                  commit(valuesFrom(event.target.value, repsText, timeText, rir));
                }}
              />
            </div>
          ) : null}
          <div
            className={cn(
              "row-start-1 min-w-0",
              hasWeightInput(kind) ? "col-start-3" : "col-span-2 col-start-2",
            )}
          >
            <Input
              id={`set-${set.id}-reps`}
              label={`${setLabel} 횟수, 회`}
              hideLabel
              density="compact"
              inputMode="numeric"
              placeholder="횟수"
              value={repsText}
              invalid={missing === "reps"}
              aria-describedby={missing === "reps" ? errorId : undefined}
              onChange={(event) => {
                hasUncommittedInput.current = true;
                setRepsText(event.target.value);
                commit(valuesFrom(shownWeight, event.target.value, timeText, rir));
              }}
            />
          </div>
          {asksRir(kind) ? (
            <div className="col-start-4 row-start-1 min-w-0">
              <RirField
                id={`set-${set.id}-rir`}
                setLabel={setLabel}
                value={rir}
                targetRir={set.target_rir}
                // 오류 문구가 보조 줄을 차지하는 동안에는 목표 문구가 DOM 에 없다(빈 id 참조 금지).
                describedById={showRirTarget && !missing ? rirTargetId : undefined}
                onChange={(next) => {
                  hasUncommittedInput.current = true;
                  setRir(next);
                  commit(valuesFrom(shownWeight, repsText, timeText, next));
                }}
              />
            </div>
          ) : null}
        </>
      )}

      {/* 보조 줄. 오류가 나면 그 자리에 사유를 넣는다(입력칸 아래에 붙이면 행이 3줄이 된다). */}
      <div className="col-span-3 col-start-2 row-start-2 min-w-0">
        {missing ? (
          <p id={errorId} className="truncate text-xs text-danger">
            {MISSING_HINT[missing]}
          </p>
        ) : meta.length > 0 ? (
          <p className="truncate text-xs text-fg-muted">
            {meta.map((part, index) => (
              <Fragment key={index}>
                {index > 0 ? " · " : null}
                {part}
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>

      <div className="col-start-5 row-span-2 row-start-1">
        <CompleteButton
          completed={completed}
          size="md"
          data-set-check={set.id}
          aria-label={`${setLabel} 완료 ${completed ? "취소" : "처리"}`}
          onClick={handleToggle}
        />
      </div>
    </li>
  );
}
