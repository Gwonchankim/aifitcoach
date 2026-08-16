"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge, Button, Card, ProgressBar, cn } from "../../components/ui";
import { VolumeCard, e1rmDelta } from "../../components/analytics/AnalyticsCards";
import { fetchAllExercises } from "../../components/session/exercise-catalog";
import { painAreaLabel } from "../../components/onboarding/pain-areas";
import { api, type CompletionAnalytics, type Program } from "../../lib/api";
import {
  completionReadModel,
  dashboardReadModel,
  e1rmReadModel,
  recentAnalyticsWindow,
  volumeReadModel,
} from "../../lib/read-model-data";
import { CURRENT_PROGRAM_ERRORS, isNotFound, toUiError } from "../../lib/error-copy";
import { focusLabel } from "../../lib/program-labels";
import { formatClock, useOnline } from "../../lib/use-online";
import {
  MEDICAL_DISCLAIMER,
  excludedHeading,
  excludedReason,
  whyThisRoutine,
} from "./program-copy";
import {
  completedSessionCount,
  currentLifecycleWeek,
  lifecyclePercent,
  lifecycleTitle,
} from "./program-view";

const DAY_CODE = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const DAY_SHORT: Record<string, string> = {
  MON: "월",
  TUE: "화",
  WED: "수",
  THU: "목",
  FRI: "금",
  SAT: "토",
  SUN: "일",
};
const STATE_COPY: Record<string, { mark: string; label: string; tone: string }> = {
  completed: { mark: "✓", label: "완료", tone: "text-success" },
  partial: { mark: "½", label: "부분", tone: "text-warn-ink" },
  in_progress: { mark: "●", label: "진행", tone: "text-primary" },
  unperformed: { mark: "○", label: "미수행", tone: "text-fg-muted" },
  scheduled: { mark: "○", label: "예정", tone: "text-fg-muted" },
  rest: { mark: "—", label: "휴식", tone: "text-fg-muted" },
  conflict: { mark: "!", label: "충돌", tone: "text-warn-ink" },
  return_after_gap: { mark: "!", label: "복귀", tone: "text-warn-ink" },
};

function LinkAction({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: React.ReactNode;
  secondary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-12 w-full items-center justify-center rounded-control border px-4 text-base font-semibold focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        secondary
          ? "border-border-strong bg-surface text-fg"
          : "border-action bg-action text-action-fg",
      )}
    >
      {children}
    </Link>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 p-4 pb-safe-bottom">
      <header className="border-b border-border pb-3">
        <h1 className="text-[19px] font-extrabold text-fg">주간 프로그램</h1>
      </header>
      {children}
    </div>
  );
}

function plannedExerciseLine(exercise: Program["sessions"][number]["exercises"][number]): string {
  if (exercise.time_low_sec != null)
    return `${exercise.sets}세트 · ${exercise.time_low_sec}–${exercise.time_high_sec ?? exercise.time_low_sec}초`;
  const repetitions =
    exercise.reps_low == null
      ? "반복 미정"
      : `${exercise.reps_low}–${exercise.reps_high ?? exercise.reps_low}회`;
  return `${exercise.sets}세트 · ${repetitions}${exercise.target_rir == null ? "" : ` · RIR ${exercise.target_rir}`}`;
}

function WeekDays({
  completion,
  program,
  names,
}: {
  completion: CompletionAnalytics;
  program?: Program;
  names: Map<string, string>;
}) {
  const week = currentLifecycleWeek(completion);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  if (!week) return null;

  return (
    <Card density="tight" className="overflow-hidden p-0" data-m4-card="program-days">
      {week.days.map((day, index) => {
        const code = DAY_CODE[index];
        const template = program?.sessions.find((session) => session.day === code);
        const copy = STATE_COPY[day.state] ?? STATE_COPY.scheduled;
        const expandable = Boolean(template?.exercises.length);
        const open = expandedDate === day.date;
        const dayTitle = template
          ? (focusLabel(template.focus) ?? "운동")
          : day.focus
            ? (focusLabel(day.focus) ?? "운동")
            : "휴식";
        return (
          <div key={day.date} className="border-t border-border-weak first:border-t-0">
            <button
              type="button"
              disabled={!expandable}
              aria-expanded={expandable ? open : undefined}
              onClick={() => expandable && setExpandedDate(open ? null : day.date)}
              className="flex min-h-12 w-full items-center gap-2 px-3 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus disabled:cursor-default"
            >
              <span className="w-[26px] shrink-0 font-mono text-xs font-bold text-fg">
                {DAY_SHORT[code]}
              </span>
              <span
                aria-hidden="true"
                className={cn("w-3 shrink-0 text-center font-bold", copy.tone)}
              >
                {copy.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-fg">{dayTitle}</span>
                <span className="mt-0.5 block text-xs text-fg-muted">
                  {copy.label}
                  {template ? ` · 운동 ${template.exercises.length}개` : ""}
                </span>
              </span>
              {expandable ? (
                <span aria-hidden="true" className="font-mono text-xs text-fg-muted">
                  {open ? "⌃" : "⌄"}
                </span>
              ) : null}
            </button>
            {open && template ? (
              <div className="flex flex-col gap-1 px-3 pb-3 pl-[55px]">
                {template.exercises.map((exercise) => (
                  <div
                    key={exercise.exercise_id}
                    className="flex items-center justify-between gap-2 border-t border-dotted border-border-weak py-[7px]"
                  >
                    <span className="text-sm text-fg">
                      {names.get(exercise.exercise_id) ?? "운동"}
                    </span>
                    <span className="text-right font-mono text-xs text-fg-muted">
                      {plannedExerciseLine(exercise)}
                    </span>
                  </div>
                ))}
                {day.session_id ? (
                  <Link
                    className="flex min-h-tap items-center justify-end text-xs font-semibold text-primary underline"
                    href={`/session/${day.session_id}`}
                  >
                    세션 상세 ›
                  </Link>
                ) : (
                  <p className="py-2 text-right text-xs text-fg-muted">
                    예정 · 세션은 가까운 주차에 생성돼요.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </Card>
  );
}

export function ProgramScreen() {
  const online = useOnline();
  const program = useQuery({
    queryKey: ["program", "current"],
    queryFn: api.currentProgram,
    retry: false,
  });
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => dashboardReadModel(),
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ["exercises", "catalog"],
    queryFn: fetchAllExercises,
    retry: false,
  });
  const currentCompletion = useQuery({
    queryKey: ["analytics", "completion", "current"],
    queryFn: () => completionReadModel(),
    retry: false,
  });
  const lifecycleCompletion = useQuery({
    queryKey: ["analytics", "completion", program.data?.started_at, program.data?.total_weeks],
    queryFn: () =>
      completionReadModel({
        week_start: program.data!.started_at,
        weeks: program.data!.total_weeks,
      }),
    enabled: program.data != null,
    retry: false,
  });
  const volumeWindow = dashboard.data
    ? recentAnalyticsWindow(dashboard.data.data.date, 1).weekly
    : null;
  const volume = useQuery({
    queryKey: ["analytics", "volume", volumeWindow],
    queryFn: () => volumeReadModel(volumeWindow ?? {}),
    enabled: volumeWindow !== null,
    retry: false,
  });
  const primaryExerciseId = dashboard.data?.data.primary_e1rm?.exercise_id;
  const e1rmWindow = dashboard.data
    ? recentAnalyticsWindow(dashboard.data.data.date, 4).e1rm
    : null;
  const primaryTrend = useQuery({
    queryKey: ["analytics", "e1rm", primaryExerciseId, e1rmWindow],
    queryFn: () => e1rmReadModel({ exercise_id: primaryExerciseId!, ...e1rmWindow! }),
    enabled:
      primaryExerciseId != null &&
      dashboard.data?.data.primary_e1rm?.gate_state === "ready" &&
      e1rmWindow != null,
    retry: false,
  });
  const names = useMemo(
    () => new Map((catalog.data ?? []).map((exercise) => [exercise.id, exercise.name_ko])),
    [catalog.data],
  );
  const fetchedCompletion = lifecycleCompletion.data ?? currentCompletion.data;
  const completionEnvelope =
    program.data || program.error instanceof TypeError ? fetchedCompletion : undefined;

  if (!program.data && isNotFound(program.error))
    return (
      <Screen>
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">아직 운동 계획이 없어요.</p>
          <LinkAction href="/onboarding">계획 만들기</LinkAction>
        </Card>
      </Screen>
    );
  if (!program.data && !completionEnvelope && (program.isPending || currentCompletion.isPending))
    return (
      <Screen>
        <div className="h-32 animate-pulse rounded-card bg-raised" />
        <div className="h-40 animate-pulse rounded-card bg-raised" />
      </Screen>
    );
  if (!program.data && !completionEnvelope) {
    const uiError = toUiError(program.error, CURRENT_PROGRAM_ERRORS);
    return (
      <Screen>
        <Card role="alert" className="flex flex-col gap-3 border-danger">
          <p className="text-sm text-ink-2">
            {uiError.kind === "offline"
              ? "인터넷이 연결되면 계획을 보여드릴게요."
              : uiError.message}
          </p>
          <Button size="lg" fullWidth onClick={() => void program.refetch()}>
            다시 시도
          </Button>
        </Card>
      </Screen>
    );
  }

  const excluded = program.data?.excluded_exercises ?? [];
  const reasons = program.data ? whyThisRoutine(program.data) : [];
  const stale = [completionEnvelope, volume.data, dashboard.data].filter((value) => value?.stale);
  const staleAt = stale.length
    ? Math.min(...stale.map((value) => Date.parse(value!.syncedAt)))
    : null;

  return (
    <Screen>
      {staleAt != null || !online ? (
        <p role="status" className="text-xs text-fg-muted">
          오프라인 · 마지막 동기화{" "}
          <span className="font-mono">
            {formatClock(
              staleAt ??
                (completionEnvelope
                  ? Date.parse(completionEnvelope.syncedAt)
                  : program.dataUpdatedAt),
            )}
          </span>{" "}
          기준
        </p>
      ) : null}

      {reasons.length > 0 ? (
        <Card className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-fg">왜 이 루틴인가요</h2>
          {reasons.map((line) => (
            <p key={line} className="text-sm text-ink-2">
              {line}
            </p>
          ))}
        </Card>
      ) : null}

      {completionEnvelope ? (
        <>
          <Card
            className="flex flex-col gap-2.5 border-[1.5px] border-border-strong p-[13px]"
            data-m4-card="program-progress"
          >
            <p className="text-sm font-semibold text-fg-muted">프로그램 진행</p>
            <h2 className="text-base font-extrabold text-fg">
              {lifecycleTitle(program.data, completionEnvelope.data)}
            </h2>
            <ProgressBar
              value={lifecyclePercent(completionEnvelope.data)}
              label={`프로그램 ${lifecyclePercent(completionEnvelope.data)}% 진행`}
              className="h-1.5 rounded-[1px] bg-border-weak [&>div]:rounded-[1px]"
            />
            <p className="text-sm text-ink-2">
              {completionEnvelope.data.current_week}주간{" "}
              {completedSessionCount(completionEnvelope.data)}
              세션 완료
              {e1rmDelta(primaryTrend.data?.data) != null && primaryExerciseId
                ? ` · ${names.get(primaryExerciseId) ?? "주요 종목"} ${e1rmDelta(primaryTrend.data?.data)! > 0 ? "+" : ""}${e1rmDelta(primaryTrend.data?.data)}kg`
                : ""}
            </p>
          </Card>

          {volume.data ? <VolumeCard analytics={volume.data.data} title="이번 주 볼륨" /> : null}

          <section className="flex flex-col gap-2" aria-labelledby="this-week">
            <h2 id="this-week" className="text-lg font-semibold text-fg">
              이번 주
            </h2>
            <WeekDays completion={completionEnvelope.data} program={program.data} names={names} />
          </section>

          {completionEnvelope.data.weeks.length > 1 ? (
            <section className="flex flex-col gap-2" aria-labelledby="future-weeks">
              <h2 id="future-weeks" className="text-lg font-semibold text-fg">
                이후 주차
              </h2>
              <Card density="tight">
                <ul className="grid grid-cols-2 gap-x-3">
                  {completionEnvelope.data.weeks
                    .filter((week) => week.week_number > completionEnvelope.data.current_week)
                    .map((week) => (
                      <li
                        key={`${week.week_start}-${week.week_number}`}
                        className="flex min-h-tap items-center justify-between border-t border-border-weak text-sm first:border-t-0 even:border-t-0"
                      >
                        <span className="font-semibold text-fg">{week.week_number}주차</span>
                        <span className="text-xs text-fg-muted">예정</span>
                      </li>
                    ))}
                </ul>
              </Card>
            </section>
          ) : null}

          {program.data?.status === "completed" ? (
            <Card className="flex flex-col gap-3 border-[1.5px] border-border-strong">
              <p className="text-sm text-fg-muted">12주 완료</p>
              <h2 className="text-[19px] font-extrabold text-fg">프로그램을 마쳤습니다</h2>
              <div className="grid grid-cols-1 gap-2">
                <LinkAction href="/onboarding">같은 목표로 계속</LinkAction>
                <LinkAction href="/onboarding" secondary>
                  목표 바꾸기
                </LinkAction>
              </div>
            </Card>
          ) : null}
        </>
      ) : lifecycleCompletion.isError && currentCompletion.isError ? (
        <Card role="alert" className="flex flex-col gap-3 border-danger">
          <p className="text-sm text-ink-2">주간 진행을 불러오지 못했어요.</p>
          <Button
            size="lg"
            fullWidth
            onClick={() =>
              void Promise.all([currentCompletion.refetch(), lifecycleCompletion.refetch()])
            }
          >
            다시 시도
          </Button>
        </Card>
      ) : (
        <div className="h-48 animate-pulse rounded-card bg-raised" />
      )}

      {program.data ? (
        <section className="flex flex-col gap-2" aria-labelledby="program-excluded-heading">
          <h2 id="program-excluded-heading" className="text-lg font-semibold text-fg">
            {excludedHeading(excluded.length)}
          </h2>
          <Card density="tight" className="flex flex-col gap-2">
            {excluded.length === 0 ? (
              <p className="text-sm text-ink-2">제외한 운동이 없어요.</p>
            ) : (
              excluded.map((item) => (
                <div key={item.exercise_id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg">
                      {names.get(item.exercise_id) ?? "운동"}
                    </span>
                    <Badge tone="warn">{painAreaLabel(item.pain_area) ?? "통증"} 통증</Badge>
                  </div>
                  <p className="text-sm text-ink-2">{excludedReason(item.pain_area)}</p>
                </div>
              ))
            )}
            <p className="text-xs text-fg-muted">
              {excluded.length === 0
                ? MEDICAL_DISCLAIMER
                : "통증 기록에 따른 읽기 전용 안전 정보예요."}
            </p>
          </Card>
        </section>
      ) : null}
    </Screen>
  );
}
