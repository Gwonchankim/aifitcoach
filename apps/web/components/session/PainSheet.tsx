/**
 * 운동별 통증 보고 시트(FEATURES_UX 안전 절, UX_STATES §2.4 "통증 보고").
 *
 * - 0~10 정수 칩만 받는다(자유 입력 없음, §3.3).
 * - `>= 4` 면 안전 안내를 편다: 교체 / 무게 줄이기 / 그냥 계속. **차단하지 않는다.**
 * - 의료 고지는 점수와 무관하게 항상 보인다(AC-S4-5).
 */
"use client";

import { Button, ScaleGroup, ScaleOption, Sheet } from "../ui";
import { MEDICAL_DISCLAIMER, PAIN_ALERT_THRESHOLD } from "./set-rules";
import { useModal } from "./useModal";

const SHEET_ID = "exercise-pain";
const CLOSE_ID = "exercise-pain-close";
const PAIN_SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export type PainSheetProps = {
  open: boolean;
  exerciseName: string;
  score: number | null;
  /** 교체를 막는 사유(기록이 있는 운동 등). null 이면 교체할 수 있다. */
  swapBlockedReason: string | null;
  /** 무게 입력이 있는 종목이고 아직 남은 세트가 있을 때만 [무게 줄이고 계속]을 보여준다. */
  canReduceWeight: boolean;
  onSelect: (score: number | null) => void;
  onSwap: () => void;
  onReduceWeight: () => void;
  onClose: () => void;
};

export function PainSheet({
  open,
  exerciseName,
  score,
  swapBlockedReason,
  canReduceWeight,
  onSelect,
  onSwap,
  onReduceWeight,
  onClose,
}: PainSheetProps) {
  useModal(open, SHEET_ID, onClose, CLOSE_ID);

  const needsGuidance = score != null && score >= PAIN_ALERT_THRESHOLD;

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title={`${exerciseName} 통증 기록`}
      onScrimClick={onClose}
      footer={
        <Button id={CLOSE_ID} variant="secondary" size="lg" fullWidth onClick={onClose}>
          {needsGuidance ? "그냥 계속" : "닫기"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p id={`${SHEET_ID}-question`} className="text-sm font-medium text-fg-muted">
            이 운동에서 통증이 있었나요? 0~10 중에서 골라 주세요. (선택)
          </p>
          {/* 0~10 은 11개라 한 줄에 들어가지 않는다 → 눈금(가로 스크롤)으로 둔다. */}
          <ScaleGroup label={`${exerciseName} 통증 점수, 0~10, 선택 입력`}>
            {PAIN_SCORES.map((value) => (
              <ScaleOption
                key={value}
                name="exercise-pain-score"
                label={`통증 ${value}점`}
                checked={score === value}
                onChange={() => onSelect(value)}
              >
                {value}
              </ScaleOption>
            ))}
          </ScaleGroup>
          {score != null ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => onSelect(null)}
            >
              통증 기록 지우기
            </Button>
          ) : null}
        </div>

        {needsGuidance ? (
          // 통증 안내는 warn 소프트 면이다(Badge warn 과 같은 어법). `bg-surface` + 진한 warn 테두리는
          // 흰 카드 위에서 상태가 아니라 "강조 박스"로 읽힌다. 대비: fg 16.4:1 / fg-muted 5.18:1.
          <div className="flex flex-col gap-3 rounded-control border border-warn-border bg-warn-bg p-3">
            <p className="text-base font-semibold text-fg">⚠ 통증이 느껴지면 무리하지 마세요</p>
            <p className="text-sm text-fg-muted">
              이 운동을 다른 운동으로 바꾸거나 무게를 줄여 보는 걸 권해요.
            </p>

            <Button
              variant="secondary"
              size="md"
              fullWidth
              disabled={swapBlockedReason != null}
              onClick={onSwap}
            >
              운동 교체
            </Button>
            {swapBlockedReason ? (
              <p className="text-sm text-fg-muted">{swapBlockedReason}</p>
            ) : null}

            {canReduceWeight ? (
              <Button variant="secondary" size="md" fullWidth onClick={onReduceWeight}>
                무게 줄이고 계속
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="text-sm text-fg-muted">{MEDICAL_DISCLAIMER}</p>
      </div>
    </Sheet>
  );
}
