import type { Exercise } from "@prisma/client";
import {
  DIFFICULTY_RANK,
  selectExercises,
  type SelectionOptions,
} from "../src/programs/programs.service";
import { scheduleFor, splitTypeFor } from "../src/programs/program-rules";

const BEGINNER_OPTIONS: SelectionOptions = {
  levelRank: DIFFICULTY_RANK.beginner,
  preferStable: false,
  substituteMuscles: new Set(),
};

function exercise(
  id: string,
  difficulty: Exercise["difficulty"],
  mechanic: Exercise["mechanic"],
): Exercise {
  return {
    id,
    nameKo: id,
    nameEn: id,
    movementPattern: "horizontal_push",
    mechanic,
    region: "upper",
    primaryMuscles: ["chest"],
    secondaryMuscles: [],
    equipment: "bodyweight",
    difficulty,
    metric: "reps",
    defaultRepsLow: 6,
    defaultRepsHigh: 12,
    defaultTimeLowSec: null,
    defaultTimeHighSec: null,
    defaultStepKg: null,
    unilateral: false,
    substitutions: [],
    cues: [],
    media: {},
  };
}

describe("프로그램 운동 선택 안전 계약", () => {
  it("beginner에게 intermediate·advanced 운동을 처방하지 않는다", () => {
    const selected = selectExercises(
      [
        exercise("e_advanced_deadlift", "advanced", "compound"),
        exercise("e_beginner_pushup", "beginner", "compound"),
      ],
      ["horizontal_push", "horizontal_push"],
      2,
      BEGINNER_OPTIONS,
    );

    expect(selected.map((item) => item.id)).toEqual(["e_beginner_pushup"]);
    expect(
      selected.every((item) => DIFFICULTY_RANK[item.difficulty] <= DIFFICULTY_RANK.beginner),
    ).toBe(true);
  });

  it("같은 패턴에서는 compound를 먼저 고르고 isolation으로 보충한다", () => {
    const selected = selectExercises(
      [
        exercise("e_a_isolation", "beginner", "isolation"),
        exercise("e_z_compound", "beginner", "compound"),
      ],
      ["horizontal_push", "horizontal_push"],
      2,
      BEGINNER_OPTIONS,
    );

    expect(selected.map((item) => item.mechanic)).toEqual(["compound", "isolation"]);
  });
});

describe("주 5일 분할 빈도 계약", () => {
  it("upper/lower를 각각 주 2회 이상 반복한다", () => {
    const focuses = scheduleFor(5).map((item) => item.focus);

    expect(focuses).toEqual(["upper", "lower", "upper", "lower", "upper"]);
    expect(focuses.filter((focus) => focus === "upper")).toHaveLength(3);
    expect(focuses.filter((focus) => focus === "lower")).toHaveLength(2);
    expect(splitTypeFor(5)).toBe("upper_lower");
  });
});
