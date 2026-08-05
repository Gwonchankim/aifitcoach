/**
 * 휴식일에도 운동하기(F8-1): 부위를 골라 즉석 세션을 만든다.
 *
 * 앱이 "오늘 뭘 할지"를 대신 정하지 않는다 — 6개 부위 중 하나를 사용자가 고른다.
 * 연속 운동일이 길면 회복을 권하는 안내를 함께 보여주되, **막지 않는다**.
 */
"use client";

import type { BodyPart } from "../../lib/api";
import { Button, Sheet } from "../ui";
import { useModal } from "../session/useModal";
import { BODY_PARTS, RECOVERY_STREAK_DAYS, needsRecoveryNotice } from "./body-parts";

const SHEET_ID = "ad-hoc-body-part";
const CLOSE_ID = "ad-hoc-body-part-close";

/** 단정적 의학 표현을 쓰지 않는다(SAFETY_PAIN_MAPPING 기조). */
const RECOVERY_DISCLAIMER = "일반적인 안내이며 의료적 조언이 아니에요.";

export type BodyPartSheetProps = {
  open: boolean;
  streakDays: number;
  pending: boolean;
  errorText: string | null;
  onSelect: (bodyPart: BodyPart) => void;
  onClose: () => void;
};

export function BodyPartSheet({
  open,
  streakDays,
  pending,
  errorText,
  onSelect,
  onClose,
}: BodyPartSheetProps) {
  useModal(open, SHEET_ID, onClose, CLOSE_ID);

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title="오늘 어디를 할까요?"
      onScrimClick={onClose}
      footer={
        <Button
          id={CLOSE_ID}
          variant="secondary"
          size="lg"
          fullWidth
          disabled={pending}
          onClick={onClose}
        >
          닫기
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {needsRecoveryNotice(streakDays) ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-control border border-warn bg-surface p-3"
          >
            <p className="text-base font-semibold text-fg">{streakDays}일 연속으로 운동했어요</p>
            <p className="text-sm text-fg-muted">
              {RECOVERY_STREAK_DAYS}일 넘게 이어서 하면 회복이 부족해질 수 있어요. 오늘 쉬거나
              가볍게 해 보는 것도 좋아요.
            </p>
            <p className="text-sm text-fg-muted">{RECOVERY_DISCLAIMER}</p>
          </div>
        ) : null}

        <p className="text-sm text-fg-muted">
          고른 부위로 오늘 루틴을 만들어 드려요. 계획에 없던 날이라 운동량이 조금 늘어요.
        </p>

        {errorText ? (
          <p role="alert" className="rounded-control bg-danger px-3 py-2 text-sm text-danger-fg">
            {errorText}
          </p>
        ) : null}

        <ul className="grid grid-cols-3 gap-2">
          {BODY_PARTS.map((part) => (
            <li key={part.id}>
              <Button
                variant="secondary"
                size="md"
                fullWidth
                disabled={pending}
                onClick={() => onSelect(part.id)}
              >
                {part.label}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
