"use client";

/**
 * S2 프로그램 확인 (FEATURES_UX F0 후속 / UX_STATES §2.2).
 * '왜 이 루틴' 근거 + 요일별 카드 + **제외된 운동·사유**를 보여준다.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge, Button, Card, buttonBase, cn } from "../../components/ui";
import { api } from "../../lib/api";
import { CURRENT_PROGRAM_ERRORS, isNotFound, toUiError } from "../../lib/error-copy";
import { dayLabel, focusLabel } from "../../lib/program-labels";
import { formatClock, useOnline } from "../../lib/use-online";
import { painAreaLabel } from "../../components/onboarding/pain-areas";
import { fetchExerciseNames } from "./exercise-names";
import {
  EMPTY_DAY_NOTE,
  MEDICAL_DISCLAIMER,
  NO_EXCLUSION_NOTE,
  excludedHeading,
  excludedReason,
  whyThisRoutine,
} from "./program-copy";

/** 링크를 주 액션처럼 보이게 한다. Button 은 <button> 전용이라 여기서 스타일만 맞춘다. */
function LinkAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        buttonBase,
        "min-h-tap-lg w-full px-6 text-base",
        "bg-action text-action-fg hover:bg-action/90 active:bg-action/80",
      )}
    >
      {children}
    </Link>
  );
}

function Skeleton({ className }: { className: string }) {
  return (
    <div aria-hidden="true" className={cn("animate-pulse rounded-card bg-raised", className)} />
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold text-fg">내 운동 계획</h1>
      {children}
    </div>
  );
}

export function ProgramScreen() {
  const online = useOnline();

  const program = useQuery({
    queryKey: ["program", "current"],
    queryFn: api.currentProgram,
    retry: false,
  });

  const data = program.data;
  const excluded = data?.excluded_exercises ?? [];

  const names = useQuery({
    queryKey: ["exercises", "names"],
    queryFn: fetchExerciseNames,
    enabled: excluded.length > 0,
    retry: false,
  });

  if (!data && program.isPending) {
    return (
      <Screen>
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </Screen>
    );
  }

  // 404 = 계획 없음. 에러가 아니라 빈 상태로 다룬다(§2.2 빈③).
  if (!data && isNotFound(program.error)) {
    return (
      <Screen>
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">아직 운동 계획이 없어요.</p>
          <LinkAction href="/onboarding">계획 만들기</LinkAction>
        </Card>
      </Screen>
    );
  }

  if (!data) {
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

  const reasons = whyThisRoutine(data);

  return (
    <Screen>
      {!online ? (
        <p role="status" className="text-xs text-fg-muted">
          오프라인이에요. 마지막으로 받아온 계획을 보고 있어요 ·{" "}
          <span className="font-mono">{formatClock(program.dataUpdatedAt)}</span> 기준
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

      <section className="flex flex-col gap-3" aria-labelledby="program-days-heading">
        <h2 id="program-days-heading" className="text-lg font-semibold text-fg">
          요일별 루틴
        </h2>
        {data.sessions.map((session) => {
          const focus = focusLabel(session.focus);
          return (
            <Card key={`${session.day}-${session.focus}`} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg">
                  {dayLabel(session.day) ?? "운동일"}
                </span>
                {focus ? <Badge tone="neutral">{focus}</Badge> : null}
              </div>
              {session.exercises.length > 0 ? (
                /* 개수는 모노 + tabular-nums(DESIGN_TOKENS §4) — 카드가 세로로 쌓여 자릿수가 흔들린다. */
                <p className="text-sm text-ink-2">
                  운동 <span className="font-mono">{session.exercises.length}</span>개
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-ink-2">{EMPTY_DAY_NOTE}</p>
                  <p className="text-xs text-fg-muted">{MEDICAL_DISCLAIMER}</p>
                </div>
              )}
            </Card>
          );
        })}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="program-excluded-heading">
        <h2 id="program-excluded-heading" className="text-lg font-semibold text-fg">
          {excludedHeading(excluded.length)}
        </h2>

        {excluded.length === 0 ? (
          <Card className="flex flex-col gap-2">
            <p className="text-sm text-ink-2">{NO_EXCLUSION_NOTE}</p>
            <p className="text-xs text-fg-muted">{MEDICAL_DISCLAIMER}</p>
          </Card>
        ) : (
          <Card className="flex flex-col gap-3">
            <ul className="flex flex-col gap-3">
              {excluded.map((item) => {
                const name = names.data?.[item.exercise_id];
                const areaLabel = painAreaLabel(item.pain_area);
                const reason = excludedReason(item.pain_area);
                return (
                  <li key={item.exercise_id} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {name ? (
                        <span className="text-base font-semibold text-fg">{name}</span>
                      ) : null}
                      {areaLabel ? <Badge tone="warn">{areaLabel} 통증</Badge> : null}
                    </div>
                    {reason ? <p className="text-sm text-ink-2">{reason}</p> : null}
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-fg-muted">{MEDICAL_DISCLAIMER}</p>
          </Card>
        )}
      </section>

      <div className="mt-2 pb-safe-bottom">
        <LinkAction href="/">대시보드로</LinkAction>
      </div>
    </Screen>
  );
}
