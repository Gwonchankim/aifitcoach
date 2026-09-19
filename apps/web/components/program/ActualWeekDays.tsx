"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button, Card } from "../ui";
import { api } from "../../lib/api";
import { DEV_USER_SCOPE, readThroughSession } from "../session/session-db";
import { currentWeekReadModel } from "../../lib/week-swap-data";
import { SWAP_COPY, type ActualWeekSession } from "../../lib/week-swap";
import { focusLabel } from "../../lib/program-labels";
import { formatClock } from "../../lib/use-online";

function ActualSessionDetail({
  session,
  names,
}: {
  session: ActualWeekSession;
  names: Map<string, string>;
}) {
  const detail = useQuery({
    queryKey: ["session", session.id],
    queryFn: () => readThroughSession(DEV_USER_SCOPE, session.id, () => api.session(session.id)),
    retry: false,
  });
  if (detail.isPending) return <p role="status">불러오는 중이에요.</p>;
  if (!detail.data || detail.error) return <p role="alert">{SWAP_COPY.malformed}</p>;
  return (
    <div className="flex flex-col gap-1 px-3 pb-3 pl-[55px]">
      {session.exercises.map((exercise) => {
        const rows = detail.data.planned_sets.filter(
          (row) => row.exercise_id === exercise.exercise_id,
        );
        return (
          <div
            key={exercise.exercise_id}
            className="border-t border-dotted border-border-weak py-[7px]"
          >
            <p className="text-sm text-fg">{names.get(exercise.exercise_id) ?? "운동"}</p>
            {rows.map((row) => (
              <p key={row.id} className="font-mono text-xs text-fg-muted">
                {row.set_no}세트 ·{" "}
                {row.target_time_low_sec != null
                  ? `${row.target_time_low_sec}–${row.target_time_high_sec ?? row.target_time_low_sec}초`
                  : `${row.target_reps_low ?? "—"}–${row.target_reps_high ?? row.target_reps_low ?? "—"}회`}
                {row.target_rir == null ? "" : ` · RIR ${row.target_rir}`}
              </p>
            ))}
          </div>
        );
      })}
      <Link
        className="flex min-h-tap items-center justify-end text-xs font-semibold text-primary underline"
        href={`/session/${session.id}`}
      >
        세션 상세 ›
      </Link>
    </div>
  );
}
const STATUS = { scheduled: "예정", in_progress: "진행", completed: "완료" };
export function ActualWeekDays({
  programId,
  names,
}: {
  programId: string;
  names: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const week = useQuery({
    queryKey: ["current-week", programId],
    queryFn: () => currentWeekReadModel(programId),
    retry: false,
  });
  if (week.isPending) return <div className="h-48 animate-pulse rounded-card bg-raised" />;
  if (!week.data || week.error)
    return (
      <Card>
        <p role="alert">{SWAP_COPY.malformed}</p>
        <Button onClick={() => void week.refetch()}>다시 불러오기</Button>
      </Card>
    );
  const data = week.data.data;
  const dates = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${data.week_start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  return (
    <>
      {week.data.stale ? (
        <p role="status" className="text-xs text-fg-muted">
          오프라인 · 마지막 동기화 {formatClock(Date.parse(week.data.syncedAt))} 기준
        </p>
      ) : null}
      <Card density="tight" className="overflow-hidden p-0" data-m4-card="program-days">
        {dates.map((date, index) => {
          const sessions = data.sessions.filter((session) => session.scheduled_date === date);
          return (
            <div
              key={date}
              data-week-date={date}
              className="border-t border-border-weak first:border-t-0"
            >
              {sessions.length ? (
                sessions.map((session) => (
                  <div key={session.id} data-week-session-id={session.id}>
                    <button
                      type="button"
                      aria-expanded={expanded === session.id}
                      onClick={() => setExpanded(expanded === session.id ? null : session.id)}
                      className="flex min-h-12 w-full items-center gap-2 px-3 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus"
                    >
                      <span className="w-[26px] shrink-0 font-mono text-xs font-bold">
                        {["월", "화", "수", "목", "금", "토", "일"][index]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">
                          {focusLabel(session.focus) ?? "운동"}
                        </span>
                        <span className="block text-xs text-fg-muted">
                          {STATUS[session.status]} · 운동 {session.exercises.length}개
                        </span>
                      </span>
                      <span aria-hidden="true">{expanded === session.id ? "⌃" : "⌄"}</span>
                    </button>
                    {expanded === session.id ? (
                      <ActualSessionDetail session={session} names={names} />
                    ) : null}
                  </div>
                ))
              ) : (
                <button
                  disabled
                  type="button"
                  className="flex min-h-12 w-full items-center gap-2 px-3 text-left"
                >
                  <span className="w-[26px] font-mono text-xs font-bold">
                    {["월", "화", "수", "목", "금", "토", "일"][index]}
                  </span>
                  <span className="text-sm text-fg-muted">휴식</span>
                </button>
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}
