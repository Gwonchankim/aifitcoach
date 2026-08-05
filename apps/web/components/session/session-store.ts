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
  begin: (sessionId: string) => void;
  /** 완료 체크: 화면에 보이는 값을 그대로 기록값으로 확정한다. */
  completeSet: (plannedSetId: string, values: SetValues) => void;
  /** 완료 취소(F1 되돌리기). 입력값은 남겨 둔다. */
  uncompleteSet: (plannedSetId: string) => void;
  /** 운동 단위 통증 보고. 그 운동의 세트 전부에 같은 점수를 남긴다(null = 취소). */
  reportPain: (plannedSetIds: string[], score: number | null) => void;
};

/**
 * `/sync` 멱등 키(openapi `client_id: format: uuid`).
 *
 * `crypto.randomUUID` 는 **secure context 전용**이라 폰에서 `http://192.168.x.x:3000` 으로 열면
 * 아예 없다 → 완료 체크가 통째로 죽는다. 반면 `crypto.getRandomValues` 는 http 에서도 있다.
 * 분기를 두면 실기기에서만 도는 경로가 생겨 테스트가 못 잡으므로, **항상** 같은 경로를 쓴다.
 */
function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const useSessionLog = create<SessionLogState>((set) => {
  /** 단 하나의 저장 지점. STEP 6 에서 outbox enqueue 가 붙을 자리다. */
  const write = (plannedSetId: string, patch: Partial<SetDraft>) =>
    set((state) => {
      const base: SetDraft = state.drafts[plannedSetId] ?? {
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
      const next: SetDraft = { ...base, ...patch, updated_at: new Date().toISOString() };
      return { drafts: { ...state.drafts, [plannedSetId]: next } };
    });

  return {
    sessionId: null,
    drafts: {},

    begin: (sessionId) =>
      set((state) => (state.sessionId === sessionId ? state : { sessionId, drafts: {} })),

    completeSet: (plannedSetId, values) =>
      write(plannedSetId, {
        actual_weight: values.weight,
        actual_reps: values.reps,
        actual_rir: values.rir,
        actual_time_sec: values.timeSec,
        completed: true,
      }),

    uncompleteSet: (plannedSetId) => write(plannedSetId, { completed: false }),

    /**
     * 통증은 세트가 아니라 **운동**에서 느낀다 → 그 운동의 세트 전부에 같은 점수를 남긴다.
     * 완료 여부는 건드리지 않는다(F7: performed_set 로 나가는 건 완료 체크된 세트뿐이다).
     */
    reportPain: (plannedSetIds, score) => {
      for (const plannedSetId of plannedSetIds) write(plannedSetId, { pain_score: score });
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
