/**
 * 데일리 루틴 화면(F1~F7). 오늘 세션을 운동 단위로 그리고, 세트 로깅·휴식 타이머·
 * 루틴 편집·운동 종료를 조율한다. 계산·판정은 전부 옆 모듈(순수 함수)에 있다.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { buildProvisionalRoutineSets, routineSetCountFor } from "shared";
import {
  ApiError,
  api,
  type GatedRecommendation,
  type PlannedSet,
  type Session,
  type SyncResponse,
} from "../../lib/api";
import { startRest, type RestTimer } from "../../lib/rest-timer";
import { isUtcToday } from "../../lib/utc-day";
import { Button, Card } from "../ui";
import { ExerciseCard } from "./ExerciseCard";
import { ExercisePickerSheet, type PickerMode } from "./ExercisePickerSheet";
import { RemoveExerciseSheet } from "./RemoveExerciseSheet";
import { FinishSheet } from "./FinishSheet";
import { PainSheet } from "./PainSheet";
import { RestTimerSheet } from "./RestTimerSheet";
import { SessionSummary } from "./SessionSummary";
import { primaryInputId } from "./SetRow";
import { SESSION_COMPLETED, errorMessage, isConflict, shouldRefetch } from "./errors";
import { fetchAllExercises } from "./exercise-catalog";
import { hasWeightInput, setKind, type SetValues } from "./set-rules";
import { newClientId, painOf, summarize, useSessionLog } from "./session-store";
import {
  commitRoutineSnapshot,
  commitSessionCompletion,
  DEV_USER_SCOPE,
  mirrorSession,
  readThroughSession,
  type RoutineCorrelation,
} from "./session-db";
import {
  PLANNED_SET_MAPPING_EVENT,
  requestForegroundSync,
  SYNC_RESPONSE_EVENT,
} from "./sync-coordinator";

type CompleteResponse = {
  session: Session;
  next_recommendations: GatedRecommendation[];
};

type RestState = { plannedSetId: string; title: string; timer: RestTimer };

const LOCKED_REASON = "기록이 있는 운동이라 빼거나 바꿀 수 없어요. 완료 체크를 해제해 주세요.";

function mappedSession(session: Session, mappings: SyncResponse["planned_set_mappings"]): Session {
  if (mappings.length === 0) return session;
  const byCorrelation = new Map(
    mappings.map((mapping) => [mapping.correlation_id, mapping.planned_set]),
  );
  return {
    ...session,
    planned_sets: session.planned_sets.map((set) => byCorrelation.get(set.id) ?? set),
  };
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const drafts = useSessionLog((state) => state.drafts);
  const begin = useSessionLog((state) => state.begin);
  const completeSetInStore = useSessionLog((state) => state.completeSet);
  const uncompleteSetInStore = useSessionLog((state) => state.uncompleteSet);
  const reportPainInStore = useSessionLog((state) => state.reportPain);
  const remapPlannedSetsInStore = useSessionLog((state) => state.remapPlannedSets);
  const refreshDraftsFromMirror = useSessionLog((state) => state.refreshFromMirror);

  const [rest, setRest] = useState<RestState | null>(null);
  /** 펼쳐 둔 완료 세트. 한 번에 하나만 펼친다(AC-SET-8) → 화면 전체에서 값 하나로 관리한다. */
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);
  const [removeExerciseId, setRemoveExerciseId] = useState<string | null>(null);
  const [painExerciseId, setPainExerciseId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [summary, setSummary] = useState<CompleteResponse | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void begin(sessionId);
  }, [sessionId, begin]);

  useEffect(() => {
    const onMapping = (event: Event) => {
      const mappings = (event as CustomEvent<SyncResponse["planned_set_mappings"]>).detail;
      if (!Array.isArray(mappings) || mappings.length === 0) return;
      remapPlannedSetsInStore(mappings);
      void (async () => {
        const queryKey = ["session", sessionId] as const;
        // A reconnect read can have captured the pre-mapping routine before /sync commits.
        // Abort that request first so its late response cannot overwrite the mapped cache or mirror,
        // then refetch from the now-authoritative server state.
        await queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.setQueryData<Session>(queryKey, (current) =>
          current ? mappedSession(current, mappings) : current,
        );
        await queryClient.invalidateQueries({ queryKey, exact: true });
      })();
    };
    window.addEventListener(PLANNED_SET_MAPPING_EVENT, onMapping);
    return () => window.removeEventListener(PLANNED_SET_MAPPING_EVENT, onMapping);
  }, [queryClient, remapPlannedSetsInStore, sessionId]);

  useEffect(() => {
    const onSyncResponse = (event: Event) => {
      const response = (event as CustomEvent<SyncResponse>).detail;
      if (
        response?.changes.some(
          (change) => change.entity === "performed_set" || change.entity === "session",
        )
      )
        void refreshDraftsFromMirror(sessionId);
    };
    window.addEventListener(SYNC_RESPONSE_EVENT, onSyncResponse);
    return () => window.removeEventListener(SYNC_RESPONSE_EVENT, onSyncResponse);
  }, [refreshDraftsFromMirror, sessionId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const sessionQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: ({ signal }) =>
      readThroughSession<Session>(DEV_USER_SCOPE, sessionId, () => api.session(sessionId, signal)),
  });

  const catalogQuery = useQuery({
    queryKey: ["exercises"],
    queryFn: fetchAllExercises,
    staleTime: Infinity,
  });

  const session = sessionQuery.data;
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const catalogById = useMemo(
    () => new Map(catalog.map((exercise) => [exercise.id, exercise])),
    [catalog],
  );

  /** 운동 단위 그룹. 계약에 순서 필드가 없어 서버가 준 배열 순서를 그대로 쓴다. */
  const groups = useMemo(() => {
    const byExercise = new Map<string, PlannedSet[]>();
    for (const set of session?.planned_sets ?? []) {
      const sets = byExercise.get(set.exercise_id) ?? [];
      sets.push(set);
      byExercise.set(set.exercise_id, sets);
    }
    return [...byExercise.entries()].map(([exerciseId, sets]) => ({
      exerciseId,
      sets: [...sets].sort((a, b) => a.set_no - b.set_no),
    }));
  }, [session]);

  const orderedSets = useMemo(() => groups.flatMap((group) => group.sets), [groups]);
  /**
   * 카탈로그가 도착했거나(성공) 끝내 실패했을 때만 운동 카드를 그린다.
   * 실패하면 이름을 알 방법이 없으므로 순번 이름으로 낮춰서라도 기록은 계속할 수 있게 둔다
   * (배너 + [다시 시도] 가 위에 함께 보인다, E-21).
   */
  const catalogResolved = catalogQuery.isSuccess || catalogQuery.isError;
  const nameOf = (exerciseId: string, index: number) =>
    catalogById.get(exerciseId)?.name_ko ?? `운동 ${index + 1}`;

  const { completedCount, totalVolume } = summarize(drafts);
  /*
    F6-1. 종료했다고 잠그지 않는다 — **오늘 세션이면** 세트를 더하거나 고칠 수 있다(재개/편집 모드).
    잠그는 건 **다른 날짜**의 종료된 세션뿐이다(서버도 같은 조건으로 409 를 낸다).
    판정 기준은 서버와 같은 UTC 다(lib/utc-day.ts) — 로컬 시간대로 보면 자정 근처가 어긋난다.
  */
  const finishedToday = session?.status === "completed" && isUtcToday(session.scheduled_date);
  const readOnly = session?.status === "completed" && !finishedToday;
  const modalOpen =
    rest != null ||
    picker != null ||
    removeExerciseId != null ||
    painExerciseId != null ||
    finishOpen;

  /**
   * 루틴이 바뀌면 서버가 추천을 다시 계산한다(F6-1) → 대시보드의 오늘 요약도 낡는다.
   * 세션 캐시만 갈아 끼우고 끝내면 대시보드가 옛 운동 수를 계속 보여준다.
   */
  const applySession = (updated: Session) => {
    queryClient.setQueryData(["session", sessionId], updated);
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    setEditError(null);
  };

  /**
   * 409 는 세 원인(다른 날짜의 종료된 세션·중복 종목·수행 기록)이 모두 같은 코드로 온다(§3.2).
   * 서버 한국어 메시지를 매칭하면 문구가 바뀔 때 깨지므로, **세션 상태를 다시 받아** 판정한다.
   * 종료된 세션이어도 **오늘이면 편집이 열려 있다**(F6-1) → 날짜까지 봐야 원인을 맞게 고른다.
   */
  const handleEditError = async (error: unknown, action: "add" | "remove" | "swap") => {
    if (shouldRefetch(error)) {
      const latest = await queryClient
        .fetchQuery({ queryKey: ["session", sessionId], queryFn: () => api.session(sessionId) })
        .catch(() => null);
      if (latest) await mirrorSession(DEV_USER_SCOPE, sessionId, latest).catch(() => undefined);
      if (
        isConflict(error) &&
        latest?.status === "completed" &&
        !isUtcToday(latest.scheduled_date)
      ) {
        setEditError(SESSION_COMPLETED);
        return;
      }
    }
    setEditError(errorMessage(error, action));
  };

  const commitRoutineEdit = async (
    next: Session,
    correlations: RoutineCorrelation[],
  ): Promise<Session> => {
    const exerciseIds = [...new Set(next.planned_sets.map((plannedSet) => plannedSet.exercise_id))];
    const clientId = newClientId();
    await commitRoutineSnapshot(
      DEV_USER_SCOPE,
      sessionId,
      exerciseIds,
      clientId,
      new Date().toISOString(),
      correlations,
      next,
    );
    // The local transaction is the offline success boundary. When the browser knows it is online,
    // wait for this mutation's acknowledgement so a server conflict can keep the editor open.
    if (typeof navigator === "undefined" || !navigator.onLine) {
      void requestForegroundSync().catch(() => undefined);
      return next;
    }
    let synced: SyncResponse | null = null;
    try {
      synced = await requestForegroundSync();
    } catch {
      // A transport failure does not undo the durable local write; the outbox retries it later.
      return next;
    }
    if (synced?.conflicts.some((conflict) => conflict.client_id === clientId))
      throw new ApiError(409, "SYNC_CONFLICT", "routine sync conflict");
    if (synced?.applied.includes(clientId)) {
      const authoritative = await api.session(sessionId).catch(() => null);
      if (authoritative) {
        await mirrorSession(DEV_USER_SCOPE, sessionId, authoritative).catch(() => undefined);
        return authoritative;
      }
    }
    return next;
  };

  const provisionalSets = (exerciseId: string, count: number) => {
    const exercise = catalogById.get(exerciseId);
    if (!exercise) throw new Error("운동 정보를 불러오지 못했어요.");
    const correlations: RoutineCorrelation[] = Array.from({ length: count }, (_, index) => ({
      correlation_id: newClientId(),
      exercise_id: exerciseId,
      set_no: index + 1,
    }));
    const sets = buildProvisionalRoutineSets(
      session!.goal,
      exercise,
      correlations.map((item) => item.correlation_id),
    ) as PlannedSet[];
    return { sets, correlations };
  };

  const addMutation = useMutation({
    networkMode: "always",
    mutationFn: async (exerciseId: string) => {
      if (!session) throw new Error("세션을 불러오지 못했어요.");
      const exercise = catalogById.get(exerciseId);
      if (!exercise) throw new Error("운동 정보를 불러오지 못했어요.");
      const provisional = provisionalSets(
        exerciseId,
        routineSetCountFor(session.goal, exercise.mechanic),
      );
      const updated = await commitRoutineEdit(
        { ...session, planned_sets: [...session.planned_sets, ...provisional.sets] },
        provisional.correlations,
      );
      return { updated, exerciseId };
    },
    onSuccess: ({ updated, exerciseId }) => {
      applySession(updated);
      setPicker(null);
      setNotice(`${catalogById.get(exerciseId)?.name_ko ?? "운동"}을(를) 루틴에 추가했어요`);
    },
    onError: (error) => void handleEditError(error, "add"),
  });

  const removeMutation = useMutation({
    networkMode: "always",
    mutationFn: async (exerciseId: string) => {
      if (!session) throw new Error("세션을 불러오지 못했어요.");
      const updated = await commitRoutineEdit(
        {
          ...session,
          planned_sets: session.planned_sets.filter((set) => set.exercise_id !== exerciseId),
        },
        [],
      );
      return { updated, exerciseId };
    },
    onSuccess: ({ updated, exerciseId }) => {
      applySession(updated);
      setRemoveExerciseId(null);
      setNotice(`${catalogById.get(exerciseId)?.name_ko ?? "운동"}을(를) 루틴에서 뺐어요`);
    },
    onError: (error) => void handleEditError(error, "remove"),
  });

  const swapMutation = useMutation({
    networkMode: "always",
    mutationFn: async (params: { from: string; to: string }) => {
      if (!session) throw new Error("세션을 불러오지 못했어요.");
      const replaced = session.planned_sets.filter((set) => set.exercise_id === params.from);
      if (replaced.length === 0) throw new Error("교체할 운동을 찾지 못했어요.");
      const provisional = provisionalSets(params.to, replaced.length);
      const firstIndex = session.planned_sets.findIndex((set) => set.exercise_id === params.from);
      const without = session.planned_sets.filter((set) => set.exercise_id !== params.from);
      const planned_sets = [...without];
      planned_sets.splice(firstIndex, 0, ...provisional.sets);
      const updated = await commitRoutineEdit(
        { ...session, planned_sets },
        provisional.correlations,
      );
      return { updated, params };
    },
    onSuccess: ({ updated, params }) => {
      applySession(updated);
      setPicker(null);
      setNotice(`${catalogById.get(params.to)?.name_ko ?? "운동"}으로 바꿨어요`);
    },
    onError: (error) => void handleEditError(error, "swap"),
  });

  const completeMutation = useMutation({
    networkMode: "always",
    mutationFn: async (pain: number | null) => {
      const clientId = newClientId();
      const updatedAt = new Date().toISOString();
      await commitSessionCompletion(
        DEV_USER_SCOPE,
        sessionId,
        pain == null ? {} : { pain },
        clientId,
        updatedAt,
      );
      // The local transaction is the success boundary. Offline completion remains visible and retriable.
      let synced = null;
      try {
        synced = await requestForegroundSync();
      } catch {
        // The local commit already succeeded. Keep the outbox row for the next foreground trigger.
      }
      const change = synced?.changes.find(
        (item) => item.entity === "session" && item.entity_id === sessionId && item.data,
      );
      const recommendations = (change?.data as { next_recommendations?: unknown } | undefined)
        ?.next_recommendations;
      return {
        session: {
          ...(sessionQuery.data ?? ({ id: sessionId } as Session)),
          status: "completed",
        } as Session,
        // D-39: 서버가 gate_state와 nullable recommendation을 결정한다. 웹은 재판정하지 않는다.
        next_recommendations: Array.isArray(recommendations)
          ? (recommendations as GatedRecommendation[])
          : [],
        offline: synced === null,
      };
    },
    onSuccess: (data) => {
      setFinishOpen(false);
      setFinishError(null);
      setSummary(data as CompleteResponse);
      if ((data as { offline?: boolean }).offline)
        setNotice("운동을 기기에 저장했어요. 온라인이 되면 동기화돼요.");
      // 종료(또는 재종료)로 상태·추천이 바뀐다 → 세션 캐시를 응답으로 갱신하고 대시보드는 다시 받는다.
      queryClient.setQueryData(["session", sessionId], data.session);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => setFinishError(errorMessage(error, "complete")),
  });

  const handleComplete = async (exerciseName: string, set: PlannedSet, values: SetValues) => {
    try {
      await completeSetInStore(set.id, values);
    } catch {
      setNotice("기록을 저장하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    setNotice(`${set.set_no}세트 완료`);
    setRest({
      plannedSetId: set.id,
      title: `${exerciseName} ${set.set_no}세트 후 휴식`,
      timer: startRest(set.rest_sec, Date.now()),
    });
  };

  const handleUncomplete = async (set: PlannedSet) => {
    try {
      await uncompleteSetInStore(set.id);
    } catch {
      setNotice("기록을 저장하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    // 해제한 세트의 타이머가 떠 있으면 함께 닫는다.
    setRest((previous) => (previous?.plannedSetId === set.id ? null : previous));
    setExpandedSetId((previous) => (previous === set.id ? null : previous));
  };

  /**
   * 완료 세트의 값 수정(AC-SET-7). 완료 상태를 그대로 두고 기록만 갈아 끼운다 —
   * **휴식 타이머를 열지 않는다**(§2.4.3: 타이머는 "완료 체크" 시점에만 연다).
   */
  const handleEdit = async (set: PlannedSet, values: SetValues) => {
    try {
      await completeSetInStore(set.id, values);
    } catch {
      setNotice("기록을 저장하지 못했어요. 다시 시도해 주세요.");
    }
  };

  /** 휴식 종료 → 다음 미완료 세트의 첫 입력칸으로 포커스를 옮긴다(§7.1). */
  const closeRest = () => {
    const from = rest?.plannedSetId;
    setRest(null);
    if (!from) return;

    const index = orderedSets.findIndex((set) => set.id === from);
    const next = orderedSets.slice(index + 1).find((set) => !drafts[set.id]?.completed);
    window.setTimeout(() => {
      const target = next
        ? document.getElementById(
            primaryInputId(
              next,
              setKind(
                next,
                catalogById.get(next.exercise_id)?.metric,
                catalogById.get(next.exercise_id)?.step_kg,
              ),
            ),
          )
        : document.querySelector<HTMLElement>(`[data-set-check="${from}"]`);
      target?.focus();
    }, 20);
  };

  if (sessionQuery.isPending) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 p-4">
        <p className="sr-only">오늘 루틴을 불러오는 중이에요.</p>
        {[0, 1].map((index) => (
          <Card key={index} aria-hidden="true" className="h-48 animate-pulse bg-raised" />
        ))}
      </div>
    );
  }

  if (sessionQuery.isError || !session) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-3 p-4">
        <p role="alert" className="text-base text-fg">
          {errorMessage(sessionQuery.error, "session")}
        </p>
        <Button size="md" onClick={() => void sessionQuery.refetch()}>
          다시 불러오기
        </Button>
      </div>
    );
  }

  if (summary) {
    return (
      <div className="mx-auto max-w-md p-4">
        <SessionSummary
          completedCount={completedCount}
          totalVolume={totalVolume}
          nextRecommendations={summary.next_recommendations}
          catalogById={catalogById}
          /* F6-1: 오늘이면 종료 후에도 돌아가서 더 하거나 고칠 수 있다. */
          onResume={isUtcToday(summary.session.scheduled_date) ? () => setSummary(null) : undefined}
        />
      </div>
    );
  }

  const removeIndex = groups.findIndex((group) => group.exerciseId === removeExerciseId);
  const inRoutine = new Set(groups.map((group) => group.exerciseId));

  // 통증 보고(안전 절): 운동 단위로 받아 그 운동의 세트 드래프트에 담는다.
  const painIndex = groups.findIndex((group) => group.exerciseId === painExerciseId);
  const painGroup = painIndex >= 0 ? groups[painIndex] : null;
  const painSetIds = painGroup?.sets.map((set) => set.id) ?? [];
  /** [무게 줄이고 계속]이 향할 곳: 아직 남은 세트 중 무게 입력이 있는 첫 세트. */
  const painWeightTarget = painGroup?.sets.find(
    (set) =>
      !drafts[set.id]?.completed &&
      hasWeightInput(
        setKind(
          set,
          catalogById.get(set.exercise_id)?.metric,
          catalogById.get(set.exercise_id)?.step_kg,
        ),
      ),
  );

  return (
    <>
      {/* 랜드마크 <main> 과 스킵 링크는 app/layout.tsx 에 하나씩만 둔다(중복 금지). */}
      {/* pb-28 = 하단 고정 바(버튼 72 + 패딩 24)를 가릴 만큼만 비운다. */}
      <div inert={modalOpen} className="mx-auto flex max-w-md flex-col gap-3 p-4 pb-28">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-bold text-fg">오늘 운동</h1>
          <p className="text-sm text-fg-muted">
            {completedCount}세트 완료 · 계획 {orderedSets.length}세트
          </p>
          {readOnly ? <p className="text-sm text-fg-muted">이미 종료한 운동이에요.</p> : null}
          {/* 이미 종료한 운동을 고치는 중이라는 맥락을 계속 보여준다(F6-1 재개/편집 모드). */}
          {finishedToday ? (
            /* "지금 편집 모드"를 알리는 면이라 primary 소프트로 둔다(§2.3 파랑 = 지금·계획과 다름).
               `bg-raised` 단독은 페이지 `bg` 와 1.05:1 이라 상자가 사실상 안 보였다 —
               면을 만드는 건 1px 테두리다(Badge.tsx). 대비: fg 15:1 / fg-muted 5.03:1. */
            <div className="flex flex-col gap-1 rounded-control border border-primary-border bg-primary-bg px-3 py-2">
              <p className="text-sm text-fg">
                이미 종료한 운동이에요. 오늘 안에는 기록을 더하거나 고칠 수 있어요.
              </p>
              {/* 고친 값이 언제 추천에 반영되는지 알려 준다(재계산은 종료 경로에서 돈다). */}
              <p className="text-sm text-fg-muted">
                고친 내용은 [수정 마치기]를 눌러야 오늘 기록에 반영돼요.
              </p>
            </div>
          ) : null}
        </header>

        {catalogQuery.isError ? (
          <Card className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-fg">
              {errorMessage(catalogQuery.error, "catalog")}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void catalogQuery.refetch()}>
              다시 시도
            </Button>
          </Card>
        ) : null}

        {editError ? (
          /* 배지와 같은 소프트 어법(면 `*-bg` + 글자 `*` + 1px `*-border`, Badge.tsx). danger 5.61:1. */
          <p
            role="alert"
            className="rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger"
          >
            {editError}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          {groups.length === 0 ? (
            <Card className="flex flex-col gap-3">
              <p className="text-base text-fg">
                오늘 루틴이 비어 있어요. 하고 싶은 운동을 추가해 보세요.
              </p>
            </Card>
          ) : !catalogResolved ? (
            /* 이름을 카탈로그에서만 얻으므로, 도착 전에는 임시 이름 대신 스켈레톤을 세운다(§2.4). */
            <>
              <p className="sr-only">운동 목록을 불러오는 중이에요.</p>
              {groups.map((group) => (
                <Card
                  key={group.exerciseId}
                  aria-hidden="true"
                  className="h-48 animate-pulse bg-raised"
                />
              ))}
            </>
          ) : (
            groups.map((group, index) => {
              const locked = group.sets.some((set) => drafts[set.id]?.completed);
              return (
                <ExerciseCard
                  key={group.exerciseId}
                  name={nameOf(group.exerciseId, index)}
                  exercise={catalogById.get(group.exerciseId) ?? null}
                  sets={group.sets}
                  drafts={drafts}
                  readOnly={readOnly}
                  lockedReason={locked ? LOCKED_REASON : null}
                  painScore={painOf(
                    drafts,
                    group.sets.map((set) => set.id),
                  )}
                  expandedSetId={expandedSetId}
                  onToggleExpand={(plannedSetId) =>
                    setExpandedSetId((previous) =>
                      previous === plannedSetId ? null : plannedSetId,
                    )
                  }
                  onEdit={(set, values) => void handleEdit(set, values)}
                  onSwap={() => {
                    setEditError(null);
                    setPicker({ type: "swap", exerciseId: group.exerciseId });
                  }}
                  onRemove={() => {
                    setEditError(null);
                    setRemoveExerciseId(group.exerciseId);
                  }}
                  onRemoveBlocked={() => setNotice(LOCKED_REASON)}
                  onReportPain={() => setPainExerciseId(group.exerciseId)}
                  onComplete={(set, values) =>
                    void handleComplete(nameOf(group.exerciseId, index), set, values)
                  }
                  onUncomplete={(set) => void handleUncomplete(set)}
                />
              );
            })
          )}

          {readOnly || !catalogResolved ? null : (
            <Button
              variant="secondary"
              size="md"
              fullWidth
              onClick={() => {
                setEditError(null);
                setPicker({ type: "add" });
              }}
            >
              운동 추가
            </Button>
          )}
        </div>

        <p role="status" className="sr-only">
          {notice}
        </p>
      </div>

      {readOnly ? null : (
        <div
          inert={modalOpen}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface px-4 py-3"
        >
          <div className="mx-auto max-w-md pb-safe-bottom">
            <Button
              size="lg"
              fullWidth
              onClick={() => {
                setFinishError(null);
                setFinishOpen(true);
              }}
            >
              {finishedToday ? "수정 마치기" : "운동 종료"}
            </Button>
          </div>
        </div>
      )}

      {/* 타이머 시트는 열려 있을 때만 마운트해서 틱을 멈춘다. */}
      {rest ? (
        <RestTimerSheet
          open
          title={rest.title}
          timer={rest.timer}
          onChange={(timer) => setRest({ ...rest, timer })}
          onClose={closeRest}
        />
      ) : null}

      <RemoveExerciseSheet
        open={removeExerciseId != null}
        exerciseName={
          removeIndex >= 0 ? nameOf(groups[removeIndex].exerciseId, removeIndex) : "운동"
        }
        pending={removeMutation.isPending}
        errorText={editError}
        onRemove={() => removeExerciseId && removeMutation.mutate(removeExerciseId)}
        onClose={() => setRemoveExerciseId(null)}
      />

      {picker ? (
        <ExercisePickerSheet
          open
          mode={picker}
          catalog={catalog}
          inRoutine={inRoutine}
          pending={addMutation.isPending || swapMutation.isPending}
          errorText={editError}
          onSelect={(exerciseId) => {
            if (picker.type === "add") addMutation.mutate(exerciseId);
            else swapMutation.mutate({ from: picker.exerciseId, to: exerciseId });
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}

      {painGroup ? (
        <PainSheet
          open
          exerciseName={nameOf(painGroup.exerciseId, painIndex)}
          score={painOf(drafts, painSetIds)}
          swapBlockedReason={
            painGroup.sets.some((set) => drafts[set.id]?.completed) ? LOCKED_REASON : null
          }
          canReduceWeight={painWeightTarget != null}
          onSelect={(score) => {
            void reportPainInStore(painSetIds, score)
              .then(() =>
                setNotice(score == null ? "통증 기록을 지웠어요" : `통증 ${score}점을 기록했어요`),
              )
              .catch(() => setNotice("기록을 저장하지 못했어요. 다시 시도해 주세요."));
          }}
          onSwap={() => {
            setEditError(null);
            setPicker({ type: "swap", exerciseId: painGroup.exerciseId });
            setPainExerciseId(null);
          }}
          onReduceWeight={() => {
            const target = painWeightTarget;
            setPainExerciseId(null);
            if (!target) return;
            window.setTimeout(
              () => document.getElementById(`set-${target.id}-weight`)?.focus(),
              20,
            );
          }}
          onClose={() => setPainExerciseId(null)}
        />
      ) : null}

      <FinishSheet
        open={finishOpen}
        resumed={finishedToday === true}
        completedCount={completedCount}
        remainingCount={orderedSets.length - completedCount}
        pending={completeMutation.isPending}
        errorText={finishError}
        onConfirm={(pain) => completeMutation.mutate(pain)}
        onClose={() => setFinishOpen(false)}
      />
    </>
  );
}
