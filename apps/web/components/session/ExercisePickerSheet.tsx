/**
 * 운동 추가·교체 팝업(F5): 부위별 탭 + 운동 DB 목록.
 * 교체 후보는 같은 movement_pattern(과 지정 대체 종목)을 앞에 세운다.
 */
"use client";

import Image from "next/image";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { Exercise } from "../../lib/api";
import { Badge, Button, Sheet, Tab, TabList, cn } from "../ui";
import { REGIONS, inRegion, regionOf, sortSwapCandidates, type RegionId } from "./exercise-catalog";
import { useModal } from "./useModal";

const SHEET_ID = "exercise-picker";

export type PickerMode = { type: "add" } | { type: "swap"; exerciseId: string };

export type ExercisePickerSheetProps = {
  open: boolean;
  mode: PickerMode;
  catalog: Exercise[];
  /** 오늘 루틴에 이미 있는 종목(중복 추가 차단, 409 예방). */
  inRoutine: Set<string>;
  pending: boolean;
  errorText: string | null;
  onSelect: (exerciseId: string) => void;
  onClose: () => void;
};

export function ExercisePickerSheet({
  open,
  mode,
  catalog,
  inRoutine,
  pending,
  errorText,
  onSelect,
  onClose,
}: ExercisePickerSheetProps) {
  const from =
    mode.type === "swap" ? (catalog.find((e) => e.id === mode.exerciseId) ?? null) : null;
  const defaultRegion = (from ? regionOf(from) : null) ?? "chest";
  const [region, setRegion] = useState<RegionId>(defaultRegion);

  useModal(open, SHEET_ID, onClose, `picker-tab-${defaultRegion}`);

  // 다른 운동을 교체하려고 다시 열면 그 운동의 부위부터 보여준다.
  useEffect(() => {
    if (open) setRegion(defaultRegion);
  }, [open, defaultRegion]);

  const items = useMemo(() => {
    const filtered = catalog.filter(
      (exercise) => inRegion(exercise, region) && exercise.id !== from?.id,
    );
    return sortSwapCandidates(filtered, from);
  }, [catalog, region, from]);

  // 부위 탭은 ←/→ 로 이동한다(tablist 표준 패턴, §7.5).
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = REGIONS.findIndex((item) => item.id === region);
    const next = REGIONS[(index + delta + REGIONS.length) % REGIONS.length];
    setRegion(next.id);
    window.setTimeout(() => document.getElementById(`picker-tab-${next.id}`)?.focus(), 0);
  };

  return (
    <Sheet
      open={open}
      id={SHEET_ID}
      title={mode.type === "add" ? "운동 추가" : `${from?.name_ko ?? "운동"} 교체`}
      onScrimClick={onClose}
      footer={
        <Button variant="secondary" size="lg" fullWidth onClick={onClose}>
          닫기
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {errorText ? (
          <p role="alert" className="rounded-control bg-danger px-3 py-2 text-sm text-danger-fg">
            {errorText}
          </p>
        ) : null}

        <TabList label="부위" onKeyDown={onTabKeyDown}>
          {REGIONS.map((item) => (
            <Tab
              key={item.id}
              id={`picker-tab-${item.id}`}
              panelId="picker-panel"
              selected={region === item.id}
              onClick={() => setRegion(item.id)}
            >
              {item.label}
            </Tab>
          ))}
        </TabList>

        <div
          id="picker-panel"
          role="tabpanel"
          aria-labelledby={`picker-tab-${region}`}
          className="max-h-[45dvh] overflow-y-auto"
        >
          {items.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-muted">
              이 부위에서 고를 수 있는 운동이 없어요. 다른 부위를 눌러 보세요.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((exercise) => {
                const already = inRoutine.has(exercise.id);
                return (
                  <li key={exercise.id}>
                    <button
                      type="button"
                      disabled={already || pending}
                      onClick={() => onSelect(exercise.id)}
                      className={cn(
                        "flex min-h-tap-lg w-full items-center gap-3 rounded-control border px-3 py-2 text-left",
                        "border-border-strong bg-surface text-fg",
                        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
                        "disabled:border-transparent disabled:bg-disabled disabled:text-disabled-fg",
                      )}
                    >
                      {exercise.media_url ? (
                        /*
                          media_url 은 운동 DB 가 주는 외부 URL 이라 도메인을 미리 알 수 없다
                          → 최적화 없이(unoptimized) 원본을 그대로 쓴다. 크기는 44px 고정(탭 타깃).
                        */
                        <Image
                          src={exercise.media_url}
                          alt={`${exercise.name_ko} 동작`}
                          width={44}
                          height={44}
                          unoptimized
                          className="size-11 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="size-11 shrink-0 rounded-md border border-border bg-raised"
                        />
                      )}

                      <span className="flex flex-1 flex-col">
                        <span className="text-base font-semibold">{exercise.name_ko}</span>
                        <span className="text-sm text-fg-muted">
                          {EQUIPMENT_LABEL[exercise.equipment] ?? "기타"}
                        </span>
                      </span>

                      {already ? <Badge>이미 루틴에 있어요</Badge> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}

const EQUIPMENT_LABEL: Record<string, string> = {
  barbell: "바벨",
  dumbbell: "덤벨",
  machine: "머신",
  cable: "케이블",
  bodyweight: "맨몸",
  ez_bar: "이지바",
};
