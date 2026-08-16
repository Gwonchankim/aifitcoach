import { DEV_USER_SCOPE } from "../components/session/session-db";
import {
  api,
  type CompletionAnalytics,
  type CompletionAnalyticsQuery,
  type DashboardSummary,
  type E1rmAnalytics,
  type E1rmAnalyticsQuery,
  type Session,
  type VolumeAnalytics,
  type VolumeAnalyticsQuery,
} from "./api";
import { readThroughReadModel, type ReadModelEnvelope } from "./read-model-cache";

export const MAX_ANALYTICS_WEEKS = 12;

type BoundedE1rmQuery = E1rmAnalyticsQuery & Required<Pick<E1rmAnalyticsQuery, "from" | "to">>;

export function dashboardReadModel(
  userId = DEV_USER_SCOPE,
): Promise<ReadModelEnvelope<DashboardSummary>> {
  return readThroughReadModel({
    userId,
    kind: "dashboard",
    cacheKey: "dashboard",
    fetcher: api.dashboard,
  });
}

export function e1rmReadModel(
  query: BoundedE1rmQuery,
  userId = DEV_USER_SCOPE,
): Promise<ReadModelEnvelope<E1rmAnalytics>> {
  assertDateWindow(query.from, query.to);
  return readThroughReadModel({
    userId,
    kind: "e1rm",
    cacheKey: queryKey("e1rm", query),
    fetcher: () => api.analyticsE1rm(query),
  });
}

export function volumeReadModel(
  query: VolumeAnalyticsQuery = {},
  userId = DEV_USER_SCOPE,
): Promise<ReadModelEnvelope<VolumeAnalytics>> {
  assertWeeks(query.weeks);
  return readThroughReadModel({
    userId,
    kind: "volume",
    cacheKey: queryKey("volume", query),
    fetcher: () => api.analyticsVolume(query),
  });
}

export function completionReadModel(
  query: CompletionAnalyticsQuery = {},
  userId = DEV_USER_SCOPE,
): Promise<ReadModelEnvelope<CompletionAnalytics>> {
  assertWeeks(query.weeks);
  return readThroughReadModel({
    userId,
    kind: "completion",
    cacheKey: queryKey("completion", query),
    fetcher: () => api.analyticsCompletion(query),
  });
}

export function historySessionReadModel(
  sessionId: string,
  userId = DEV_USER_SCOPE,
): Promise<ReadModelEnvelope<Session>> {
  return readThroughReadModel({
    userId,
    kind: "history-session",
    cacheKey: `history-session:${sessionId}`,
    fetcher: () => api.session(sessionId),
  });
}

/** Recent inclusive date range and its Monday-aligned weekly query. */
export function recentAnalyticsWindow(
  today: string,
  weeks = MAX_ANALYTICS_WEEKS,
): { e1rm: { from: string; to: string }; weekly: { week_start: string; weeks: number } } {
  assertWeeks(weeks);
  const end = parseDate(today);
  const startOfCurrentWeek = new Date(end);
  startOfCurrentWeek.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7));
  const start = new Date(startOfCurrentWeek);
  start.setUTCDate(start.getUTCDate() - (weeks - 1) * 7);
  const e1rmStart = new Date(end);
  e1rmStart.setUTCDate(e1rmStart.getUTCDate() - (weeks * 7 - 1));
  return {
    e1rm: { from: dateString(e1rmStart), to: dateString(end) },
    weekly: { week_start: dateString(start), weeks },
  };
}

function queryKey(kind: string, query: Record<string, string | number | undefined>): string {
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] != null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
  return params ? `${kind}:${params}` : kind;
}

function assertWeeks(weeks = 1): void {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_ANALYTICS_WEEKS)
    throw new RangeError(`analytics weeks must be between 1 and ${MAX_ANALYTICS_WEEKS}`);
}

function assertDateWindow(from: string, to: string): void {
  const start = parseDate(from);
  const end = parseDate(to);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > MAX_ANALYTICS_WEEKS * 7)
    throw new RangeError(`e1RM window must be between 1 day and ${MAX_ANALYTICS_WEEKS} weeks`);
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("expected an ISO date");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || dateString(date) !== value)
    throw new RangeError("expected a valid ISO date");
  return date;
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}
