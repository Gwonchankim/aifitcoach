/**
 * 운동 빼기 확인 시트(F5 삭제).
 *
 * 휴지통은 카드에 그대로 노출돼 있으므로(F5 확정 2026-08-05) **한 번의 탭으로 실행되지 않게**
 * 확인을 한 단계 둔다(AC-H-3). 확인은 **최소한**이다 — 문구 한 줄 + 버튼 두 개.
 * 기본 포커스는 [취소]다(오조작 방지, UX_STATES §1.2).
 */
"use client";

import { Button, Sheet } from "../ui";
import { useModal } from "./useModal";

const SHEET_ID = "exercise-remove";
const CANCEL_ID = "exercise-remove-cancel";

export type RemoveExerciseSheetProps = {
  open: boolean;
  exerciseName: string;
  pending: boolean;
  errorText: string | null;
  onRemove: () => void;
  onClose: () => void;
};

export function RemoveExerciseSheet({
  open,
  exerciseName,
  pending,
  errorText,
  onRemove,
  onClose,
}: RemoveExerciseSheetProps) {
  useModal(open, SHEET_ID, onClose, CANCEL_ID);

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title={`${exerciseName} 빼기`}
      onScrimClick={onClose}
      footer={
        <Button id={CANCEL_ID} variant="secondary" size="lg" fullWidth onClick={onClose}>
          취소
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {errorText ? (
          /* 배지와 같은 소프트 어법(면 `*-bg` + 글자 `*` + 1px `*-border`, Badge.tsx). danger 5.61:1. */
          <p
            role="alert"
            className="rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {errorText}
          </p>
        ) : null}

        <p className="text-base text-fg">오늘 루틴에서 이 운동을 뺄까요?</p>
        <Button variant="danger" size="lg" fullWidth disabled={pending} onClick={onRemove}>
          루틴에서 빼기
        </Button>
      </div>
    </Sheet>
  );
}
