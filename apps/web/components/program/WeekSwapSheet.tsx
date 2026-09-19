"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { liveQuery } from "dexie";
import { Button, Sheet } from "../ui";
import { useModal } from "../session/useModal";
import { DEV_USER_SCOPE } from "../session/session-db";
import { newClientId } from "../session/session-store";
import { api, ApiError } from "../../lib/api";
import { useOnline } from "../../lib/use-online";
import { focusLabel } from "../../lib/program-labels";
import { isUtcToday } from "../../lib/utc-day";
import {
  candidateReasonCopy,
  hasUnknownCandidateReason,
  UnknownSwapReason,
  knownSwapReason,
  parseCandidates,
  parseSwapResult,
  SWAP_COPY,
  swapReasonCopy,
  type WeekSwapRequest,
} from "../../lib/week-swap";
import {
  clearSwapIntent,
  hasSwapPending,
  readSwapIntent,
  saveSwapIntent,
} from "../../lib/week-swap-db";
import { currentWeekReadModel } from "../../lib/week-swap-data";
import { refreshAfterWeekSwap } from "../../lib/week-swap-refresh";

export function WeekSwapEntry({ programId }: { programId: string }) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        fullWidth
        onClick={(event) => {
          setOpener(event.currentTarget);
          setOpen(true);
        }}
      >
        {SWAP_COPY.title}
      </Button>
      {open ? (
        <WeekSwapSheet
          programId={programId}
          returnFocusTarget={opener}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
export function WeekSwapSheet({
  programId,
  onClose,
  returnFocusTarget,
}: {
  programId: string;
  onClose: () => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const online = useOnline();
  const router = useRouter();
  const client = useQueryClient();
  const [mode, setMode] = useState<"swap" | "one-off">("swap");
  const [selected, setSelected] = useState<string | null>(null);
  const [intent, setIntent] = useState<WeekSwapRequest | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [localPending, setLocalPending] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [freshConnection, setFreshConnection] = useState(online);
  const close = () => {
    if (!busy.current) onClose();
  };
  useModal(true, "week-swap", close, "week-swap-close", returnFocusTarget);
  const week = useQuery({
    queryKey: ["current-week", programId],
    queryFn: () => currentWeekReadModel(programId),
    retry: false,
  });
  const candidates = useQuery({
    queryKey: ["week-swap-candidates", programId],
    queryFn: async () => {
      const raw = await api.weekSwapCandidates(programId);
      if (hasUnknownCandidateReason(raw)) throw new UnknownSwapReason();
      const parsed = parseCandidates(raw);
      if (!parsed || parsed.program_id !== programId) throw new SyntaxError("malformed candidates");
      return parsed;
    },
    retry: false,
    enabled: online,
  });
  const data = candidates.data;
  const today = week.data?.data.sessions.find((session) => session.id === data?.today_session_id);
  const target = data?.candidates.find((item) => item.session.id === selected);
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const request = await readSwapIntent(DEV_USER_SCOPE, programId);
      const pair = request
        ? [request.today_session_id, request.target_session_id]
        : [data?.today_session_id, selected].filter((id): id is string => Boolean(id));
      return { request, pending: await hasSwapPending(DEV_USER_SCOPE, pair) };
    }).subscribe({
      next: (value) => {
        setIntent(value.request);
        setLocalPending(value.pending);
        setStorageReady(true);
      },
      error: () => {
        setStorageReady(false);
        setMessage(SWAP_COPY.unresolved);
      },
    });
    return () => subscription.unsubscribe();
  }, [programId, data?.today_session_id, selected]);
  useEffect(() => {
    if (!online) {
      setFreshConnection(false);
      setSelected(null);
    }
  }, [online]);
  const refresh = async () => {
    setSelected(null);
    const results = await Promise.all([week.refetch(), candidates.refetch()]);
    if (results.every((result) => !result.error)) setFreshConnection(true);
  };
  const run = async (checking: boolean) => {
    if (busy.current || !navigator.onLine || !storageReady) return;
    if (
      !checking &&
      (!freshConnection ||
        localPending ||
        intent ||
        !data?.today_eligible ||
        !today ||
        !target?.eligible ||
        data.today_revision !== today.revision)
    )
      return;
    busy.current = true;
    setSubmitting(true);
    setMessage(null);
    let request = intent;
    try {
      if (!checking) {
        if (await hasSwapPending(DEV_USER_SCOPE, [data!.today_session_id!, selected!])) {
          setMessage(SWAP_COPY.pending);
          return;
        }
        request = {
          client_id: newClientId(),
          today_session_id: data!.today_session_id!,
          target_session_id: selected!,
          today_revision: data!.today_revision!,
          target_revision: target!.session.revision,
        };
        await saveSwapIntent(DEV_USER_SCOPE, programId, request);
        setIntent(request);
      }
      if (!request) return;
      // Result checking can execute a request whose first attempt never reached the server.
      // Recheck the durable original pair, not the currently displayed candidate selection.
      if (
        await hasSwapPending(DEV_USER_SCOPE, [request.today_session_id, request.target_session_id])
      ) {
        setLocalPending(true);
        setMessage(SWAP_COPY.pending);
        return;
      }
      const result = parseSwapResult(await api.weekSwap(programId, request), request, programId);
      if (!result) throw new SyntaxError("malformed swap result");
      // A receipt replay represents the original operation. Fresh GETs determine today's route.
      const latest = await refreshAfterWeekSwap(client, programId, [
        request.today_session_id,
        request.target_session_id,
      ]);
      await clearSwapIntent(DEV_USER_SCOPE, programId, request.client_id);
      setIntent(null);
      onClose();
      router.push(latest.todaySessionId ? `/session/${latest.todaySessionId}` : "/program");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "CONFLICT") {
        setMessage(swapReasonCopy(error.reason));
        setSelected(null);
        // A well-formed conflict is a final rejection; no retry or replacement ID is issued.
        if (knownSwapReason(error.reason) && request) {
          try {
            await refreshAfterWeekSwap(client, programId, [
              request.today_session_id,
              request.target_session_id,
            ]);
            await clearSwapIntent(DEV_USER_SCOPE, programId, request.client_id);
            setIntent(null);
            await refresh();
          } catch {
            /* Preserve the original intent until its latest state can be checked. */
          }
        }
      } else setMessage(SWAP_COPY.unresolved);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };
  let readError: string | null = null;
  if (candidates.error instanceof UnknownSwapReason) readError = SWAP_COPY.unknown;
  else if (candidates.error instanceof SyntaxError) readError = SWAP_COPY.malformed;
  else if (candidates.error instanceof ApiError && candidates.error.status === 404) {
    readError =
      week.data?.source === "server" &&
      !week.data.stale &&
      !week.error &&
      !week.isFetching &&
      !week.data.data.sessions.some((session) => isUtcToday(session.scheduled_date))
        ? SWAP_COPY.noToday
        : SWAP_COPY.missing;
  } else if (candidates.error) readError = SWAP_COPY.failed;
  const todayActuals =
    week.data?.data.sessions.filter((session) => isUtcToday(session.scheduled_date)) ?? [];
  // Existing same-day editing also supports completed, in-progress and ad-hoc sessions.
  // Weekly swap eligibility must not narrow that independent route's contract.
  const oneOffToday =
    !week.error && !week.isFetching && !week.data?.stale && todayActuals.length === 1
      ? todayActuals[0]
      : null;
  const disabled =
    !online ||
    !freshConnection ||
    !storageReady ||
    localPending ||
    Boolean(intent) ||
    submitting ||
    !data?.today_eligible ||
    !today ||
    !target?.eligible ||
    data.today_revision !== today.revision ||
    candidates.isFetching ||
    Boolean(candidates.error);
  return (
    <Sheet
      open
      id="week-swap"
      title={SWAP_COPY.title}
      onScrimClick={close}
      footer={
        <Button
          id="week-swap-close"
          variant="secondary"
          size="lg"
          fullWidth
          disabled={submitting}
          onClick={close}
        >
          닫기
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset
          disabled={submitting || Boolean(intent) || !storageReady}
          className="flex flex-col gap-2"
        >
          <label className="flex min-h-12 items-center gap-2">
            <input
              type="radio"
              name="swap-mode"
              checked={mode === "swap"}
              onChange={() => {
                setMode("swap");
                setSelected(null);
              }}
            />
            두 운동일 교환
          </label>
          <label className="flex min-h-12 items-center gap-2">
            <input
              type="radio"
              name="swap-mode"
              checked={mode === "one-off"}
              onChange={() => setMode("one-off")}
            />
            오늘만 운동 바꾸기
          </label>
        </fieldset>
        {!online ? <p role="status">{SWAP_COPY.offline}</p> : null}
        {localPending ? <p role="status">{SWAP_COPY.pending}</p> : null}
        {intent ? (
          <>
            <p role="status">{SWAP_COPY.unresolved}</p>
            <Button
              disabled={!online || submitting || localPending || !storageReady}
              onClick={() => void run(true)}
            >
              결과 확인
            </Button>
          </>
        ) : null}
        {message ? <p role="alert">{message}</p> : null}
        {submitting ? <p role="status">운동일을 교환하고 있어요.</p> : null}
        {mode === "one-off" ? (
          <>
            <p>오늘 루틴에서 원하는 운동만 바꿔요. 주간 운동량은 달라질 수 있어요.</p>
            <Button
              disabled={!oneOffToday || localPending || !online || Boolean(intent) || !storageReady}
              onClick={() => {
                onClose();
                if (oneOffToday) router.push(`/session/${oneOffToday.id}`);
              }}
            >
              오늘 루틴 편집하기
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-muted">{SWAP_COPY.description}</p>
            {readError ? <p role="alert">{readError}</p> : null}
            {data && !data.today_eligible ? (
              <p role="status">{swapReasonCopy(data.today_reason)}</p>
            ) : null}
            {data?.candidates.length === 0 ? <p>{SWAP_COPY.empty}</p> : null}
            {data &&
            data.candidates.length > 0 &&
            data.candidates.every((item) => !item.eligible) ? (
              <p>{SWAP_COPY.unavailable}</p>
            ) : null}
            {data?.candidates.map((item) => (
              <label
                key={item.session.id}
                className="flex min-h-12 items-start gap-2 rounded-control border border-border p-3"
              >
                <input
                  className="mt-1"
                  type="radio"
                  name="swap-target"
                  checked={selected === item.session.id}
                  disabled={
                    !item.eligible ||
                    !data.today_eligible ||
                    submitting ||
                    Boolean(intent) ||
                    !online ||
                    !freshConnection
                  }
                  onChange={() => setSelected(item.session.id)}
                />
                <span>
                  <span className="block">
                    {item.session.scheduled_date} · {focusLabel(item.session.focus) ?? "운동"}
                  </span>
                  {!item.eligible ? (
                    <span className="block text-sm text-fg-muted">
                      {candidateReasonCopy(item.reason)}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
            {today && target ? (
              <div className="rounded-control border border-border p-3">
                <p className="font-semibold">이 두 운동일을 교환할까요?</p>
                <p>
                  오늘 {today.scheduled_date} · {focusLabel(today.focus) ?? "운동"} ↔{" "}
                  {target.session.scheduled_date} · {focusLabel(target.session.focus) ?? "운동"}
                </p>
                <Button disabled={disabled} fullWidth onClick={() => void run(false)}>
                  교환하기
                </Button>
                <Button
                  variant="secondary"
                  disabled={submitting}
                  fullWidth
                  onClick={() => setSelected(null)}
                >
                  취소
                </Button>
              </div>
            ) : null}
            <Button
              variant="secondary"
              disabled={!online || submitting}
              onClick={() => void refresh()}
            >
              일정 다시 확인
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
