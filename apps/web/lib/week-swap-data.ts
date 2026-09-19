import { api } from "./api";
import { DEV_USER_SCOPE } from "../components/session/session-db";
import { readThroughReadModel } from "./read-model-cache";
import { parseCurrentWeek } from "./week-swap";
export function currentWeekReadModel(programId: string, userId = DEV_USER_SCOPE) {
  return readThroughReadModel({
    userId,
    kind: "current-week",
    cacheKey: `current-week:${programId}`,
    fetcher: async () => {
      const result = parseCurrentWeek(await api.currentWeek(programId));
      if (!result || result.program_id !== programId)
        throw new SyntaxError("malformed current week");
      return result;
    },
  });
}
