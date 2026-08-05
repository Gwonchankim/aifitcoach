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
import { Badge, Button, Card, cn } from "../ui";
import { ApiError, api, type BodyPart } from "../../lib/api";
import { DASHBOARD_ERRORS, isNotFound, toUiError } from "../../lib/error-copy";
import { formatClock, useOnline } from "../../lib/use-online";
import { summarize, useSessionLog } from "../session/session-store";
import { BodyPartSheet } from "./BodyPartSheet";
import { E1RM_EMPTY_NOTE, type MetricCard, buildDashboardView } from "./dashboard-view";

function LinkAction({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex min-h-tap-lg w-full items-center justify-center rounded-control px-6",
        "text-lg font-semibold",
        variant === "primary"
          ? "bg-primary text-primary-fg"
          : "border border-border-strong bg-surface text-fg",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
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
      <p className="text-sm text-fg-muted">{card.label}</p>
      {card.value ? (
        <p className="text-metric font-bold text-fg tabular-nums">{card.value}</p>
      ) : null}
      {card.note ? <p className="text-sm text-fg-muted">{card.note}</p> : null}
    </Card>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 pb-safe-bottom">
      <h1 className="text-2xl font-bold text-fg">AIFITCOACH</h1>
      {children}
    </div>
  );
}

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
    queryFn: api.dashboard,
    retry: false,
  });

  /*
    오늘 세션의 완료 세트는 아직 서버로 가지 않는다(세트 저장 경로는 STEP 6 `/sync`).
    그래서 요약 화면이 "오늘 2세트"를 보여주는 순간에도 `done_summary.sets_completed` 는 0 이다
    → 그 0 을 "기록이 없다"로 **단정하지 않도록** 이 기기의 기록 수를 함께 넘긴다.
    STEP 6 이 붙으면 서버 요약이 채워져 이 분기는 자연히 사라진다.
  */
  const todaySessionId = dashboard.data?.today.session_id ?? null;
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
          .fetchQuery({ queryKey: ["dashboard"], queryFn: api.dashboard })
          .catch(() => null);
        if (latest?.today.session_id) {
          setPartSheetOpen(false);
          router.push(`/session/${latest.today.session_id}`);
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
        <Card className="flex flex-col gap-3">
          <p className="text-fg">운동 계획을 먼저 만들어 주세요.</p>
          <LinkAction href="/onboarding">계획 만들기</LinkAction>
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
  const view =
    !loading && dashboard.data ? buildDashboardView(dashboard.data, localSetsCompleted) : null;

  return (
    <Screen>
      {!online && dashboard.data ? (
        <p role="status" className="text-sm text-fg-muted">
          오프라인 · {formatClock(dashboard.dataUpdatedAt)} 기준
        </p>
      ) : null}

      {view ? (
        <>
          <Card className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-fg">{view.today.heading}</h2>
              {view.today.status === "done" ? <Badge tone="success">완료</Badge> : null}
              {view.today.status === "rest" ? <Badge tone="neutral">휴식</Badge> : null}
            </div>
            <p className="text-fg">{view.today.message}</p>
            {view.today.notes.map((note) => (
              <p key={note} className="text-sm text-fg-muted">
                {note}
              </p>
            ))}
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
            <p className="text-fg-muted">{view.tomorrow.message}</p>
          </Card>

          <div className="flex gap-3">
            <Metric card={view.streak} />
            <Metric card={view.weekly} />
          </div>
        </>
      ) : loading ? (
        <>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : (
        <Card role="alert" className="flex flex-col gap-3 border-danger">
          <p className="text-fg">
            {!online
              ? "인터넷이 연결되면 요약을 보여드릴게요."
              : toUiError(dashboard.error, DASHBOARD_ERRORS).message}
          </p>
          <Button size="lg" fullWidth onClick={() => void dashboard.refetch()}>
            다시 시도
          </Button>
        </Card>
      )}

      {/* 요약이 실패해도 이 카드는 그대로 렌더된다(AC-S3-2). */}
      <Card className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-fg">주요 리프트 추세</h2>
        <p className="text-sm text-fg-muted">{E1RM_EMPTY_NOTE}</p>
      </Card>

      <Link
        href="/program"
        className="min-h-tap self-start px-1 py-2 text-base font-medium text-primary underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        내 운동 계획 보기
      </Link>

      <BodyPartSheet
        open={partSheetOpen}
        streakDays={dashboard.data?.streak_days ?? 0}
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
