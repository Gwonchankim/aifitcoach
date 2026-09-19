import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { DEV_USER_SCOPE, readThroughSession } from "../components/session/session-db";
import { dashboardReadModel, historySessionReadModel } from "./read-model-data";
import { bumpWeekSwapEpoch } from "./week-swap-db";
import { currentWeekReadModel } from "./week-swap-data";

export async function refreshAfterWeekSwap(
  client: QueryClient,
  programId: string,
  sessionIds: string[],
) {
  await bumpWeekSwapEpoch(DEV_USER_SCOPE);
  const roots = new Set([
    "current-week",
    "week-swap-candidates",
    "dashboard",
    "session",
    "dashboard-session",
    "history-session",
    "analytics",
  ]);
  await client.cancelQueries({ predicate: (query) => roots.has(String(query.queryKey[0])) });
  const [week, dashboard] = await Promise.all([
    client.fetchQuery({
      queryKey: ["current-week", programId],
      queryFn: () => currentWeekReadModel(programId),
      staleTime: 0,
    }),
    client.fetchQuery({
      queryKey: ["dashboard"],
      queryFn: () => dashboardReadModel(),
      staleTime: 0,
    }),
  ]);
  if (week.stale || dashboard.stale) throw new Error("latest schedule unavailable");
  const ids = [
    ...new Set([
      ...sessionIds,
      ...(dashboard.data.today.session_id ? [dashboard.data.today.session_id] : []),
    ]),
  ];
  await Promise.all(
    ids.map(async (id) => {
      const session = await readThroughSession(DEV_USER_SCOPE, id, () => api.session(id), {
        offlineFallback: false,
      });
      client.setQueryData(["session", id], session);
      const envelope = await historySessionReadModel(id);
      if (envelope.stale) throw new Error("latest session unavailable");
      client.setQueryData(["dashboard-session", id], envelope);
      client.setQueryData(["history-session", id], envelope);
    }),
  );
  await client.invalidateQueries({ queryKey: ["analytics"] });
  return { week: week.data, todaySessionId: dashboard.data.today.session_id };
}
