/**
 * RIR 고르기 시트(M-7, UX_STATES §2.4.2).
 *
 * 왜 시트인가: `<datalist>` 는 iOS 에서 **탭으로 목록을 여는 경로가 없고**(키보드 위 제안 줄),
 * 네이티브 `<select>` 는 모바일에서 직접 타이핑을 잃는다 → 둘 다 탈락했다.
 * 입력칸(타이핑) + 셰브론 → 이 시트(고르기)로 F1-1 의 "직접 칠 수도, 목록에서 고를 수도"를 둘 다 만족한다.
 *
 * 값 검증은 여기서 하지 않는다 — 칩이 `모름`과 0~6 뿐이라 범위 밖 값이 애초에 만들어지지 않는다(§3.3).
 */
"use client";

import { Button, Chip, Sheet } from "../ui";
import { RIR_CHOICES, RIR_UNKNOWN_LABEL } from "./rir";
import { useModal } from "./useModal";

const HINT = "세트를 끝냈을 때 몇 회 더 할 수 있었는지예요. 잘 모르겠으면 비워 두세요.";

export type RirSheetProps = {
  open: boolean;
  /** 세트마다 다른 시트 id(`set-{plannedSetId}-rir-sheet`). */
  sheetId: string;
  value: number | null;
  /** 목표 RIR. null 이면 어떤 칩에도 표시하지 않는다. */
  targetRir: number | null;
  onSelect: (value: number | null) => void;
  onClose: () => void;
};

/** 현재 값 칩에 초기 포커스를 준다(M-7). 값이 없으면 `모름`. */
function chipId(sheetId: string, value: number | null): string {
  return `${sheetId}-${value == null ? "unknown" : value}`;
}

export function RirSheet({ open, sheetId, value, targetRir, onSelect, onClose }: RirSheetProps) {
  useModal(open, sheetId, onClose, chipId(sheetId, value));

  const choices: (number | null)[] = [null, ...RIR_CHOICES];

  return (
    <Sheet
      open={open}
      id={sheetId}
      title="RIR 고르기"
      onScrimClick={onClose}
      footer={
        <Button variant="secondary" size="lg" fullWidth onClick={onClose}>
          닫기
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-muted">{HINT}</p>

        <ul className="grid grid-cols-3 gap-2">
          {choices.map((choice) => (
            <li key={choice ?? "unknown"}>
              <Chip
                id={chipId(sheetId, choice)}
                selected={choice === value}
                className="w-full"
                onClick={() => onSelect(choice)}
              >
                {choice == null ? RIR_UNKNOWN_LABEL : String(choice)}
                {/* 보이는 글자와 접근 이름이 같도록 aria-label 대신 텍스트로 표시한다. */}
                {choice != null && choice === targetRir ? (
                  <span className="text-xs font-normal">목표</span>
                ) : null}
              </Chip>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
