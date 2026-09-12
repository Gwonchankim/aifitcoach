"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, cn, selectionStateClass } from "../ui";
import { fetchAllExercises } from "../session/exercise-catalog";
import type { E1rmAnalytics, Exercise, Session } from "../../lib/api";
import { api } from "../../lib/api";
import {
  completionReadModel,
  dashboardReadModel,
  e1rmReadModel,
  historySessionReadModel,
  recentAnalyticsWindow,
} from "../../lib/read-model-data";
import { formatClock, useOnline } from "../../lib/use-online";
import { dayLabel, formatNumber } from "../../lib/program-labels";
import { hasChartGap, historyVisibility, similarExercises } from "./history-view";

function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일`;
}

function completedSessionIds(
  completion: Awaited<ReturnType<typeof completionReadModel>>["data"] | undefined,
): string[] {
  if (!completion) return [];
  return completion.weeks
    .flatMap((week) => week.days)
    .filter((day) => day.session_id && (day.state === "completed" || day.state === "partial"))
    .sort((left, right) => right.date.localeCompare(left.date))
    .map((day) => day.session_id as string)
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, 48);
}

function exerciseIdsByRecentSession(sessions: Session[]): string[] {
  return sessions
    .flatMap((session) => session.planned_sets.map((set) => set.exercise_id))
    .filter((id, index, all) => all.indexOf(id) === index);
}

function ObservationDots({ analytics }: { analytics: E1rmAnalytics }) {
  return (
    <div
      className="flex h-[72px] items-center justify-around border-y border-border-weak"
      role="img"
      aria-label={`${analytics.sample_session_count}회 완료 세션 관측, 추이는 세 세션부터 표시`}
      data-history-visual="observations-only"
    >
      {analytics.observations.map((observation) => (
        <span key={observation.session_id} className="flex flex-col items-center gap-2">
          <i aria-hidden="true" className="size-2 rounded-full bg-primary" />
          <span className="font-mono text-kicker text-fg-muted">{dateLabel(observation.date)}</span>
        </span>
      ))}
    </div>
  );
}

function TrendChart({ analytics }: { analytics: E1rmAnalytics }) {
  const points = analytics.points;
  const values = points.map((point) => point.e1rm);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const coordinates = points.map((point, index) => ({
    point,
    x: points.length === 1 ? 163 : 10 + (index / (points.length - 1)) * 306,
    y: 104 - ((point.e1rm - min) / span) * 88,
  }));
  const segments: string[] = [];
  let segment: string[] = [];
  for (const [index, coordinate] of coordinates.entries()) {
    const previous = coordinates[index - 1];
    const gap =
      previous &&
      Date.parse(`${coordinate.point.date}T00:00:00Z`) -
        Date.parse(`${previous.point.date}T00:00:00Z`) >
        14 * 86_400_000;
    if (gap && segment.length > 0) {
      segments.push(segment.join(" "));
      segment = [];
    }
    segment.push(`${coordinate.x},${coordinate.y}`);
  }
  if (segment.length > 0) segments.push(segment.join(" "));

  return (
    <div className="flex flex-col gap-2" data-history-visual="ready-chart">
      <svg viewBox="0 0 326 118" className="h-[118px] w-full" role="img" aria-label="추정 1RM 추이">
        <line x1="10" y1="104" x2="316" y2="104" className="stroke-border-weak" strokeWidth="1" />
        {segments.map((line) => (
          <polyline
            key={line}
            points={line}
            fill="none"
            className="stroke-primary"
            strokeWidth="2"
          />
        ))}
        {coordinates.map(({ point, x, y }) => (
          <circle key={point.session_id} cx={x} cy={y} r="3" className="fill-primary" />
        ))}
      </svg>
      {hasChartGap(points) ? (
        <p className="text-xs text-fg-muted">
          기록이 없던 공백 구간은 선을 이어 추측하지 않았어요.
        </p>
      ) : null}
    </div>
  );
}

function ActualSessionCard({ session, exercise }: { session: Session; exercise: Exercise }) {
  const sets = session.planned_sets.filter(
    (set) => set.exercise_id === exercise.id && set.performed_set?.completed,
  );
  if (sets.length === 0) return null;
  return (
    <li>
      <Card density="tight" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-fg">{dateLabel(session.scheduled_date)}</p>
          <Link
            className="min-h-tap px-1 py-3 text-xs font-semibold text-primary underline"
            href={`/session/${session.id}`}
          >
            세션 상세 ›
          </Link>
        </div>
        <div className="flex flex-col divide-y divide-border-weak">
          {sets.map((set) => (
            <p
              key={set.id}
              className="grid grid-cols-[16px_1fr_1fr_42px] gap-[7px] py-[7px] font-mono text-xs tabular-nums"
            >
              <span>{set.set_no}</span>
              <span>
                {set.performed_set?.actual_weight == null
                  ? "자체중량"
                  : `${formatNumber(set.performed_set.actual_weight)}kg`}
              </span>
              <span>
                {set.performed_set?.actual_reps == null
                  ? `${set.performed_set?.actual_time_sec ?? 0}초`
                  : `${set.performed_set.actual_reps}회`}
              </span>
              <span className="text-right">
                {set.performed_set?.actual_rir == null
                  ? "—"
                  : `RIR ${set.performed_set.actual_rir}`}
              </span>
            </p>
          ))}
        </div>
      </Card>
    </li>
  );
}

export function HistoryScreen({ initialExerciseId }: { initialExerciseId?: string }) {
  const online = useOnline();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialExerciseId ?? "");
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => dashboardReadModel(),
    retry: false,
  });
  const program = useQuery({
    queryKey: ["program", "current"],
    queryFn: api.currentProgram,
    retry: false,
  });
  const catalog = useQuery({
    queryKey: ["exercises", "catalog"],
    queryFn: fetchAllExercises,
    retry: false,
  });
  const window = dashboard.data ? recentAnalyticsWindow(dashboard.data.data.date, 12) : null;
  const completion = useQuery({
    queryKey: ["analytics", "completion", window?.weekly],
    queryFn: () => completionReadModel(window?.weekly ?? {}),
    enabled: window !== null,
    retry: false,
  });
  const sessionIds = useMemo(() => completedSessionIds(completion.data?.data), [completion.data]);
  const sessionQueries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ["history-session", id],
      queryFn: () => historySessionReadModel(id),
      retry: false,
    })),
  });
  const sessions = useMemo(
    () => sessionQueries.flatMap((query) => (query.data ? [query.data.data] : [])),
    [sessionQueries],
  );
  const candidateIds = useMemo(() => {
    const recent = exerciseIdsByRecentSession(sessions);
    const planned =
      program.data?.sessions.flatMap((session) =>
        session.exercises.map((exercise) => exercise.exercise_id),
      ) ?? [];
    const primary = dashboard.data?.data.primary_e1rm?.exercise_id;
    return [...recent, ...(primary ? [primary] : []), ...planned].filter(
      (id, index, all) => all.indexOf(id) === index,
    );
  }, [dashboard.data, program.data, sessions]);

  useEffect(() => {
    if (!selectedId && candidateIds[0]) setSelectedId(candidateIds[0]);
  }, [candidateIds, selectedId]);

  const analytics = useQuery({
    queryKey: ["analytics", "e1rm", selectedId, window?.e1rm],
    queryFn: () =>
      e1rmReadModel({ exercise_id: selectedId, ...(window?.e1rm ?? { from: "", to: "" }) }),
    enabled: selectedId !== "" && window !== null,
    retry: false,
  });
  const selected = catalog.data?.find((exercise) => exercise.id === selectedId) ?? null;
  const visibility = analytics.data ? historyVisibility(analytics.data.data) : null;
  const actualSessions = sessions.filter((session) =>
    session.planned_sets.some(
      (set) => set.exercise_id === selectedId && set.performed_set?.completed,
    ),
  );
  const planned = program.data?.sessions
    .flatMap((session) =>
      session.exercises.map((exercise) => ({ day: session.day, focus: session.focus, exercise })),
    )
    .find((item) => item.exercise.exercise_id === selectedId);
  const staleEnvelopes = [
    dashboard.data,
    completion.data,
    analytics.data,
    ...sessionQueries.map((query) => query.data),
  ].filter((value): value is NonNullable<typeof value> => value != null && value.stale);
  const staleAt = staleEnvelopes.length
    ? Math.min(...staleEnvelopes.map((value) => Date.parse(value.syncedAt)))
    : null;

  const choose = (exerciseId: string) => {
    setSelectedId(exerciseId);
    router.replace(`/history?exercise=${encodeURIComponent(exerciseId)}`, { scroll: false });
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 p-4 pb-safe-bottom">
      <header className="flex items-baseline justify-between border-b border-border pb-3">
        <h1 className="text-[19px] font-extrabold text-fg">기록</h1>
        {selected ? (
          <p className="max-w-[55%] truncate text-sm font-semibold text-fg">{selected.name_ko}</p>
        ) : null}
      </header>

      {staleAt != null ? (
        <p role="status" className="text-xs text-fg-muted">
          오프라인 · 마지막 동기화 <span className="font-mono">{formatClock(staleAt)}</span> 기준
        </p>
      ) : null}

      {candidateIds.length > 0 ? (
        <div role="group" className="-mx-4 flex gap-2 overflow-x-auto px-4" aria-label="종목 선택">
          {candidateIds.map((id) => {
            const exercise = catalog.data?.find((item) => item.id === id);
            if (!exercise) return null;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selectedId === id}
                onClick={() => choose(id)}
                className={cn(
                  "min-h-tap shrink-0 rounded-control border px-3 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
                  selectionStateClass(selectedId === id),
                )}
              >
                {exercise.name_ko}
              </button>
            );
          })}
        </div>
      ) : null}

      {!selectedId && !dashboard.isPending && !completion.isPending ? (
        <Card className="flex flex-col gap-3 border-[1.5px] border-border-strong">
          <p className="text-sm text-fg-muted">기록 0회</p>
          <h2 className="text-[19px] font-extrabold text-fg">
            첫 세션을 마치면 여기에 추이가 쌓입니다
          </h2>
          <p className="text-sm text-ink-2">
            다음 추천은 한 세션부터, 추정 1RM과 추이는 세 세션부터 보여드려요.
          </p>
          <Link
            className="flex min-h-12 items-center justify-center rounded-control bg-action px-4 font-semibold text-action-fg"
            href="/"
          >
            오늘 운동 보기
          </Link>
        </Card>
      ) : null}

      {analytics.isPending && selectedId ? (
        <div aria-hidden="true" className="h-48 animate-pulse rounded-card bg-raised" />
      ) : null}

      {analytics.data && selected ? (
        <>
          {analytics.data.data.gate_state === "no_history" ? (
            <Card className="flex flex-col gap-3 border-[1.5px] border-border-strong">
              <p className="text-sm text-fg-muted">이 종목 기록 0회</p>
              <h2 className="text-xl font-bold text-fg">{selected.name_ko} 기록이 아직 없어요</h2>
              {similarExercises(selected, catalog.data ?? []).length > 0 ? (
                <div className="border-t border-border-weak pt-3">
                  <p className="text-sm font-semibold text-fg">비슷한 종목</p>
                  <ul className="mt-2 flex flex-col divide-y divide-border-weak">
                    {similarExercises(selected, catalog.data ?? []).map((exercise) => (
                      <li key={exercise.id}>
                        <button
                          type="button"
                          className="min-h-tap w-full text-left text-sm text-primary underline"
                          onClick={() => choose(exercise.id)}
                        >
                          {exercise.name_ko}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          ) : null}

          {analytics.data.data.gate_state === "no_history" && planned ? (
            <Card density="tight" className="flex flex-col gap-1" data-history-card="scheduled">
              <h2 className="text-sm font-semibold text-fg">예정 종목 · 아직 수행 전</h2>
              <p className="text-xs text-fg-muted">
                {dayLabel(planned.day) ?? "운동일"} · {planned.exercise.sets}세트
                {planned.exercise.reps_low == null
                  ? ""
                  : ` · ${planned.exercise.reps_low}–${planned.exercise.reps_high ?? planned.exercise.reps_low}회`}
              </p>
              <p className="text-xs text-fg-muted">
                일정 앞당기기나 미래 계획 교체는 이 화면에서 제공하지 않아요.
              </p>
            </Card>
          ) : null}

          {analytics.data.data.gate_state === "early" && visibility?.showObservationDots ? (
            <Card
              className="flex flex-col gap-3 border-[1.5px] border-border-strong"
              data-history-gate="early"
            >
              <div>
                <p className="text-sm text-fg-muted">
                  기록 {analytics.data.data.sample_session_count}회
                </p>
                <h2 className="mt-1 text-xl font-bold text-fg">세 세션부터 추이를 연결해요</h2>
              </div>
              <ObservationDots analytics={analytics.data.data} />
              <p className="text-sm text-ink-2">완료한 날짜와 실제 수행 기록을 보여드려요.</p>
            </Card>
          ) : null}

          {analytics.data.data.gate_state === "ready" && visibility?.showTrendLine ? (
            <Card
              className="flex flex-col gap-3 border-[1.5px] border-border-strong"
              data-history-gate="ready"
            >
              <div>
                <p className="text-sm text-fg-muted">
                  추정 1RM · {analytics.data.data.sample_session_count}회
                </p>
                <p className="mt-1 font-mono text-[36px] font-bold leading-none tabular-nums text-fg">
                  {formatNumber(analytics.data.data.points.at(-1)?.e1rm ?? 0)}
                  <span className="text-sm text-fg-muted">kg</span>
                </p>
              </div>
              <TrendChart analytics={analytics.data.data} />
            </Card>
          ) : null}

          {visibility?.showRecommendation && analytics.data.data.next_recommendation ? (
            <Card density="tight" className="text-sm text-ink-2">
              <p className="font-semibold text-fg">다음 추천</p>
              <p className="mt-1">{analytics.data.data.next_recommendation.explanation}</p>
            </Card>
          ) : null}

          {actualSessions.length > 0 ? (
            <section aria-labelledby="recent-sessions" className="flex flex-col gap-2">
              <h2 id="recent-sessions" className="text-lg font-semibold text-fg">
                최근 세션
              </h2>
              <ul className="flex flex-col gap-2">
                {actualSessions.map((session) => (
                  <ActualSessionCard key={session.id} session={session} exercise={selected} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {(analytics.isError || completion.isError) && !analytics.data && !completion.data ? (
        <Card role="alert" className="flex flex-col gap-3 border-danger">
          <p className="text-sm text-ink-2">
            {online ? "기록을 불러오지 못했어요." : "인터넷이 연결되면 기록을 보여드릴게요."}
          </p>
          <Button
            size="lg"
            fullWidth
            onClick={() => void Promise.all([analytics.refetch(), completion.refetch()])}
          >
            다시 시도
          </Button>
        </Card>
      ) : null}
    </div>
  );
}
