/**
 * 데일리 루틴 화면(F1~F7). 오늘 세션을 운동 단위로 그리고, 세트 로깅·휴식 타이머·
 * 루틴 편집·운동 종료를 조율한다. 계산·판정은 전부 옆 모듈(순수 함수)에 있다.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { emitRestCompleteFeedback, unlockRestFeedback } from "../../lib/rest-feedback";
import { notifyRestComplete } from "../../lib/rest-notification";
import { createRestCompletionGate } from "../../lib/rest-completion";
import {
  createRestoreCoordinator,
  restTimerStore,
  restoreRestTimer,
  type RestoreCoordinator,
} from "./rest-timer-store";
import { isUtcToday, utcDateString } from "../../lib/utc-day";
import { Button, Card } from "../ui";
import { ExerciseCard } from "./ExerciseCard";
import { ExercisePickerSheet, type PickerMode } from "./ExercisePickerSheet";
import { RemoveExerciseSheet } from "./RemoveExerciseSheet";
import { FinishSheet } from "./FinishSheet";
import { PainSheet } from "./PainSheet";
import { RestTimerSheet } from "./RestTimerSheet";
import { SessionSummary } from "./SessionSummary";
import { primaryInputId } from "./SetRow";
import {
  clearPositionInTransaction,
  readPosition,
  savePosition,
  resolveSessionPosition,
  resolvePositionAlias,
  type PositionRecord,
  type SessionPosition,
} from "./session-position";
import { SESSION_COMPLETED, errorMessage, isConflict, shouldRefetch } from "./errors";
import { fetchAllExercises } from "./exercise-catalog";
import { hasWeightInput, setKind, type SetValues } from "./set-rules";
import { newClientId, painOf, summarize, useSessionLog, type SetDraft } from "./session-store";
import {
  commitRoutineSnapshot,
  commitSessionCompletion,
  DEV_USER_SCOPE,
  readThroughSession,
  readMirroredSession,
  safeMappings,
  sessionDb,
  type RoutineCorrelation,
} from "./session-db";
import {
  PLANNED_SET_MAPPING_EVENT,
  requestForegroundSync,
  SYNC_RESPONSE_EVENT,
  type SyncResponseEventDetail,
} from "./sync-coordinator";
import {
  readAppendCompletions,
  readAppendState,
  commitSessionSetAppend,
  AppendCreationError,
  type AppendState,
} from "./session-set-append-db";
import {
  assessAppend,
  captureAppendSource,
  overlayAppends,
  type AppendContext,
  type CapturedAppendSource,
} from "./session-set-append";

type CompleteResponse = {
  session: Session;
  next_recommendations: GatedRecommendation[];
};

type RestState = { plannedSetId: string; title: string; timer: RestTimer };

/**
 * 저장분을 지우지 못했을 때의 안내. **조용히 넘어가면 안 된다** — 새로고침에서 닫은 타이머가
 * 다시 열려 화면을 가린다(실제 Chromium E2E 에서 재현됐다).
 */
const CLEAR_FAILED_NOTICE = "휴식 타이머를 정리하지 못했어요. 다시 시도해 주세요.";
const APPEND_ELIGIBILITY_MISSING = "세트를 추가할 수 있는지 확인하지 못했어요. 다시 불러와 주세요.";
const APPEND_BLOCKED = "이 운동은 지금 세트를 추가할 수 없어요.";

const LOCKED_REASON = "기록이 있는 운동이라 빼거나 바꿀 수 없어요. 완료 체크를 해제해 주세요.";

/** Summary is a read projection: authoritative facts fill only missing local records. */
function summaryMetricsFor(sets: readonly PlannedSet[], drafts: Record<string, SetDraft>) {
  let completedCount = 0;
  let totalVolume = 0;
  for (const set of sets) {
    const actual = drafts[set.id] ?? set.performed_set;
    if (actual?.completed !== true) continue;
    completedCount += 1;
    if (set.load_kind === "external" && actual.actual_weight != null && actual.actual_reps != null)
      totalVolume += actual.actual_weight * actual.actual_reps;
  }
  return { completedCount, totalVolume };
}

/**
 * 매핑 결과를 화면 캐시에 합성한다. **미러와 같은 fail-closed 경계를 쓴다** —
 * 여기서 걸러내지 않으면 미러에 못 들어간 처방이 화면에는 그대로 보인다.
 */
export function mappedSession(
  session: Session,
  mappings: SyncResponse["planned_set_mappings"],
): Session {
  if (mappings.length === 0) return session;
  const safe = new Map(safeMappings(mappings).map((mapping) => [mapping.correlation_id, mapping]));
  const all = new Map(mappings.map((mapping) => [mapping.correlation_id, mapping]));
  return {
    ...session,
    planned_sets: session.planned_sets.map((set) => {
      const mapping = all.get(set.id);
      if (!mapping) return set;
      const trusted = safe.get(set.id);
      // 처방은 안전할 때만 받는다. 안전하지 않아도 **id 는 옮긴다** —
      // 미러·draft·outbox 가 이미 server id 를 쓰므로 화면만 correlation 에 남으면 기록이 사라진다.
      return trusted ? trusted.planned_set : { ...set, id: mapping.planned_set_id };
    }),
  };
}

/**
 * 편집 충돌 뒤 authoritative 재조회.
 *
 * **`queryClient.fetchQuery` 를 쓰면 안 된다** — 성공 응답을 predicate 보다 **먼저** 캐시에 넣기 때문에
 * unsafe payload 가 그 순간 화면에 뜬다(독립 재리뷰 P1-1). 그래서 네트워크는 QueryClient 밖에서 받고,
 * 공통 경계를 통과한 값만 `setQueryData` 로 넣는다.
 */
export async function refetchAuthoritativeSession(
  queryClient: QueryClient,
  sessionId: string,
  fetchSession: () => Promise<Session>,
): Promise<Session | null> {
  const fetched = await readThroughSession(DEV_USER_SCOPE, sessionId, fetchSession, {
    offlineFallback: false,
  }).catch(() => null);
  if (!fetched) return null;
  queryClient.setQueryData<Session>(["session", sessionId], fetched);
  return fetched;
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const storedDrafts = useSessionLog((state) => state.drafts);
  const draftSessionId = useSessionLog((state) => state.sessionId);
  const drafts = useMemo(
    () => (draftSessionId === sessionId ? storedDrafts : {}),
    [draftSessionId, sessionId, storedDrafts],
  );
  const begin = useSessionLog((state) => state.begin);
  const completeSetInStore = useSessionLog((state) => state.completeSet);
  const uncompleteSetInStore = useSessionLog((state) => state.uncompleteSet);
  const reportPainInStore = useSessionLog((state) => state.reportPain);
  const remapPlannedSetsInStore = useSessionLog((state) => state.remapPlannedSets);
  const refreshDraftsFromMirror = useSessionLog((state) => state.refreshFromMirror);

  const [rest, setRest] = useState<RestState | null>(null);
  /** 펼쳐 둔 완료 세트. 한 번에 하나만 펼친다(AC-SET-8) → 화면 전체에서 값 하나로 관리한다. */
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);
  const [focusExpandedSetId, setFocusExpandedSetId] = useState<string | null>(null);
  const [activePosition, setActivePosition] = useState<SessionPosition | null>(null);
  const [positionHydration, setPositionHydration] = useState<{
    sessionId: string;
    record: PositionRecord;
  } | null>(null);
  const positionScope = useRef<{
    sessionId: string;
    intent: number;
    restored: boolean;
    read: Promise<PositionRecord>;
  } | null>(null);
  const [editingCompleted, setEditingCompleted] = useState(false);
  const [removeExerciseId, setRemoveExerciseId] = useState<string | null>(null);
  const [painExerciseId, setPainExerciseId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [pickerReturnFocusTarget, setPickerReturnFocusTarget] = useState<HTMLElement | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [summary, setSummary] = useState<CompleteResponse | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [appendFocus, setAppendFocus] = useState<{
    sessionId: string;
    plannedId: string;
    intent: number;
  } | null>(null);

  useEffect(() => {
    const scope = {
      sessionId,
      intent: 0,
      restored: false,
      read: readPosition(DEV_USER_SCOPE, sessionId),
    };
    positionScope.current = scope;
    setActivePosition(null);
    setExpandedSetId(null);
    setFocusExpandedSetId(null);
    setSummary(null);
    setFinishOpen(false);
    setEditingCompleted(false);
    void Promise.all([scope.read, begin(sessionId)])
      .then(([record]) => {
        if (positionScope.current === scope) setPositionHydration({ sessionId, record });
      })
      .catch(() => undefined);
    return () => {
      if (positionScope.current === scope) positionScope.current = null;
    };
  }, [sessionId, begin]);

  const rememberPosition = (set: PlannedSet, expanded = expandedSetId === set.id) => {
    const scope = positionScope.current;
    if (!scope || scope.sessionId !== sessionId) return;
    const intent = ++scope.intent;
    const position = { exercise_id: set.exercise_id, planned_set_id: set.id, expanded };
    setActivePosition(position);
    void readPosition(DEV_USER_SCOPE, sessionId)
      .then((record) => savePosition(DEV_USER_SCOPE, sessionId, position, record.generation))
      .then((saved) => {
        if (saved && positionScope.current === scope && scope.intent === intent)
          setActivePosition(saved.position);
      })
      .catch(() => setNotice("화면 위치를 저장하지 못했어요. 다시 시도해 주세요."));
  };

  useEffect(() => {
    const onMapping = (event: Event) => {
      const mappings = (event as CustomEvent<SyncResponse["planned_set_mappings"]>).detail;
      if (!Array.isArray(mappings) || mappings.length === 0) return;
      remapPlannedSetsInStore(mappings);
      setAppendFocus((previous) =>
        previous
          ? {
              ...previous,
              plannedId:
                mappings.find((mapping) => mapping.correlation_id === previous.plannedId)
                  ?.planned_set_id ?? previous.plannedId,
            }
          : null,
      );
      setExpandedSetId((id) => mappings.find((m) => m.correlation_id === id)?.planned_set_id ?? id);
      setFocusExpandedSetId(null);
      setActivePosition((position) => {
        const moved = mappings.find((m) => m.correlation_id === position?.planned_set_id);
        return position && moved ? { ...position, planned_set_id: moved.planned_set_id } : position;
      });

      /**
       * **타이머의 세트 정체성도 함께 승격한다.**
       *
       * 오프라인에서 추가한 세트는 correlation id 를 그대로 planned-set id 로 쓴다. `/sync` 가
       * 서버 id 를 주면 draft·캐시는 옮겨 가는데 타이머만 옛 id 를 들고 있으면 ① reload 때
       * authoritative 세트 목록과 안 맞아 **타이머가 지워지고** ② 휴식을 닫을 때 다음 세트를
       * 찾지 못해 포커스가 어긋나고 ③ 서버 id 로 완료를 취소해도 같은 세트로 인식하지 못한다.
       *
       * 저장된 레코드는 세션 큐 안에서 원자적으로 옮기고(다른 세트 것은 store 가 대조해 보존),
       * 화면의 것은 여기서 옮긴다.
       */
      for (const mapping of mappings) {
        void restTimerStore.remap(sessionId, mapping.correlation_id, mapping.planned_set_id);
      }
      setRest((previous) => {
        if (!previous) return previous;
        const moved = mappings.find((mapping) => mapping.correlation_id === previous.plannedSetId);
        return moved ? { ...previous, plannedSetId: moved.planned_set_id } : previous;
      });

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
    // The query owns its durable fallback; an offline pause would prevent reading it.
    networkMode: "always",
    queryFn: ({ signal }) =>
      readThroughSession<Session>(DEV_USER_SCOPE, sessionId, () => api.session(sessionId, signal)),
  });

  const catalogQuery = useQuery({
    queryKey: ["exercises"],
    queryFn: fetchAllExercises,
    networkMode: "always",
    staleTime: Infinity,
  });

  const session = sessionQuery.data;
  const appendCompletionQuery = useQuery({
    queryKey: ["append-completion", sessionId],
    networkMode: "always",
    queryFn: () => readAppendCompletions({ user_id: DEV_USER_SCOPE, session_id: sessionId }),
  });
  const completionWaiting = (appendCompletionQuery.data?.length ?? 0) > 0;
  const completionReady = appendCompletionQuery.isSuccess;
  const appendStateQuery = useQuery({
    queryKey: ["session-append", sessionId],
    networkMode: "always",
    queryFn: () => readAppendState({ user_id: DEV_USER_SCOPE, session_id: sessionId }),
  });

  const restoreRef = useRef<RestoreCoordinator | null>(null);
  restoreRef.current ??= createRestoreCoordinator();

  /**
   * **휴식 완료 게이트의 장부는 여기 있다.** 시트는 휴식마다 마운트/언마운트되므로 그 안에 두면
   * 장부가 휴식보다 먼저 죽어, 닫았다 다시 열린 같은 휴식이 또 울린다.
   * 정체성에 `sessionId` 가 들어가므로 화면이 세션을 갈아타도 서로 섞이지 않는다.
   */
  const completionGateRef = useRef<ReturnType<typeof createRestCompletionGate> | null>(null);
  completionGateRef.current ??= createRestCompletionGate({
    emitForeground: emitRestCompleteFeedback,
    notifyHidden: notifyRestComplete,
  });

  /**
   * **진행 중인 복구를 무효화하고 화면 타이머를 내린다.** 사용자가 무언가 한 순간마다 부른다.
   *
   * 이게 없으면 늦게 도착한 복구가 "화면이 비어 있으니 올려도 되겠다"고 판단해 **사용자가 방금
   * 닫았거나 취소한 타이머를 되살린다.**
   */
  const dropRest = useCallback(() => {
    restoreRef.current?.invalidate();
    setRest(null);
  }, []);

  useEffect(() => {
    let current = true;
    let sequence = 0;
    let completionIntent: number | null = null;
    const sourceChanges = new Set<string>();
    const reconcile = async (scope: typeof positionScope.current) => {
      const ticket = ++sequence;
      const intent = scope?.intent;
      const [mirror, waiting, appendState] = await Promise.all([
        readMirroredSession<Session>(DEV_USER_SCOPE, sessionId),
        readAppendCompletions({ user_id: DEV_USER_SCOPE, session_id: sessionId }),
        readAppendState({ user_id: DEV_USER_SCOPE, session_id: sessionId }),
      ]);
      if (!current || positionScope.current !== scope) return;
      await refreshDraftsFromMirror(sessionId);
      if (!current || positionScope.current !== scope || ticket !== sequence) return;
      const changedSources = appendState.entries.filter(
        (entry) =>
          sourceChanges.has(entry.intent.transport.client_id) &&
          entry.execution.reason === "source_changed",
      );
      if (changedSources.length) {
        changedSources.forEach((entry) => sourceChanges.delete(entry.intent.transport.client_id));
        await refetchAuthoritativeSession(queryClient, sessionId, () => api.session(sessionId));
        if (!current || positionScope.current !== scope) return;
        if (scope?.intent === intent)
          setEditError(errorMessage(new ApiError(409, "", ""), "session"));
        // The original blocked intent is durable. Reconcile the freshly read cohort;
        // a successful GET is neither an append retry nor an ACK.
        void reconcile(scope).catch(() => undefined);
        return;
      }
      // A new gesture may have committed another append/draft while either read was pending.
      // Re-read current durable state; only the old receipt's UI reset loses authority.
      if (scope?.intent !== intent) {
        void reconcile(scope).catch(() => undefined);
        return;
      }
      queryClient.setQueryData(["append-completion", sessionId], waiting);
      queryClient.setQueryData(["session-append", sessionId], appendState);
      if (mirror) queryClient.setQueryData(["session", sessionId], mirror);
      if (completionIntent !== null) {
        if (scope?.intent === completionIntent) {
          scope.intent++;
          setFinishOpen(false);
          setFinishError(null);
          setEditingCompleted(false);
          setActivePosition(null);
          setExpandedSetId(null);
          setFocusExpandedSetId(null);
          dropRest();
          if (mirror) setSummary({ session: mirror, next_recommendations: [] });
        } else {
          setEditingCompleted(true);
          setSummary(null);
        }
        completionIntent = null;
        void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
    };
    const onCommit = (event: Event) => {
      const detail = (event as CustomEvent<SyncResponseEventDetail>).detail;
      if (!detail.local_session_ids?.includes(sessionId)) return;
      for (const conflict of detail.conflicts)
        if (conflict.reason === "source_changed") sourceChanges.add(conflict.client_id);
      const scope = positionScope.current;
      if (detail.completed_session_ids?.includes(sessionId))
        completionIntent = scope?.intent ?? null;
      void reconcile(scope).catch(() => undefined);
    };
    window.addEventListener(SYNC_RESPONSE_EVENT, onCommit);
    return () => {
      current = false;
      window.removeEventListener(SYNC_RESPONSE_EVENT, onCommit);
    };
  }, [sessionId, queryClient, refreshDraftsFromMirror, dropRest]);

  /**
   * 시트의 종료 관측에 **세션·세트 정체성**을 붙여 게이트로 넘긴다.
   *
   * 참조가 안정적이어야 한다 — 매 렌더 새 함수를 주면 시트의 이펙트가 매번 다시 돌아
   * 200ms 틱마다 관측이 쏟아진다(게이트가 삼키긴 하지만 그건 방어지 설계가 아니다).
   */
  const restPlannedSetId = rest?.plannedSetId;
  const handleCompletionObserved = useCallback(
    (observation: { finished: boolean; endsAt: number; visibleSince: number | null }) => {
      if (restPlannedSetId === undefined) return;
      completionGateRef.current?.({ ...observation, sessionId, plannedSetId: restPlannedSetId });
    },
    [sessionId, restPlannedSetId],
  );

  /**
   * 세션 전환은 **authoritative 질의보다 먼저** 세대를 올린다. 질의가 끝나기를 기다리면
   * 그 사이에 도착한 앞 세션의 복구 결과가 새 화면에 얹힌다.
   * 언마운트도 같다 — 사라진 화면에 결과를 밀어 넣지 않는다.
   */
  useEffect(() => {
    dropRest();
    return () => restoreRef.current?.invalidate();
  }, [sessionId, dropRest]);

  /**
   * 저장된 휴식 타이머 복구. **authoritative 세션이 준비된 뒤 세션마다 한 번씩** 시도한다.
   *
   * 만료된 타이머도 그대로 올린다 — 0 으로 보여 주고 자동으로 닫지 않는 것이 계약이다(§4.7).
   */
  useEffect(() => {
    const coordinator = restoreRef.current;
    // 세션 데이터가 지금 보고 있는 세션 것인지 먼저 확인한다(prop 이 앞서 바뀔 수 있다).
    if (!coordinator || !session || session.id !== sessionId || rest) return;
    const token = coordinator.begin(sessionId);
    if (!token) return;

    /**
     * **자격은 durable 사실이 정한다.** 세트가 목록에 있다는 것만으로는 부족하다 —
     * 완료를 취소했는데 저장분 삭제가 실패했다면 그 세트의 휴식은 다시 뜨면 안 되고,
     * 종료된 세션은 어떤 타이머도 올리지 않는다.
     *
     * 사실은 둘이다: durable 로컬 의사(`drafts.completed`)가 있으면 그쪽이 이기고, 없으면
     * 이 authoritative payload 를 쓴다. 둘과 타이머를 **한 트랜잭션에서** 읽는 것은 store 의 몫이다.
     */
    void restoreRestTimer(coordinator, token, session, Date.now(), (stored) => {
      // 복구를 기다리는 사이 사용자가 새 세트를 끝냈으면 그쪽이 최신이다 — 덮지 않는다.
      setRest((previous) => previous ?? stored);
    });
  }, [session, sessionId, rest]);

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
  useEffect(() => {
    if (!appendFocus || appendFocus.sessionId !== sessionId) return;
    const scope = positionScope.current;
    if (scope?.intent !== appendFocus.intent) {
      setAppendFocus(null);
      return;
    }
    const set = orderedSets.find((row) => row.id === appendFocus.plannedId);
    if (!set) return;
    const exercise = catalogById.get(set.exercise_id);
    const input = document.getElementById(
      primaryInputId(set, setKind(set, exercise?.metric, exercise?.step_kg)),
    );
    if (!input) return;
    input.focus();
    input.scrollIntoView?.({ block: "center" });
    setAppendFocus(null);
  }, [appendFocus, sessionId, orderedSets, catalogById]);
  useEffect(() => {
    if (
      !rest ||
      !session ||
      session.id !== sessionId ||
      sessionQuery.isFetching ||
      sessionQuery.isError ||
      orderedSets.some((set) => set.id === rest.plannedSetId)
    )
      return;
    let cancelled = false;
    void sessionDb
      .transaction("r", sessionDb.syncMeta, () =>
        resolvePositionAlias(DEV_USER_SCOPE, sessionId, rest.plannedSetId),
      )
      .then(async (id) => {
        if (cancelled || orderedSets.some((set) => set.id === id)) return;
        if (await restTimerStore.clearForPlannedSet(sessionId, rest.plannedSetId)) {
          if (!cancelled) dropRest();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    rest,
    session,
    sessionId,
    sessionQuery.isFetching,
    sessionQuery.isError,
    orderedSets,
    dropRest,
  ]);
  /**
   * 카탈로그가 도착했거나(성공) 끝내 실패했을 때만 운동 카드를 그린다.
   * 실패하면 이름을 알 방법이 없으므로 순번 이름으로 낮춰서라도 기록은 계속할 수 있게 둔다
   * (배너 + [다시 시도] 가 위에 함께 보인다, E-21).
   */
  const catalogResolved = catalogQuery.isSuccess || catalogQuery.isError;
  useEffect(() => {
    const scope = positionScope.current;
    if (
      !scope ||
      scope.restored ||
      !session ||
      session.id !== sessionId ||
      sessionQuery.isError ||
      !catalogResolved ||
      !completionReady ||
      completionWaiting ||
      positionHydration?.sessionId !== sessionId
    )
      return;
    if (scope.intent > 0) return;
    if (session.status === "completed" && !editingCompleted) return;
    let cancelled = false;
    const stored = positionHydration.record.position;
    void sessionDb
      .transaction("r", sessionDb.syncMeta, async () =>
        stored
          ? {
              ...stored,
              planned_set_id: await resolvePositionAlias(
                DEV_USER_SCOPE,
                sessionId,
                stored.planned_set_id,
              ),
            }
          : null,
      )
      .then((position) => {
        if (cancelled || positionScope.current !== scope || scope.intent > 0) return;
        scope.restored = true;
        const resolved = resolveSessionPosition(
          position,
          orderedSets,
          new Map(Object.values(drafts).map((draft) => [draft.planned_set_id, draft.completed])),
        );
        setActivePosition(resolved);
        setExpandedSetId(resolved?.expanded ? resolved.planned_set_id : null);
        if (!resolved && (orderedSets.length > 0 || position !== null) && !editingCompleted) {
          setSummary({ session, next_recommendations: [] });
          return;
        }
        if (resolved)
          document
            .getElementById(`session-set-${resolved.planned_set_id}`)
            ?.scrollIntoView?.({ block: "center" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    session,
    sessionId,
    sessionQuery.isError,
    catalogResolved,
    positionHydration,
    orderedSets,
    drafts,
    editingCompleted,
    completionReady,
    completionWaiting,
  ]);
  useEffect(() => {
    const scope = positionScope.current;
    if (
      !scope?.restored ||
      !completionReady ||
      completionWaiting ||
      !activePosition ||
      !session ||
      session.id !== sessionId ||
      sessionQuery.isFetching ||
      sessionQuery.isError ||
      orderedSets.some((set) => set.id === activePosition.planned_set_id)
    )
      return;
    const intent = scope.intent;
    let cancelled = false;
    void sessionDb
      .transaction("r", sessionDb.syncMeta, () =>
        resolvePositionAlias(DEV_USER_SCOPE, sessionId, activePosition.planned_set_id),
      )
      .then((id) => {
        if (cancelled || positionScope.current !== scope || scope.intent !== intent) return;
        const resolved = resolveSessionPosition(
          { ...activePosition, planned_set_id: id },
          orderedSets,
          new Map(Object.values(drafts).map((draft) => [draft.planned_set_id, draft.completed])),
        );
        setActivePosition(resolved);
        setExpandedSetId(resolved?.expanded ? resolved.planned_set_id : null);
        setFocusExpandedSetId(null);
        if (!resolved) setSummary({ session, next_recommendations: [] });
        if (resolved && resolved.planned_set_id !== id)
          document
            .getElementById(`session-set-${resolved.planned_set_id}`)
            ?.scrollIntoView?.({ block: "center" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activePosition,
    completionReady,
    completionWaiting,
    session,
    sessionId,
    sessionQuery.isFetching,
    sessionQuery.isError,
    orderedSets,
    drafts,
  ]);
  const nameOf = (exerciseId: string, index: number) =>
    catalogById.get(exerciseId)?.name_ko ?? `운동 ${index + 1}`;

  const { completedCount } = summarize(drafts);
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
      const latest = await refetchAuthoritativeSession(queryClient, sessionId, () =>
        api.session(sessionId),
      );
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
    const committed = await commitRoutineSnapshot(
      DEV_USER_SCOPE,
      sessionId,
      exerciseIds,
      clientId,
      new Date().toISOString(),
      correlations,
      next,
      // **출처는 호출 context 가 알려준다** — payload 에 표시를 심지 않는다(재리뷰 P2-1).
      new Set(correlations.map((item) => item.correlation_id)),
    );
    // The local transaction is the offline success boundary. When the browser knows it is online,
    // wait for this mutation's acknowledgement so a server conflict can keep the editor open.
    if (typeof navigator === "undefined" || !navigator.onLine) {
      void requestForegroundSync().catch(() => undefined);
      return committed ?? next;
    }
    let synced: SyncResponse | null = null;
    try {
      synced = await requestForegroundSync();
    } catch {
      // A transport failure does not undo the durable local write; the outbox retries it later.
      return committed ?? next;
    }
    if (synced?.conflicts.some((conflict) => conflict.client_id === clientId))
      throw new ApiError(409, "SYNC_CONFLICT", "routine sync conflict");
    if (synced?.applied.includes(clientId)) {
      const authoritative = await readThroughSession(
        DEV_USER_SCOPE,
        sessionId,
        () => api.session(sessionId),
        { offlineFallback: false },
      ).catch(() => null);
      if (authoritative) return authoritative;
    }
    return committed ?? next;
  };

  const provisionalSets = (exerciseId: string, count: number) => {
    const exercise = catalogById.get(exerciseId);
    if (!exercise) throw new Error("운동 정보를 불러오지 못했어요.");
    const correlations: RoutineCorrelation[] = Array.from({ length: count }, (_, index) => ({
      correlation_id: newClientId(),
      exercise_id: exerciseId,
      set_no: index + 1,
    }));
    // **로컬이 만든 임시 행임을 스스로 밝힌다**(로컬 전용 표시, 서버로 보내지 않는다).
    // 이 표시가 없으면 fail-closed 경계가 "서버가 `load_kind` 를 빠뜨린 행"과 구분하지 못해
    // 오프라인 추가가 통째로 막힌다.
    const sets = buildProvisionalRoutineSets(
      session!.goal,
      exercise,
      correlations.map((item) => item.correlation_id),
    ) as unknown as PlannedSet[];
    return { sets, correlations };
  };

  const appendMutation = useMutation({
    networkMode: "always",
    mutationFn: async (captured: CapturedAppendSource) => {
      const scope = positionScope.current;
      if (!scope || scope.sessionId !== captured.session_id)
        throw new AppendCreationError("scope_mismatch");
      const viewAtCreation = queryClient.getQueryData<Session>(["session", sessionId]);
      const intent = ++scope.intent;
      const identity = {
        client_id: newClientId(),
        correlation_id: newClientId(),
        updated_at: new Date().toISOString(),
      };
      const position = await readPosition(DEV_USER_SCOPE, sessionId);
      if (positionScope.current !== scope) throw new AppendCreationError("scope_mismatch");
      const entry = await commitSessionSetAppend(
        { user_id: DEV_USER_SCOPE, session_id: sessionId },
        {
          exercise_id: captured.exercise_id,
          today: utcDateString(),
          generation: position.generation,
          ...identity,
          captured,
        },
      );
      const mirror = await readMirroredSession<Session>(DEV_USER_SCOPE, sessionId);
      const state = await readAppendState({ user_id: DEV_USER_SCOPE, session_id: sessionId });
      return { entry, mirror, state, scope, intent, sessionId, viewAtCreation };
    },
    onSuccess: ({
      entry,
      mirror,
      state,
      scope,
      intent,
      sessionId: changedSession,
      viewAtCreation,
    }) => {
      // A mapping/GET can settle while creation's local reads are pending. Reconcile
      // the immutable creation with that newer view instead of restoring its old ids.
      const cachedState = queryClient.getQueryData<AppendState>(["session-append", changedSession]);
      const latestState =
        cachedState && cachedState.generation > state.generation ? cachedState : state;
      const currentView = queryClient.getQueryData<Session>(["session", changedSession]);
      const base = currentView && currentView !== viewAtCreation ? currentView : mirror;
      const next = base
        ? {
            ...base,
            planned_sets: overlayAppends(
              { user_id: DEV_USER_SCOPE, session_id: changedSession },
              base.planned_sets,
              latestState.entries,
              latestState.tombstones,
            ).rows as PlannedSet[],
          }
        : null;
      queryClient.setQueryData(["session-append", changedSession], latestState);
      if (next) queryClient.setQueryData(["session", changedSession], next);
      const focusedRow = next?.planned_sets.find(
        (row) =>
          row.exercise_id === entry.provisional.exercise_id &&
          (row.correlation_id === entry.provisional.id || row.id === entry.provisional.id),
      );
      if (positionScope.current === scope && scope.intent === intent && focusedRow) {
        setEditingCompleted(true);
        setSummary(null);
        setEditError(null);
        setExpandedSetId(null);
        setActivePosition({
          exercise_id: entry.provisional.exercise_id,
          planned_set_id: focusedRow.id,
          expanded: false,
        });
        setAppendFocus({ sessionId: changedSession, plannedId: focusedRow.id, intent });
      }
      void requestForegroundSync().catch(() => undefined);
    },
    onError: async (error, captured) => {
      const scope = positionScope.current;
      if (!scope || scope.sessionId !== captured.session_id) return;
      if (error instanceof AppendCreationError) {
        if (["source_changed", "source_removed", "set_number_gap"].includes(error.reason)) {
          // An explicit fresh read accompanies the existing 409 copy; this never retries
          // creation or replaces the captured source/revision with the new maximum.
          await refetchAuthoritativeSession(queryClient, captured.session_id, () =>
            api.session(captured.session_id),
          );
          await appendStateQuery.refetch();
          if (positionScope.current !== scope) return;
          setEditError(errorMessage(new ApiError(409, "", ""), "session"));
        } else {
          setEditError(
            error.reason === "readonly"
              ? "세트는 오늘 운동에만 추가할 수 있어요."
              : error.reason === "set_cap_reached"
                ? "세트 수는 1~10 사이로 정해 주세요."
                : error.reason === "unsafe_assistance_snapshot"
                  ? APPEND_BLOCKED
                  : APPEND_ELIGIBILITY_MISSING,
          );
        }
        return;
      }
      setEditError(errorMessage(error, "session"));
    },
  });

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
      const waiting = (
        await sessionDb.outbox.where("user_id").equals(DEV_USER_SCOPE).toArray()
      ).find(
        (row) =>
          row.entity === "session" &&
          row.entity_id === sessionId &&
          row.append_dependencies &&
          (row.payload.pain ?? null) === pain,
      );
      const clientId = waiting?.client_id ?? newClientId();
      const updatedAt = waiting?.updated_at ?? new Date().toISOString();
      await commitSessionCompletion(
        DEV_USER_SCOPE,
        sessionId,
        pain == null ? {} : { pain },
        clientId,
        updatedAt,
      );
      await queryClient.fetchQuery({
        queryKey: ["append-completion", sessionId],
        // This read is IDB-only; fetchQuery does not inherit the observer's networkMode.
        networkMode: "always",
        queryFn: () => readAppendCompletions({ user_id: DEV_USER_SCOPE, session_id: sessionId }),
      });
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
      /**
       * **세션 종료도 terminal intent 다.** 요약 화면으로 넘어가기 전에 저장분이 실제로
       * 지워졌는지 확인한다 — 여기서 기다리지 않으면 재진입 때 그 타이머가 되살아난다.
       * 종료 자체는 이미 로컬 커밋이 끝났으므로 **되돌리지 않는다**. 실패는 알리기만 한다.
       */
      if (synced?.conflicts.some((conflict) => conflict.client_id === clientId))
        throw new ApiError(409, "SYNC_CONFLICT", "completion sync conflict");
      if ((await sessionDb.outbox.get(clientId))?.append_dependencies)
        throw new Error("append completion is awaiting acknowledgement");
      const timerCleared = await restTimerStore.clear(sessionId);
      await sessionDb.transaction("rw", sessionDb.syncMeta, () =>
        clearPositionInTransaction(DEV_USER_SCOPE, sessionId),
      );

      return {
        timerCleared,
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
      if (positionScope.current?.sessionId !== data.session.id) {
        queryClient.setQueryData(["session", data.session.id], data.session);
        return;
      }
      positionScope.current.intent += 1;
      setFinishOpen(false);
      setFinishError(null);
      setSummary(data as CompleteResponse);
      setActivePosition(null);
      setExpandedSetId(null);
      setEditingCompleted(false);
      // 세션이 끝났으면 그 세션의 휴식은 더 없다. 대기 중인 복구도 함께 무효로 만든다.
      dropRest();
      if (!(data as { timerCleared?: boolean }).timerCleared) setNotice(CLEAR_FAILED_NOTICE);
      else if ((data as { offline?: boolean }).offline)
        setNotice("운동을 기기에 저장했어요. 온라인이 되면 동기화돼요.");
      // 종료(또는 재종료)로 상태·추천이 바뀐다 → 세션 캐시를 응답으로 갱신하고 대시보드는 다시 받는다.
      queryClient.setQueryData(["session", sessionId], data.session);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => setFinishError(errorMessage(error, "complete")),
  });

  const handleComplete = async (exerciseName: string, set: PlannedSet, values: SetValues) => {
    // 휴식 타이머를 여는 유일한 제스처가 여기다. autoplay 정책상 오디오는 제스처 안에서 열어야
    // 하므로 **await 앞에서** 연다 — 저장이 실패해도 무음일 뿐 흐름에는 영향이 없다.
    unlockRestFeedback();
    try {
      await completeSetInStore(set.id, values);
    } catch {
      setNotice("기록을 저장하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    if (positionScope.current?.sessionId !== sessionId) return;
    setNotice(`${set.set_no}세트 완료`);
    rememberPosition(set, false);
    const next: RestState = {
      plannedSetId: set.id,
      title: `${exerciseName} ${set.set_no}세트 후 휴식`,
      timer: startRest(set.rest_sec, Date.now()),
    };
    // 새 타이머가 최신이다 — 아직 날아오는 복구 결과가 이걸 덮지 못하게 세대를 올린다.
    restoreRef.current?.invalidate();
    setRest(next);
    // 지속은 부가 기능이다 — 실패해도 기록은 이미 끝났고 화면도 그대로 간다.
    void restTimerStore.save(sessionId, next.plannedSetId, next.title, next.timer);
  };

  const handleUncomplete = async (set: PlannedSet) => {
    try {
      await uncompleteSetInStore(set.id);
      rememberPosition(set, false);
    } catch {
      setNotice("기록을 저장하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    // **화면에 떠 있든 아니든** 그 세트의 저장된 타이머를 지운다. 복구가 아직 대기 중이거나
    // 읽기가 잠깐 실패했으면 화면 state 는 비어 있어도 레코드는 남아 있고, 그대로 두면
    // 취소한 세트의 휴식이 다시 올라온다. 다른 세트의 타이머는 store 가 대조해 보존한다.
    restoreRef.current?.invalidate();
    if (rest?.plannedSetId === set.id) setRest(null);
    /**
     * 완료 취소 자체는 이미 성공했다(기록은 되돌리지 않는다). 하지만 저장분을 못 지웠다면
     * 다음 진입에서 그 타이머가 되살아나므로 **조용히 넘기지 않고** 알린다.
     */
    if (!(await restTimerStore.clearForPlannedSet(sessionId, set.id)))
      setNotice(CLEAR_FAILED_NOTICE);
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
  const closeRest = async () => {
    const from = rest?.plannedSetId;
    // 닫는 것은 사용자의 최종 의사다 — 뒤늦은 복구가 되살리지 못하게 먼저 세대를 올린다.
    restoreRef.current?.invalidate();

    /**
     * **지워진 것을 확인한 뒤에야 닫는다.** fire-and-forget 으로 두면 사용자가 삭제 커밋 전에
     * 새로고침·탭 종료를 할 때 미완료 삭제가 프로세스와 함께 사라지고, 닫았던 타이머가
     * 다시 열려 기록 편집을 가린다. 실패하면 시트를 그대로 두고 다시 시도하게 한다 —
     * 여기서 닫아 주면 "성공한 척"이 되어 같은 유령 타이머를 만든다.
     */
    if (!(await restTimerStore.clear(sessionId))) {
      setNotice(CLEAR_FAILED_NOTICE);
      return;
    }
    flushSync(() => setRest(null));
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

  const shownSummary =
    !completionReady || completionWaiting
      ? null
      : ((summary?.session.id === sessionId ? summary : null) ??
        (session.status === "completed" &&
        (readOnly || positionScope.current?.sessionId !== sessionId || !editingCompleted)
          ? { session, next_recommendations: [] }
          : null));
  const summaryContent = shownSummary ? (
    <div inert={modalOpen} className="mx-auto max-w-md p-4">
      {/*
       * 종료 화면은 루틴 화면을 통째로 대체하므로 아래의 안내 영역이 렌더되지 않는다.
       * 정리 실패는 여기서도 보여야 사용자가 "재진입하면 휴식이 다시 뜰 수 있다"를 안다.
       */}
      {notice ? (
        <p role="status" className="mb-3 text-sm text-fg-muted">
          {notice}
        </p>
      ) : null}
      <SessionSummary
        {...summaryMetricsFor(session.planned_sets, drafts)}
        nextRecommendations={shownSummary.next_recommendations}
        catalogById={catalogById}
        /* F6-1: 오늘이면 종료 후에도 돌아가서 더 하거나 고칠 수 있다. */
        onResume={
          shownSummary.session.status !== "completed" ||
          isUtcToday(shownSummary.session.scheduled_date)
            ? () => {
                setSummary(null);
                setEditingCompleted(true);
                const scope = positionScope.current;
                if (scope) {
                  scope.intent = 0;
                  scope.restored = false;
                  scope.read = readPosition(DEV_USER_SCOPE, sessionId);
                  void scope.read
                    .then((record) => {
                      if (positionScope.current === scope)
                        setPositionHydration({ sessionId, record });
                    })
                    .catch(() => undefined);
                }
              }
            : undefined
        }
      />
    </div>
  ) : null;

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
      {summaryContent}
      {shownSummary ? null : (
        <>
          {/* 랜드마크 <main> 과 스킵 링크는 app/layout.tsx 에 하나씩만 둔다(중복 금지). */}
          {/* pb-28 = 하단 고정 바(버튼 72 + 패딩 24)를 가릴 만큼만 비운다. */}
          <div inert={modalOpen} className="mx-auto flex max-w-md flex-col gap-3 p-4 pb-28">
            <header className="flex flex-col gap-1">
              <h1 className="text-xl font-bold text-fg">오늘 운동</h1>
              {completionWaiting ? (
                <p role="status" className="text-sm text-fg-muted">
                  {errorMessage(
                    appendCompletionQuery.data?.some((row) => row.blocked)
                      ? new ApiError(409, "SYNC_CONFLICT", "completion blocked")
                      : new Error("completion pending"),
                    "complete",
                  )}
                </p>
              ) : null}
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

            <div
              className="flex flex-col gap-3"
              // Only explicit routine interaction keeps an ongoing edit open across a remote completion.
              // Hydration and programmatic focus do not opt in; route changes and local completion reset it.
              onClickCapture={() => !readOnly && setEditingCompleted(true)}
              onChangeCapture={() => !readOnly && setEditingCompleted(true)}
              onKeyDownCapture={() => !readOnly && setEditingCompleted(true)}
            >
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
                  const appendContext: AppendContext | null = appendStateQuery.data
                    ? {
                        user_id: DEV_USER_SCOPE,
                        session_id: sessionId,
                        exercise_id: group.exerciseId,
                        today: utcDateString(),
                        scheduled_date: session.scheduled_date,
                        status: session.status,
                        snapshot: {
                          user_id: DEV_USER_SCOPE,
                          session_id: sessionId,
                          rows: session.planned_sets,
                        },
                        entries: appendStateQuery.data.entries,
                        tombstones: appendStateQuery.data.tombstones,
                      }
                    : null;
                  const append = appendContext
                    ? assessAppend(appendContext)
                    : { ok: false as const, reason: "eligibility_unavailable" };
                  const blockedAppend =
                    !append.ok &&
                    (append.reason === "unsafe_assistance_snapshot" ||
                      appendStateQuery.data?.entries.some(
                        (entry) =>
                          entry.intent.transport.payload.exercise_id === group.exerciseId &&
                          entry.execution.phase === "blocked",
                      ));
                  const appendReason = append.ok
                    ? null
                    : append.reason === "readonly"
                      ? "세트는 오늘 운동에만 추가할 수 있어요."
                      : append.reason === "set_cap_reached"
                        ? "세트 수는 1~10 사이로 정해 주세요."
                        : blockedAppend
                          ? APPEND_BLOCKED
                          : APPEND_ELIGIBILITY_MISSING;
                  return (
                    <ExerciseCard
                      key={group.exerciseId}
                      name={nameOf(group.exerciseId, index)}
                      exercise={catalogById.get(group.exerciseId) ?? null}
                      catalogById={catalogById}
                      sets={group.sets}
                      drafts={drafts}
                      readOnly={readOnly}
                      onAppend={() => {
                        if (!appendContext) return;
                        const result = captureAppendSource(appendContext);
                        if (result.ok) appendMutation.mutate(result.capture);
                      }}
                      appendDisabled={!append.ok || appendMutation.isPending}
                      appendReason={appendReason}
                      onReloadAppend={
                        appendReason === APPEND_ELIGIBILITY_MISSING
                          ? () => {
                              void refetchAuthoritativeSession(queryClient, sessionId, () =>
                                api.session(sessionId),
                              ).then(() => appendStateQuery.refetch());
                            }
                          : undefined
                      }
                      lockedReason={locked ? LOCKED_REASON : null}
                      painScore={painOf(
                        drafts,
                        group.sets.map((set) => set.id),
                      )}
                      expandedSetId={expandedSetId}
                      focusExpandedSetId={focusExpandedSetId}
                      activeSetId={activePosition?.planned_set_id}
                      onActivateSet={(set) => rememberPosition(set)}
                      onToggleExpand={(plannedSetId) => {
                        const set = group.sets.find((item) => item.id === plannedSetId)!;
                        rememberPosition(set, expandedSetId !== plannedSetId);
                        setFocusExpandedSetId(plannedSetId);
                        setExpandedSetId((previous) =>
                          previous === plannedSetId ? null : plannedSetId,
                        );
                      }}
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
                  onClick={(event) => {
                    setPickerReturnFocusTarget(event.currentTarget);
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
        </>
      )}
      {rest && positionScope.current?.sessionId === sessionId ? (
        <RestTimerSheet
          open
          title={rest.title}
          timer={rest.timer}
          onChange={(timer) => {
            // 연장도 사용자의 최신 의사다. 세대를 올린 뒤 화면과 저장을 새 endsAt 으로 맞춘다.
            restoreRef.current?.invalidate();
            setRest({ ...rest, timer });
            void restTimerStore.save(sessionId, rest.plannedSetId, rest.title, timer);
          }}
          onClose={() => void closeRest()}
          onCompletionObserved={handleCompletionObserved}
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
          returnFocusTarget={picker.type === "add" ? pickerReturnFocusTarget : undefined}
          catalog={catalog}
          catalogLoading={catalogQuery.isPending || catalogQuery.isFetching}
          catalogError={catalogQuery.isError ? errorMessage(catalogQuery.error, "catalog") : null}
          onRetryCatalog={() => void catalogQuery.refetch()}
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
