/**
 * 카탈로그 페이징·부위 분류·교체 후보 정렬(F5).
 * 커서를 안 따라가면 후보가 조용히 사라지므로 페이징을 테스트로 고정한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Exercise } from "../lib/api";

const exercisesMock = vi.fn();
vi.mock("../lib/api", () => ({
  api: { exercises: (...args: unknown[]) => exercisesMock(...args) },
}));

const { REGIONS, fetchAllExercises, inRegion, regionOf, sortSwapCandidates } =
  await import("../components/session/exercise-catalog");

function exercise(id: string, overrides: Partial<Exercise> = {}): Exercise {
  return {
    id,
    name_ko: id,
    name_en: id,
    movement_pattern: "horizontal_push",
    primary_muscles: ["chest"],
    equipment: "barbell",
    difficulty: "intermediate",
    mechanic: "compound",
    region: "upper",
    metric: "reps",
    step_kg: 2.5,
    default_time_low_sec: null,
    default_time_high_sec: null,
    substitutions: [],
    media_url: null,
    ...overrides,
  };
}

describe("fetchAllExercises (커서 페이징)", () => {
  beforeEach(() => exercisesMock.mockReset());

  it("next_cursor 를 끝까지 따라가 전량을 모은다", async () => {
    exercisesMock
      .mockResolvedValueOnce({ items: [exercise("a"), exercise("b")], next_cursor: "b" })
      .mockResolvedValueOnce({ items: [exercise("c")] }); // 마지막 페이지는 키가 생략된다

    const items = await fetchAllExercises();

    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(exercisesMock).toHaveBeenNthCalledWith(1, {});
    expect(exercisesMock).toHaveBeenNthCalledWith(2, { cursor: "b" });
  });

  it("next_cursor 가 null 이면 멈춘다", async () => {
    exercisesMock.mockResolvedValueOnce({ items: [exercise("a")], next_cursor: null });
    await fetchAllExercises();
    expect(exercisesMock).toHaveBeenCalledTimes(1);
  });

  it("서버 순서를 뒤집지 않는다(커서 기준이 서버 정렬이다)", async () => {
    exercisesMock.mockResolvedValueOnce({
      items: [exercise("e_lateral_raise"), exercise("e_lat_pulldown")],
    });
    const items = await fetchAllExercises();
    expect(items.map((item) => item.id)).toEqual(["e_lateral_raise", "e_lat_pulldown"]);
  });
});

describe("regionOf (부위 탭)", () => {
  it("주동근을 6개 부위로 접는다", () => {
    expect(regionOf(exercise("x", { primary_muscles: ["chest"] }))).toBe("chest");
    expect(regionOf(exercise("x", { primary_muscles: ["lats", "upper_back"] }))).toBe("back");
    expect(regionOf(exercise("x", { primary_muscles: ["side_delts"] }))).toBe("shoulder");
    expect(regionOf(exercise("x", { primary_muscles: ["triceps"] }))).toBe("arm");
    expect(regionOf(exercise("x", { primary_muscles: ["quads", "glutes"] }))).toBe("lower");
    expect(regionOf(exercise("x", { primary_muscles: ["abs"] }))).toBe("core");
  });

  it("매핑에 없는 근육은 어느 탭에도 넣지 않는다", () => {
    expect(regionOf(exercise("x", { primary_muscles: ["tail"] }))).toBeNull();
    expect(inRegion(exercise("x", { primary_muscles: ["tail"] }), "chest")).toBe(false);
  });

  it("탭은 6개 부위다", () => {
    expect(REGIONS.map((region) => region.label)).toEqual([
      "가슴",
      "등",
      "어깨",
      "팔",
      "하체",
      "코어",
    ]);
  });
});

describe("sortSwapCandidates (같은 movement_pattern 우선)", () => {
  it("지정 대체 → 같은 패턴 → 나머지 순으로 정렬한다", () => {
    const from = exercise("e_back_squat", {
      movement_pattern: "squat",
      substitutions: ["e_leg_press"],
    });
    const candidates = [
      exercise("e_leg_curl", { movement_pattern: "knee_flexion", name_ko: "레그 컬" }),
      exercise("e_goblet_squat", { movement_pattern: "squat", name_ko: "고블릿 스쿼트" }),
      exercise("e_leg_press", { movement_pattern: "knee_extension", name_ko: "레그 프레스" }),
    ];

    expect(sortSwapCandidates(candidates, from).map((item) => item.id)).toEqual([
      "e_leg_press", // substitutions 지정
      "e_goblet_squat", // 같은 패턴
      "e_leg_curl",
    ]);
  });

  it("교체 대상 정보가 없으면 이름순으로만 정렬한다", () => {
    const candidates = [exercise("b", { name_ko: "나" }), exercise("a", { name_ko: "가" })];
    expect(sortSwapCandidates(candidates, null).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("입력 배열을 변형하지 않는다", () => {
    const candidates = [exercise("b", { name_ko: "나" }), exercise("a", { name_ko: "가" })];
    sortSwapCandidates(candidates, null);
    expect(candidates.map((item) => item.id)).toEqual(["b", "a"]);
  });
});
