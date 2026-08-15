/**
 * RIR 입력(F1-1, 2차 개정): **하나의 필드**다 — 입력칸 + 칸 안쪽 우측의 셰브론.
 *
 * 직접 타이핑(0~6)과 목록 고르기(셰브론 → 하단 시트)를 한 필드에서 다 받는다.
 * `<datalist>` 는 iOS 에서 탭으로 목록을 여는 경로가 없어 **탈락한 안**이다(UX_STATES §2.4.2).
 *
 * 범위(0~6) 거부는 `parseRirText` 가 한다 — 거부된 입력은 값을 바꾸지 않으므로
 * UI 가 7 같은 값을 애초에 만들 수 없다. 미입력("모름")은 칸이 빈 상태이고 끝까지 `null` 이다.
 * 목표 RIR 문구는 폭이 모자라 2줄차에 두고 `aria-describedby` 로 이 칸에 연결한다(SetRow).
 */
"use client";

import { useState, type KeyboardEvent } from "react";
import { ChevronDownIcon, Input } from "../ui";
import { RirSheet } from "./RirSheet";
import { parseRirText, rirText, stepRir } from "./rir";

export type RirFieldProps = {
  /** 입력칸의 id(`set-{plannedSetId}-rir`). 포커스 이동에 쓴다. */
  id: string;
  /** 스크린리더용 세트 이름. 예: "벤치프레스 2세트" */
  setLabel: string;
  value: number | null;
  /** 시트에서 목표 칩에 표시한다. null 이면 표시하지 않는다. */
  targetRir: number | null;
  /** 2줄차의 "RIR 목표 n" 문구 id(AC-RIR-4). 목표가 없거나 가려지면 undefined. */
  describedById: string | undefined;
  disabled?: boolean;
  onChange: (value: number | null) => void;
};

export function RirField({
  id,
  setLabel,
  value,
  targetRir,
  describedById,
  disabled,
  onChange,
}: RirFieldProps) {
  const [open, setOpen] = useState(false);
  const sheetId = `${id}-sheet`;

  /**
   * 시트를 닫으면 `useModal` 이 "열기 직전 포커스"로 되돌린다. 그런데 iOS 는 버튼을 탭해도
   * 포커스를 주지 않아 그 자리가 body 일 수 있다 → 입력칸 복귀를 **명시적으로** 한 번 더 한다.
   */
  const focusInput = () => window.setTimeout(() => document.getElementById(id)?.focus(), 20);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();

    // Alt + ↓ = 시트 열기(키보드 사용자에게는 타이핑이 더 빠르므로 시트는 보조 경로다).
    if (event.altKey) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    const next = stepRir(value, event.key === "ArrowUp" ? 1 : -1);
    if (next !== value) onChange(next);
  };

  /* 46px 그리드 열 안에서 숫자 한 자리와 24px 셰브론 타깃이 함께 맞도록 이 필드만 여백을 줄인다. */
  return (
    <div className="min-w-0 w-full">
      <Input
        id={id}
        label={`${setLabel} 남은 반복 수(RIR), 0~6, 선택 입력`}
        hideLabel
        density="compact"
        type="text"
        inputMode="numeric"
        // 한 자리(0~6)만 받는 칸이라 두 번째 글자를 막고, 포커스 시 전체 선택해서
        // "지우고 다시 치기" 없이 바로 바꿀 수 있게 한다(한 손 조작).
        maxLength={1}
        autoComplete="off"
        placeholder=""
        value={rirText(value)}
        disabled={disabled}
        aria-describedby={describedById}
        className="min-w-0 [&_input]:pl-1.5 [&_input]:pr-6"
        onFocus={(event) => event.target.select()}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          const parsed = parseRirText(event.target.value);
          // 거부된 입력은 값을 바꾸지 않는다 → 범위 밖 값이 만들어지지 않는다.
          if (parsed.accepted) onChange(parsed.value);
        }}
        trailing={
          <button
            type="button"
            // 세트 15개면 Tab 정거장이 15개 늘어난다 → 탭 순서에서 뺀다(AC-RIR-7).
            tabIndex={-1}
            aria-label={`${setLabel} RIR 고르기`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? sheetId : undefined}
            disabled={disabled}
            className="flex h-9 min-w-6 w-6 touch-manipulation items-center justify-center rounded-control text-fg-muted"
            onClick={() => setOpen(true)}
          >
            <ChevronDownIcon className="size-5" />
          </button>
        }
      />

      <RirSheet
        open={open}
        sheetId={sheetId}
        value={value}
        targetRir={targetRir}
        onSelect={(next) => {
          onChange(next);
          setOpen(false);
          focusInput();
        }}
        onClose={() => {
          setOpen(false);
          focusInput();
        }}
      />
    </div>
  );
}
