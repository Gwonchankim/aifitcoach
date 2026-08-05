/**
 * 운동 종료 확인 시트(F6) + 통증 보고(FEATURES_UX 안전 절).
 * 통증 점수는 `POST /sessions/{id}/complete` 의 `pain` 으로 보낸다.
 * F6 에 없는 difficulty/pump 는 묻지 않는다.
 */
"use client";

import { useState } from "react";
import { Button, Chip, Sheet } from "../ui";
import { MEDICAL_DISCLAIMER, PAIN_ALERT_THRESHOLD } from "./set-rules";
import { useModal } from "./useModal";

const SHEET_ID = "finish-session";
const CANCEL_ID = "finish-session-cancel";
const PAIN_SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export type FinishSheetProps = {
  open: boolean;
  /** F6-1 재개/편집 모드 — 이미 종료한 오늘 운동을 고치는 중이다(첫 종료가 아니다). */
  resumed?: boolean;
  completedCount: number;
  remainingCount: number;
  pending: boolean;
  errorText: string | null;
  onConfirm: (pain: number | null) => void;
  onClose: () => void;
};

export function FinishSheet({
  open,
  resumed = false,
  completedCount,
  remainingCount,
  pending,
  errorText,
  onConfirm,
  onClose,
}: FinishSheetProps) {
  const [pain, setPain] = useState<number | null>(null);

  useModal(open, SHEET_ID, onClose, CANCEL_ID);

  const question = resumed
    ? "고친 내용을 오늘 기록에 반영할게요."
    : completedCount === 0
      ? "완료한 세트가 없어요. 종료하면 오늘은 기록이 남지 않아요."
      : remainingCount > 0
        ? `아직 ${remainingCount}개 세트가 남았어요. 지금 종료하면 완료한 ${completedCount}개 세트만 기록돼요.`
        : "오늘 운동을 종료할까요?";

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title={resumed ? "수정 마치기" : "운동 종료"}
      onScrimClick={onClose}
      footer={
        <div className="flex flex-col gap-2">
          <Button size="lg" fullWidth disabled={pending} onClick={() => onConfirm(pain)}>
            {pending
              ? "기록하는 중이에요"
              : resumed
                ? "기록 반영"
                : remainingCount > 0
                  ? "그래도 종료"
                  : "운동 종료"}
          </Button>
          <Button
            id={CANCEL_ID}
            variant="secondary"
            size="md"
            fullWidth
            disabled={pending}
            onClick={onClose}
          >
            계속하기
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-base text-fg">{question}</p>

        {errorText ? (
          <p role="alert" className="rounded-control bg-danger px-3 py-2 text-sm text-danger-fg">
            {errorText}
          </p>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-fg-muted">
            오늘 통증이 있었나요? 0~10 중에서 골라 주세요. (선택)
          </legend>
          <div className="flex flex-wrap gap-2">
            {PAIN_SCORES.map((score) => (
              <Chip
                key={score}
                selected={pain === score}
                aria-label={`통증 ${score}점`}
                className="min-w-tap"
                onClick={() => setPain(pain === score ? null : score)}
              >
                {score}
              </Chip>
            ))}
          </div>
        </fieldset>

        {pain != null && pain >= PAIN_ALERT_THRESHOLD ? (
          <div className="flex flex-col gap-2 rounded-control border border-warn bg-surface p-3">
            <p className="text-base font-semibold text-fg">⚠ 통증이 느껴지면 무리하지 마세요</p>
            <p className="text-sm text-fg-muted">
              이 운동을 다른 운동으로 바꾸거나 무게를 줄여 보는 걸 권해요. 다음 추천에도 반영할게요.
            </p>
            <p className="text-sm text-fg-muted">{MEDICAL_DISCLAIMER}</p>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
