/**
 * 오늘 세션의 세트 기록 상태(F1·F7).
 *
 * STEP 5 범위: 세트를 개별 저장하는 엔드포인트가 계약에 없다(`/sync` 는 STEP 6).
 * 그래서 완료 체크·기록값은 여기(클라이언트 상태)에만 모이고, `POST /sessions/{id}/complete`
 * 시점의 요약에 쓰인다.
 *
 * STEP 6 대비:
 * - 드래프트의 키 이름을 openapi `PerformedSet` 과 1:1로 맞춰 두었다 →
 *   `/sync` 의 `mutation.payload` 로 그대로 실을 수 있다(`client_id` 멱등, `updated_at` LWW).
 * - 모든 쓰기는 아래 `write()` **한 곳**만 지나간다 → 여기서 outbox(IndexedDB) enqueue 를
 *   추가하면 되고, 호출 지점(컴포넌트)은 손대지 않아도 된다.
 */
"use client";

import { create } from "zustand";
import type { SetValues } from "./set-rules";
import type { SyncResponse } from "../../lib/api";
import {
  commitDraft,
  commitDraftBatch,
  DEV_USER_SCOPE,
  loadDrafts,
  requestPersistentStorage,
} from "./session-db";
import { requestForegroundSync } from "./sync-coordinator";

/** openapi PerformedSet 과 같은 모양(= /sync payload). */
export type SetDraft = {
  planned_set_id: string;
  actual_weight: number | null;
  actual_reps: number | null;
  actual_rir: number | null;
  actual_time_sec: number | null;
  /** 운동별 통증 보고(FEATURES_UX 안전 절). 서버로 보낼 경로는 STEP 6 /sync 다. */
  pain_score: number | null;
  completed: boolean;
  client_id: string;
  updated_at: string;
};

type SessionLogState = {
  sessionId: string | null;
  drafts: Record<string, SetDraft>;
  /** 다른 세션에 들어오면 기록을 비운다. 같은 세션이면 그대로 이어간다. */
  begin: (sessionId: string) => Promise<void>;
  /** 완료 체크: 화면에 보이는 값을 그대로 기록값으로 확정한다. */
  completeSet: (plannedSetId: string, values: SetValues) => Promise<void>;
  /** 완료 취소(F1 되돌리기). 입력값은 남겨 둔다. */
  uncompleteSet: (plannedSetId: string) => Promise<void>;
  /** 운동 단위 통증 보고. 그 운동의 세트 전부에 같은 점수를 남긴다(null = 취소). */
  reportPain: (plannedSetIds: string[], score: number | null) => Promise<void>;
  /** IDB mapping transaction 뒤 현재 탭의 메모리 키도 같은 권위 ID로 맞춘다. */
  remapPlannedSets: (mappings: SyncResponse["planned_set_mappings"]) => void;
  /** Pull transaction이 반영한 현재 세션 draft를 메모리에 다시 싣는다. */
  refreshFromMirror: (sessionId: string) => Promise<void>;
};

/**
 * `/sync` 멱등 키(openapi `client_id: format: uuid`).
 *
 * `crypto.randomUUID` 는 **secure context 전용**이라 폰에서 `http://192.168.x.x:3000` 으로 열면
 * 아예 없다 → 완료 체크가 통째로 죽는다. 반면 `crypto.getRandomValues` 는 http 에서도 있다.
 * 분기를 두면 실기기에서만 도는 경로가 생겨 테스트가 못 잡으므로, **항상** 같은 경로를 쓴다.
 */
export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const useSessionLog = create<SessionLogState>((set, get) => {
  const nextDraft = (
    plannedSetId: string,
    current: SetDraft | undefined,
    patch: Partial<SetDraft>,
  ): { draft: SetDraft; op: "upsert" | "delete" | null } => {
    const base: SetDraft = current ?? {
      planned_set_id: plannedSetId,
      actual_weight: null,
      actual_reps: null,
      actual_rir: null,
      actual_time_sec: null,
      pain_score: null,
      completed: false,
      client_id: newClientId(),
      updated_at: "",
    };
    const draft: SetDraft = {
      ...base,
      ...patch,
      client_id: newClientId(),
      updated_at: new Date().toISOString(),
    };
    return {
      draft,
      op: draft.completed ? "upsert" : base.completed ? "delete" : null,
    };
  };

  /** IndexedDB commit succeeds before Zustand exposes the new local state. */
  const write = async (plannedSetId: string, patch: Partial<SetDraft>) => {
    const state = get();
    if (!state.sessionId) throw new Error("세션 기록을 시작하지 못했어요.");
    const { draft, op } = nextDraft(plannedSetId, state.drafts[plannedSetId], patch);
    await commitDraft(DEV_USER_SCOPE, state.sessionId, draft, op);
    // A session switch while the transaction was pending must not leak its draft into the new screen.
    if (get().sessionId !== state.sessionId) return;
    set((current) => ({ drafts: { ...current.drafts, [plannedSetId]: draft } }));
    if (op) void requestForegroundSync().catch(() => undefined);
  };

  return {
    sessionId: null,
    drafts: {},

    begin: async (sessionId) => {
      if (get().sessionId === sessionId) return;
      set({ sessionId, drafts: {} });
      void requestPersistentStorage().catch(() => undefined);
      const drafts = await loadDrafts(DEV_USER_SCOPE, sessionId);
      if (get().sessionId === sessionId) {
        // A user may write while hydration is reading. Fresh in-memory commits win over
        // the older read snapshot so hydration cannot erase a just-completed set.
        set((current) => ({ drafts: { ...drafts, ...current.drafts } }));
      }
    },

    completeSet: async (plannedSetId, values) =>
      write(plannedSetId, {
        actual_weight: values.weight,
        actual_reps: values.reps,
        actual_rir: values.rir,
        actual_time_sec: values.timeSec,
        completed: true,
      }),

    uncompleteSet: async (plannedSetId) => write(plannedSetId, { completed: false }),

    /**
     * 통증은 세트가 아니라 **운동**에서 느낀다 → 그 운동의 세트 전부에 같은 점수를 남긴다.
     * 완료 여부는 건드리지 않는다(F7: performed_set 로 나가는 건 완료 체크된 세트뿐이다).
     */
    reportPain: async (plannedSetIds, score) => {
      const state = get();
      if (!state.sessionId) throw new Error("세션 기록을 시작하지 못했어요.");
      const changes = plannedSetIds.map((plannedSetId) => ({
        plannedSetId,
        ...nextDraft(plannedSetId, state.drafts[plannedSetId], { pain_score: score }),
      }));
      await commitDraftBatch(
        DEV_USER_SCOPE,
        state.sessionId,
        changes.map(({ draft, op }) => ({ draft, op })),
      );
      if (get().sessionId !== state.sessionId) return;
      set((current) => ({
        drafts: {
          ...current.drafts,
          ...Object.fromEntries(changes.map(({ plannedSetId, draft }) => [plannedSetId, draft])),
        },
      }));
      if (changes.some(({ op }) => op)) void requestForegroundSync().catch(() => undefined);
    },

    remapPlannedSets: (mappings) => {
      if (mappings.length === 0) return;
      const byCorrelation = new Map(
        mappings.map((mapping) => [mapping.correlation_id, mapping.planned_set_id]),
      );
      set((current) => ({
        drafts: Object.fromEntries(
          Object.entries(current.drafts).map(([key, draft]) => {
            const plannedSetId = byCorrelation.get(key) ?? key;
            return [plannedSetId, { ...draft, planned_set_id: plannedSetId }];
          }),
        ),
      }));
    },

    refreshFromMirror: async (sessionId) => {
      const drafts = await loadDrafts(DEV_USER_SCOPE, sessionId);
      if (get().sessionId === sessionId) set({ drafts });
    },
  };
});

/** 한 운동(= 세트 묶음)에 기록된 통증 점수. 없으면 null. */
export function painOf(drafts: Record<string, SetDraft>, plannedSetIds: string[]): number | null {
  for (const plannedSetId of plannedSetIds) {
    const score = drafts[plannedSetId]?.pain_score;
    if (score != null) return score;
  }
  return null;
}

/** 완료 체크된 세트만 집계한다(F7: 미수행 세트는 기록하지 않는다). */
export function summarize(drafts: Record<string, SetDraft>): {
  completedCount: number;
  totalVolume: number;
} {
  let completedCount = 0;
  let totalVolume = 0;

  for (const draft of Object.values(drafts)) {
    if (!draft.completed) continue;
    completedCount += 1;
    // 자체중량·시간 종목의 볼륨 산입 규칙은 미확정(UX_STATES C-6) → 0 으로 두고
    // 화면에 별도 문구를 만들지 않는다.
    if (draft.actual_weight != null && draft.actual_reps != null) {
      totalVolume += draft.actual_weight * draft.actual_reps;
    }
  }

  return { completedCount, totalVolume };
}
