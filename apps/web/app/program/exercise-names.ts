/**
 * 제외 운동 목록에 이름을 붙이기 위한 카탈로그 조회.
 * `Program.excluded_exercises` 는 `exercise_id` 만 주는데 화면에는 id 를 노출할 수 없다(AC-S2-1).
 *
 * 카탈로그는 커서 페이지네이션이라 다음 커서를 따라가며 모은다.
 * 응답이 이상해도 무한 루프에 빠지지 않도록 페이지 수에 상한을 둔다.
 */
import { api } from "../../lib/api";

const MAX_PAGES = 5;

export async function fetchExerciseNames(): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await api.exercises(cursor ? { cursor } : {});
    for (const exercise of response.items) {
      names[exercise.id] = exercise.name_ko;
    }
    if (!response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return names;
}
