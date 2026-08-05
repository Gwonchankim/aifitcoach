/**
 * openapi 계약 기반 API 클라이언트.
 * 타입은 lib/api-types.ts(생성물)에서 온다 — 여기서 응답 모양을 다시 정의하지 않는다.
 *
 * 베이스 URL: NEXT_PUBLIC_API_BASE_URL
 *   - 실서버: http://localhost:3001/v1   (Nest global prefix /v1)
 *   - 목서버: http://localhost:4010      (prism 은 /v1 없이 루트에 마운트)
 */
import type { components, paths } from "./api-types";

export type Program = components["schemas"]["Program"];
export type Session = components["schemas"]["Session"];
export type PlannedSet = components["schemas"]["PlannedSet"];
export type Exercise = components["schemas"]["Exercise"];
export type DashboardSummary = components["schemas"]["DashboardSummary"];
export type Recommendation = components["schemas"]["Recommendation"];
export type GenerateProgramRequest = components["schemas"]["GenerateProgramRequest"];

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/v1";

/** 서버가 내려주는 에러 봉투(`{ error: { code, message } }`)를 그대로 담는다. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 변경(mutating) 요청은 계약상 `X-CSRF-Token` 이 필수다(openapi CsrfHeader).
 * 테스트 단계에는 세션·CSRF 발급이 없어(docs/TEST_SCOPE.md) 자리만 채운다.
 * 인증 도입 시 이 함수만 실제 토큰(쿠키/메타에서 읽기)으로 교체한다.
 */
function csrfToken(): string {
  return "dev";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const mutating = method !== "GET" && method !== "HEAD";

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(mutating ? { "X-CSRF-Token": csrfToken() } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const envelope = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      envelope?.code ?? "UNKNOWN",
      envelope?.message ?? "요청을 처리하지 못했다.",
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

type ExercisesQuery = paths["/exercises"]["get"]["parameters"]["query"];

export const api = {
  generateProgram: (body: GenerateProgramRequest) =>
    request<Program>("/programs/generate", { method: "POST", body: JSON.stringify(body) }),

  currentProgram: () => request<Program>("/programs/current"),

  dashboard: () => request<DashboardSummary>("/dashboard"),

  session: (sessionId: string) => request<Session>(`/sessions/${sessionId}`),

  completeSession: (
    sessionId: string,
    body: { difficulty?: string; pump?: string; pain?: number } = {},
  ) =>
    request<{
      session: Session;
      next_recommendations: (Recommendation & { exercise_id: string })[];
    }>(`/sessions/${sessionId}/complete`, { method: "POST", body: JSON.stringify(body) }),

  exercises: (query: ExercisesQuery = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<{ items: Exercise[]; next_cursor?: string | null }>(`/exercises${suffix}`);
  },

  addExercise: (
    sessionId: string,
    body: { exercise_id: string; sets?: number | null; position?: number | null },
  ) =>
    request<Session>(`/sessions/${sessionId}/exercises`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  removeExercise: (sessionId: string, plannedExerciseId: string) =>
    request<Session>(`/sessions/${sessionId}/exercises/${plannedExerciseId}`, { method: "DELETE" }),

  swapExercise: (sessionId: string, plannedExerciseId: string, body: { to_exercise_id: string }) =>
    request<Session>(`/sessions/${sessionId}/exercises/${plannedExerciseId}/swap`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
