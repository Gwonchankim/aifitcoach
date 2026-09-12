"use client";

/**
 * S3 대시보드 (F8 / UX_STATES §2.3) — 앱의 홈.
 *
 * 계획이 없으면(`GET /programs/current` 404) 온보딩 카드만 보여준다(§2.3 빈①).
 * 요약이 실패해도 화면 전체를 에러로 덮지 않는다(AC-S3-2) — 오늘 카드 자리에만 배너를 둔다.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Kicker, buttonBase, cn } from "../ui";
import { ApiError, api, type BodyPart } from "../../lib/api";
import { DASHBOARD_ERRORS, isNotFound, toUiError } from "../../lib/error-copy";
import { formatClock, useOnline } from "../../lib/use-online";
import {
  dashboardReadModel,
  e1rmReadModel,
  historySessionReadModel,
  recentAnalyticsWindow,
  volumeReadModel,
} from "../../lib/read-model-data";
import { summarize, useSessionLog } from "../session/session-store";
import { BodyPartSheet } from "./BodyPartSheet";
import { E1RM_EMPTY_NOTE, type MetricCard, buildDashboardView } from "./dashboard-view";
import {
  dashboardDate,
  e1rmDelta,
  E1rmSummaryCard,
  VolumeCard,
  WeeklyRhythmCard,
} from "../analytics/AnalyticsCards";
import { fetchExerciseNames } from "../../app/program/exercise-names";

function LinkAction({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
}) {
  // 형태·포커스는 Button 과 같아야 한다 — 두 벌로 두지 않고 buttonBase 를 그대로 쓴다.
  return (
    <Link
      href={href}
      className={cn(
        buttonBase,
        "min-h-tap-lg w-full px-6 text-base",
        variant === "primary"
          ? "bg-action text-action-fg hover:bg-action/90 active:bg-action/80"
          : "border border-border-strong bg-surface text-fg hover:bg-raised active:bg-raised",
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

function Metric({ card }: { card: MetricCard }) {
  return (
    <Card className="flex flex-1 flex-col gap-1">
      <p className="text-xs text-fg-muted">{card.label}</p>
      {/* 지표 수치는 모노 + tabular-nums(DESIGN_TOKENS §4) — 2열의 두 값이 같은 자리에서 시작한다. */}
      {card.value ? (
        <p className="font-mono text-metric font-bold tabular-nums text-fg">{card.value}</p>
      ) : null}
      {card.note ? <p className="text-xs text-fg-muted">{card.note}</p> : null}
    </Card>
  );
}

function Screen({ children, meta }: { children: React.ReactNode; meta?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 p-4 pb-safe-bottom">
      <header className="flex items-baseline justify-between border-b border-border pb-3">
        <h1 className="text-[19px] font-extrabold text-fg">오늘</h1>
        {meta ? <p className="font-mono text-kicker text-fg-muted">{meta}</p> : null}
      </header>
      {children}
    </div>
  );
}

/**
 * 프로그램 없음(§2.3 빈①) 카드의 "만들고 나면" 3단 안내. D-5 승인(PROGRESS §M-UIa 4)으로 UIa 범위다.
 *
 * ②의 처방은 한 세션부터, 분석은 종목별 세 세션부터다(ADR-70).
 * 이 안내는 **잠금이 아니다** — 자물쇠·업그레이드 유도를 쓰지 않고
 * "아직 없음 + 언제 생기는지 + 지금 할 수 있는 것" 3요소만 말한다.
 */
const AFTER_PROGRAM_STEPS = [
  "요일마다 할 종목과 세트가 이 자리에 뜹니다.",
  "한 세션을 완료하면 다음 추천이, 세 세션이 쌓이면 추정 1RM이 나타납니다.",
  "주간 리듬과 근육군별 볼륨이 여기 아래로 붙습니다.",
];

/** F8-1 즉석 세션 만들기에서만 쓰는 문구(§3 원칙: 서버 메시지를 그대로 쓰지 않는다). */
const AD_HOC_ERRORS: Record<number, string> = {
  400: "이 부위로는 지금 루틴을 만들 수 없어요. 다른 부위를 골라 주세요.",
  500: "지금은 루틴을 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.",
};

export function DashboardScreen() {
  const online = useOnline();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [partSheetOpen, setPartSheetOpen] = useState(false);
  const [adHocError, setAdHocError] = useState<string | null>(null);

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

  const volumeWindow = dashboard.data
    ? recentAnalyticsWindow(dashboard.data.data.date, 1).weekly
    : null;
  const volume = useQuery({
    queryKey: ["analytics", "volume", volumeWindow],
    queryFn: () => volumeReadModel(volumeWindow ?? {}),
    enabled: volumeWindow !== null,
    retry: false,
  });
  const todaySessionId = dashboard.data?.data.today.session_id ?? null;
  const todaySession = useQuery({
    queryKey: ["dashboard-session", todaySessionId],
    queryFn: () => historySessionReadModel(todaySessionId!),
    enabled: todaySessionId !== null,
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
  const exerciseNames = useQuery({
    queryKey: ["exercises", "names"],
    queryFn: fetchExerciseNames,
    enabled: primaryExerciseId != null || todaySessionId != null,
    retry: false,
  });

  /*
    오늘 세션의 완료 세트는 아직 서버로 가지 않는다(세트 저장 경로는 STEP 6 `/sync`).
    그래서 요약 화면이 "오늘 2세트"를 보여주는 순간에도 `done_summary.sets_completed` 는 0 이다
    → 그 0 을 "기록이 없다"로 **단정하지 않도록** 이 기기의 기록 수를 함께 넘긴다.
    STEP 6 이 붙으면 서버 요약이 채워져 이 분기는 자연히 사라진다.
  */
  const localSetsCompleted = useSessionLog((state) =>
    state.sessionId != null && state.sessionId === todaySessionId
      ? summarize(state.drafts).completedCount
      : 0,
  );

  /**
   * F8-1. 세 갈래로 갈린다.
   *  - 201: 만든 세션으로 이동한다.
   *  - 409: 오늘 이미 세션이 있다는 뜻이다 → **에러를 보여주지 않고** 요약을 다시 받아 그 세션으로 간다.
   *  - 404: 프로그램이 없다 → 온보딩으로 보낸다.
   */
  const adHoc = useMutation({
    mutationFn: (bodyPart: BodyPart) => api.createAdHocSession({ body_part: bodyPart }),
    onSuccess: (session) => {
      setPartSheetOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      router.push(`/session/${session.id}`);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        const latest = await queryClient
          .fetchQuery({ queryKey: ["dashboard"], queryFn: () => dashboardReadModel() })
          .catch(() => null);
        if (latest?.data.today.session_id) {
          setPartSheetOpen(false);
          router.push(`/session/${latest.data.today.session_id}`);
          return;
        }
      }
      if (error instanceof ApiError && error.status === 404) {
        setPartSheetOpen(false);
        router.push("/onboarding");
        return;
      }
      setAdHocError(toUiError(error, AD_HOC_ERRORS).message);
    },
  });

  // 선행 조건: 계획이 없으면 요약도 의미가 없다(§2.3 빈①).
  if (!program.data && isNotFound(program.error)) {
    return (
      <Screen>
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            {/* 키커 자리지만 한글이라 모노 9.5px 를 쓰지 않는다(DESIGN_TOKENS §4). */}
            <p className="text-xs font-semibold text-fg-muted">프로그램 없음</p>
            <h2 className="text-xl font-bold text-fg">아직 운동 계획이 없어요</h2>
            <p className="text-sm text-ink-2">
              목표와 운동할 수 있는 요일만 고르면 요일별 계획이 만들어져요.
            </p>
          </div>
          <LinkAction href="/onboarding">계획 만들기</LinkAction>
        </Card>

        <Card className="flex flex-col gap-3">
          <h3 className="text-lg font-semibold text-fg">만들고 나면</h3>
          <ol className="flex flex-col">
            {AFTER_PROGRAM_STEPS.map((step, index) => (
              <li
                key={step}
                className="flex gap-3 border-t border-border-weak py-3 first:border-t-0 first:pt-0 last:pb-0"
              >
                {/* 순번은 <ol> 이 이미 전달한다 — 화면용 표식이라 낭독에서 뺀다. */}
                <Kicker aria-hidden="true" className="pt-1">
                  {`0${index + 1}`}
                </Kicker>
                <p className="flex-1 text-sm text-ink-2">{step}</p>
              </li>
            ))}
          </ol>
        </Card>
      </Screen>
    );
  }

  /**
   * 계획이 없으면 대시보드는 404 가 아니라 **200 + 오늘/내일 모두 휴식**으로 온다.
   * 두 조회가 병렬이라, 프로그램 조회가 끝나기 전에 요약을 그리면 "오늘은 휴식이에요"가 잠깐 보였다가
   * 온보딩 카드로 바뀐다 → 프로그램 조회가 끝날 때까지는 스켈레톤을 유지한다.
   */
  const loading = (program.isPending || dashboard.isPending) && !dashboard.data;
  const summary = dashboard.data?.data ?? null;
  const view = !loading && summary ? buildDashboardView(summary, localSetsCompleted) : null;

  return (
    <Screen
      meta={
        dashboard.data
          ? `${dashboardDate(dashboard.data.data.date)}${program.data ? ` · ${program.data.current_week}주차` : ""}`
          : undefined
      }
    >
      {dashboard.data?.stale ? (
        <p role="status" className="text-xs text-fg-muted">
          오프라인 · 마지막 동기화{" "}
          <span className="font-mono">{formatClock(Date.parse(dashboard.data.syncedAt))}</span> 기준
        </p>
      ) : null}

      {view ? (
        <>
          <Card className="flex flex-col gap-3 border-[1.5px] border-border-strong p-[13px]">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-fg">{view.today.heading}</h2>
              {view.today.status === "done" ? <Badge tone="success">완료</Badge> : null}
              {view.today.status === "partial" ? <Badge tone="warn">부분 완료</Badge> : null}
              {view.today.status === "in_progress" ? <Badge tone="neutral">진행</Badge> : null}
              {view.today.status === "conflict" ? <Badge tone="warn">계획 충돌</Badge> : null}
              {view.today.status === "return_after_gap" ? (
                <Badge tone="warn">공백 복귀</Badge>
              ) : null}
              {view.today.status === "rest" ? <Badge tone="neutral">휴식</Badge> : null}
            </div>
            <p className="text-sm text-ink-2">{view.today.message}</p>
            {view.today.notes.map((note) => (
              <p key={note} className="text-xs text-fg-muted">
                {note}
              </p>
            ))}
            {view.today.status === "workout" && todaySession.data ? (
              <div className="flex flex-col gap-1 border-t border-border-weak pt-2 text-xs text-fg-muted">
                <p>
                  <span className="font-mono tabular-nums">
                    {todaySession.data.data.planned_sets.length}
                  </span>
                  세트 예정
                </p>
                {todaySession.data.data.planned_sets[0]?.recommended_weight != null ? (
                  <p>
                    첫 추천 ·{" "}
                    {exerciseNames.data?.[todaySession.data.data.planned_sets[0].exercise_id] ??
                      "운동"}{" "}
                    <span className="font-mono tabular-nums">
                      {todaySession.data.data.planned_sets[0].recommended_weight}kg
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
            {view.today.primary ? (
              <LinkAction href={view.today.primary.href}>{view.today.primary.label}</LinkAction>
            ) : null}
            {/* F8-1: 휴식일이라고 막지 않는다. 쉬는 날의 톤을 유지하려고 보조 액션으로 둔다. */}
            {view.today.status === "rest" ? (
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                onClick={() => {
                  setAdHocError(null);
                  setPartSheetOpen(true);
                }}
              >
                그래도 운동하기
              </Button>
            ) : null}
            {view.today.secondary ? (
              <LinkAction href={view.today.secondary.href} variant="secondary">
                {view.today.secondary.label}
              </LinkAction>
            ) : null}
          </Card>

          <Card className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-fg">{view.tomorrow.heading}</h2>
            <p className="text-sm text-ink-2">{view.tomorrow.message}</p>
          </Card>

          <div className="flex gap-3">
            <Metric card={view.streak} />
            <Metric card={view.weekly} />
          </div>

          {summary?.weekly_rhythm.length === 7 ? (
            <WeeklyRhythmCard days={summary.weekly_rhythm} />
          ) : null}

          <E1rmSummaryCard
            summary={summary?.primary_e1rm ?? null}
            exerciseName={primaryExerciseId ? exerciseNames.data?.[primaryExerciseId] : undefined}
            delta={e1rmDelta(primaryTrend.data?.data)}
          />

          {volume.data ? <VolumeCard analytics={volume.data.data} /> : null}
        </>
      ) : loading ? (
        <>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : (
        <Card role="alert" className="flex flex-col gap-3 border-danger">
          <p className="text-sm text-ink-2">
            {!online
              ? "인터넷이 연결되면 요약을 보여드릴게요."
              : toUiError(dashboard.error, DASHBOARD_ERRORS).message}
          </p>
          <Button size="lg" fullWidth onClick={() => void dashboard.refetch()}>
            다시 시도
          </Button>
        </Card>
      )}

      {/* 서버 gate가 ready가 아닐 때는 수치·기록 링크를 만들지 않는다(D-39). */}
      {!summary?.primary_e1rm || summary.primary_e1rm.gate_state !== "ready" ? (
        <Card className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-fg">주요 리프트 추세</h2>
          <p className="text-xs text-fg-muted">{E1RM_EMPTY_NOTE}</p>
        </Card>
      ) : null}

      <Link
        href="/program"
        className="min-h-tap self-start px-1 py-2 text-base font-medium text-primary underline hover:text-primary-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        내 운동 계획 보기
      </Link>

      <BodyPartSheet
        open={partSheetOpen}
        streakDays={dashboard.data?.data.streak_days ?? 0}
        pending={adHoc.isPending}
        errorText={adHocError}
        onSelect={(bodyPart) => {
          setAdHocError(null);
          adHoc.mutate(bodyPart);
        }}
        onClose={() => setPartSheetOpen(false)}
      />
    </Screen>
  );
}
