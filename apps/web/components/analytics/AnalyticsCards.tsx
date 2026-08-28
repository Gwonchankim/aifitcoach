"use client";

import { useState } from "react";
import Link from "next/link";
import type { DashboardSummary, E1rmAnalytics, VolumeAnalytics } from "../../lib/api";
import { focusLabel, formatNumber } from "../../lib/program-labels";
import { Card, cn, selectionStateClass } from "../ui";

type RhythmDay = DashboardSummary["weekly_rhythm"][number];

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const RHYTHM_COPY: Record<
  RhythmDay["state"],
  { mark: string; label: string; tone: "success" | "warn" | "primary" | "muted" }
> = {
  completed: { mark: "✓", label: "완료", tone: "success" },
  partial: { mark: "½", label: "부분", tone: "warn" },
  in_progress: { mark: "●", label: "진행", tone: "primary" },
  unperformed: { mark: "○", label: "미수행", tone: "muted" },
  scheduled: { mark: "○", label: "예정", tone: "muted" },
  rest: { mark: "—", label: "휴식", tone: "muted" },
  conflict: { mark: "!", label: "충돌", tone: "warn" },
  return_after_gap: { mark: "!", label: "복귀", tone: "warn" },
};

const RHYTHM_TONE = {
  success: "text-success",
  warn: "text-warn-ink",
  primary: "text-primary",
  muted: "text-fg-muted",
} as const;

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function shortDate(value: string): string {
  const date = parseDate(value);
  return `${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

export function dashboardDate(value: string): string {
  const date = parseDate(value);
  return `${date.getUTCMonth() + 1}.${String(date.getUTCDate()).padStart(2, "0")} ${DAY_LABELS[date.getUTCDay()]}`;
}

export function WeeklyRhythmCard({ days }: { days: RhythmDay[] }) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selected = days.find((day) => day.date === selectedDate) ?? null;

  return (
    <Card density="tight" className="flex flex-col gap-2.5 px-[11px]" data-m4-card="rhythm">
      <div className="flex items-baseline justify-between px-0.5">
        <h2 className="text-sm font-semibold text-fg-muted">이번 주 리듬</h2>
        <span className="font-mono text-kicker text-fg-muted">월–일</span>
      </div>
      <div className="grid grid-cols-7 gap-1" data-m4-grid="rhythm">
        {days.map((day) => {
          const copy = RHYTHM_COPY[day.state];
          const date = parseDate(day.date);
          const selectedDay = day.date === selectedDate;
          return (
            <button
              key={day.date}
              type="button"
              aria-pressed={selectedDay}
              aria-label={`${shortDate(day.date)} ${copy.label}`}
              className={cn(
                "flex min-h-tap min-w-0 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-control border",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
                selectionStateClass(selectedDay),
              )}
              onClick={() => setSelectedDate(selectedDay ? null : day.date)}
            >
              <span className="font-mono text-kicker text-fg-muted">
                {DAY_LABELS[date.getUTCDay()]}
              </span>
              <span aria-hidden="true" className={cn("text-xs font-bold", RHYTHM_TONE[copy.tone])}>
                {copy.mark}
              </span>
              <span className={cn("text-[8.5px] font-bold leading-none", RHYTHM_TONE[copy.tone])}>
                {copy.label}
              </span>
            </button>
          );
        })}
      </div>
      {selected ? (
        <div className="border-t border-border-weak pt-2.5 text-xs text-ink-2">
          <span className="font-semibold text-fg">{shortDate(selected.date)}</span>
          {` · ${RHYTHM_COPY[selected.state].label}`}
          {selected.focus ? ` · ${focusLabel(selected.focus) ?? "운동"}` : ""}
          {selected.session_id ? (
            <Link
              className="ml-2 font-semibold text-primary underline"
              href={`/session/${selected.session_id}`}
            >
              상세 보기
            </Link>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

const MUSCLE_GROUPS: { label: string; keys: string[] }[] = [
  { label: "가슴", keys: ["chest"] },
  { label: "등", keys: ["lats", "upper_back", "back"] },
  { label: "어깨", keys: ["front_delts", "side_delts", "rear_delts", "shoulders"] },
  { label: "하체", keys: ["quads", "hamstrings", "glutes", "calves", "adductors"] },
  { label: "팔", keys: ["biceps", "triceps", "forearms"] },
];

export type VolumeRow = {
  label: string;
  hardSets: number;
  status: "below" | "within" | "above" | "not_applicable";
};

export function volumeRows(analytics: VolumeAnalytics): VolumeRow[] {
  const muscles = analytics.weeks.at(-1)?.muscles ?? [];
  return MUSCLE_GROUPS.map((group) => {
    const rows = muscles.filter((row) => group.keys.includes(row.muscle));
    const hardSets = rows.reduce((sum, row) => sum + row.hard_sets, 0);
    const statuses = new Set(rows.map((row) => row.range_status));
    const status = statuses.has("above")
      ? "above"
      : statuses.has("below")
        ? "below"
        : statuses.has("within")
          ? "within"
          : "not_applicable";
    return { label: group.label, hardSets, status };
  });
}

export function VolumeCard({
  analytics,
  title = "주간 볼륨",
}: {
  analytics: VolumeAnalytics;
  title?: string;
}) {
  const rows = volumeRows(analytics);
  const range = analytics.recommendation_range;
  const scaleMax = Math.max(range?.max_hard_sets ?? 0, ...rows.map((row) => row.hardSets), 1);
  const warningRows = rows.filter((row) => row.status === "below" || row.status === "above");

  return (
    <Card density="tight" className="flex flex-col gap-2.5" data-m4-card="volume">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg-muted">{title}</h2>
        {range ? (
          <span className="font-mono text-kicker text-fg-muted">
            권장 {range.min_hard_sets}–{range.max_hard_sets}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-[7px]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[34px_1fr_54px] items-center gap-2"
            data-m4-grid="volume-row"
          >
            <span className="text-xs text-fg-muted">{row.label}</span>
            <span className="relative h-[9px] overflow-hidden rounded-[1px] border border-border bg-raised">
              {range ? (
                <i
                  aria-hidden="true"
                  className="absolute inset-y-0 bg-range-band"
                  style={{
                    left: `${(range.min_hard_sets / scaleMax) * 100}%`,
                    width: `${((range.max_hard_sets - range.min_hard_sets) / scaleMax) * 100}%`,
                  }}
                />
              ) : null}
              <i
                aria-hidden="true"
                className={cn(
                  "absolute inset-y-0 left-0",
                  row.status === "below" || row.status === "above" ? "bg-warn" : "bg-primary",
                )}
                style={{ width: `${Math.min(100, (row.hardSets / scaleMax) * 100)}%` }}
              />
            </span>
            <span
              className={cn(
                "text-right font-mono text-xs font-bold tabular-nums",
                row.status === "below" || row.status === "above" ? "text-warn-ink" : "text-fg",
              )}
            >
              {row.hardSets}세트
            </span>
          </div>
        ))}
      </div>
      {range && warningRows.length > 0 ? (
        <p className="border-t border-border-weak pt-2 text-xs text-ink-2">
          {warningRows.map((row) => row.label).join("·")} 볼륨이 권장 범위를 벗어났어요. 다음
          운동에서 확인해 주세요.
        </p>
      ) : null}
    </Card>
  );
}

export function E1rmSummaryCard({
  summary,
  exerciseName,
  delta,
}: {
  summary: NonNullable<DashboardSummary["primary_e1rm"]> | null;
  exerciseName?: string;
  delta?: number | null;
}) {
  if (!summary || summary.gate_state !== "ready" || summary.latest_e1rm == null) return null;
  return (
    <Card density="tight" className="flex items-center justify-between gap-2" data-m4-card="e1rm">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-fg-muted">
          {exerciseName ?? "주요 종목"} 추정 1RM
        </h2>
        <div className="mt-1 flex items-baseline gap-2">
          <p className="font-mono text-[21px] font-bold tabular-nums text-fg">
            {formatNumber(summary.latest_e1rm)}
            <span className="text-xs text-fg-muted">kg</span>
          </p>
          {delta != null && delta !== 0 ? (
            <span
              className={cn(
                "font-mono text-xs font-bold",
                delta > 0 ? "text-success" : "text-warn-ink",
              )}
            >
              {delta > 0 ? "▲" : "▼"} {formatNumber(Math.abs(delta))}kg · 4주
            </span>
          ) : null}
        </div>
      </div>
      <Link
        href={`/history?exercise=${encodeURIComponent(summary.exercise_id)}`}
        className="flex min-h-tap shrink-0 items-center px-1 font-mono text-xs font-bold text-primary underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus"
      >
        기록 탭 ›
      </Link>
    </Card>
  );
}

/** 서버가 ready로 공개한 point만 사용한다. early/no_history payload에서 값을 복구하지 않는다. */
export function e1rmDelta(analytics: E1rmAnalytics | undefined): number | null {
  if (!analytics || analytics.gate_state !== "ready" || analytics.points.length < 2) return null;
  return Math.round((analytics.points.at(-1)!.e1rm - analytics.points[0].e1rm) * 10) / 10;
}
