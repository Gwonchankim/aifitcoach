/**
 * 운동 편집 시트(F5 교체·삭제 진입).
 * 삭제는 한 번의 탭으로 실행되지 않게 이 시트 안에만 둔다(AC-H-3).
 */
"use client";

import { Button, Sheet } from "../ui";
import { useModal } from "./useModal";

const SHEET_ID = "exercise-menu";
const CLOSE_ID = "exercise-menu-close";

export type ExerciseMenuSheetProps = {
  open: boolean;
  exerciseName: string;
  pending: boolean;
  errorText: string | null;
  onSwap: () => void;
  onRemove: () => void;
  onClose: () => void;
};

export function ExerciseMenuSheet({
  open,
  exerciseName,
  pending,
  errorText,
  onSwap,
  onRemove,
  onClose,
}: ExerciseMenuSheetProps) {
  useModal(open, SHEET_ID, onClose, CLOSE_ID);

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title={`${exerciseName} 편집`}
      onScrimClick={onClose}
      footer={
        <Button id={CLOSE_ID} variant="secondary" size="lg" fullWidth onClick={onClose}>
          취소
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {errorText ? (
          <p role="alert" className="rounded-control bg-danger px-3 py-2 text-sm text-danger-fg">
            {errorText}
          </p>
        ) : null}

        <Button variant="secondary" size="md" fullWidth disabled={pending} onClick={onSwap}>
          다른 운동으로 교체
        </Button>
        <Button variant="danger" size="md" fullWidth disabled={pending} onClick={onRemove}>
          루틴에서 빼기
        </Button>
      </div>
    </Sheet>
  );
}
