/**
 * 운동 카탈로그(F5 추가·교체 후보, 세션 화면의 운동 이름 출처).
 *
 * `GET /exercises` 는 페이지 크기 20 + 커서 페이징이다(카탈로그 30종 = 2페이지).
 * 첫 페이지만 쓰면 후보 10종이 조용히 사라지므로 `next_cursor` 를 끝까지 따라간다.
 * 부위 탭은 계약에 `region` 쿼리·필드가 없어 `primary_muscles` 로 클라이언트에서 나눈다.
 */
import { api, type Exercise } from "../../lib/api";

/** 커서를 끝까지 따라가 카탈로그 전량을 받는다. 서버가 준 순서를 그대로 유지한다. */
export async function fetchAllExercises(): Promise<Exercise[]> {
  const items: Exercise[] = [];
  let cursor: string | undefined;

  // 페이지 수 상한: 카탈로그 30종 기준으로 넉넉하다. 커서가 안 끝나도 무한 루프에 빠지지 않는다.
  for (let page = 0; page < 20; page += 1) {
    const response = await api.exercises(cursor ? { cursor } : {});
    items.push(...response.items);
    // 마지막 페이지에서는 키가 아예 생략된다 → 값 유무로 판정한다.
    if (!response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return items;
}

export type RegionId = "chest" | "back" | "shoulder" | "arm" | "lower" | "core";

export const REGIONS: { id: RegionId; label: string }[] = [
  { id: "chest", label: "가슴" },
  { id: "back", label: "등" },
  { id: "shoulder", label: "어깨" },
  { id: "arm", label: "팔" },
  { id: "lower", label: "하체" },
  { id: "core", label: "코어" },
];

const MUSCLE_REGION: Record<string, RegionId> = {
  chest: "chest",
  lats: "back",
  upper_back: "back",
  lower_back: "back",
  front_delts: "shoulder",
  side_delts: "shoulder",
  rear_delts: "shoulder",
  biceps: "arm",
  triceps: "arm",
  forearms: "arm",
  quads: "lower",
  hamstrings: "lower",
  glutes: "lower",
  calves: "lower",
  abs: "core",
};

/** 주동근 첫 번째를 그 운동의 부위로 본다. 매핑에 없으면 null(탭에 넣지 않는다). */
export function regionOf(exercise: Exercise): RegionId | null {
  for (const muscle of exercise.primary_muscles) {
    const region = MUSCLE_REGION[muscle];
    if (region) return region;
  }
  return null;
}

export function inRegion(exercise: Exercise, region: RegionId): boolean {
  return regionOf(exercise) === region;
}

/**
 * 교체 후보 정렬(F5): 지정 대체 종목 → 같은 movement_pattern → 나머지.
 * 서버에 정렬 옵션이 없고 카탈로그 전량을 이미 받았으므로 클라이언트에서 정렬한다.
 * 같은 그룹 안에서는 이름(한국어) 순이다.
 */
export function sortSwapCandidates(candidates: Exercise[], from: Exercise | null): Exercise[] {
  if (!from) return [...candidates].sort(byNameKo);

  const rank = (exercise: Exercise): number => {
    if (from.substitutions.includes(exercise.id)) return 0;
    if (exercise.movement_pattern === from.movement_pattern) return 1;
    return 2;
  };

  return [...candidates].sort((a, b) => rank(a) - rank(b) || byNameKo(a, b));
}

function byNameKo(a: Exercise, b: Exercise): number {
  return a.name_ko.localeCompare(b.name_ko, "ko");
}
