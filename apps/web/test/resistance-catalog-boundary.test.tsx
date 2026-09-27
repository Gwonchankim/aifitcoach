// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exercise } from "../lib/api";
import { ExercisePickerSheet } from "../components/session/ExercisePickerSheet";
import {
  isResistanceCatalogExercise,
  requireResistanceCatalogExercise,
} from "../components/session/exercise-catalog";
import { errorMessage } from "../components/session/errors";

const resistance: Exercise = {
  id: "e_bench_press",
  name_ko: "벤치프레스",
  name_en: "Bench press",
  modality: "resistance",
  movement_pattern: "horizontal_push",
  mechanic: "compound",
  region: "upper",
  primary_muscles: ["chest"],
  equipment: "barbell",
  difficulty: "beginner",
  metric: "reps",
  step_kg: 2.5,
  default_time_low_sec: null,
  default_time_high_sec: null,
  substitutions: [],
  media_url: null,
};

afterEach(cleanup);

describe("resistance catalog editing boundary", () => {
  it("accepts complete resistance and complete legacy classification without guessing load semantics", () => {
    expect(isResistanceCatalogExercise(resistance)).toBe(true);
    expect(isResistanceCatalogExercise({ ...resistance, modality: null })).toBe(true);
    expect(requireResistanceCatalogExercise(resistance)).toBe(resistance);
    expect("load_semantics" in requireResistanceCatalogExercise(resistance)).toBe(false);
  });

  it.each([
    { modality: "cardio" },
    { modality: "mobility" },
    { modality: "warmup" },
    { mechanic: null },
    { region: null },
    { movement_pattern: null },
    { modality: null, mechanic: null },
    { movement_pattern: "unknown" },
  ] satisfies Partial<Exercise>[])(
    "rejects unsupported edit metadata %j using existing action error",
    (patch) => {
      const exercise = { ...resistance, ...patch };
      expect(isResistanceCatalogExercise(exercise)).toBe(false);
      expect(() => requireResistanceCatalogExercise(exercise)).toThrow();
      try {
        requireResistanceCatalogExercise(exercise);
      } catch (error) {
        expect(errorMessage(error, "add")).toBe(
          "선택한 운동을 추가할 수 없어요. 다른 운동을 골라 주세요.",
        );
        expect(errorMessage(error, "swap")).toBe(
          "선택한 운동으로 바꿀 수 없어요. 다른 운동을 골라 주세요.",
        );
      }
    },
  );

  it("does not offer nonresistance or incomplete rows in tabs or global search", () => {
    const onSelect = vi.fn();
    render(
      <ExercisePickerSheet
        open
        mode={{ type: "add" }}
        catalog={[
          resistance,
          { ...resistance, id: "bad-cardio", name_ko: "유산소 후보", modality: "cardio" },
          { ...resistance, id: "bad-null", name_ko: "미확인 후보", mechanic: null },
        ]}
        inRoutine={new Set()}
        pending={false}
        errorText={null}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^유산소 후보/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^미확인 후보/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "운동 검색" }), {
      target: { value: "후보" },
    });
    expect(screen.queryByRole("button", { name: /^유산소 후보/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^미확인 후보/ })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
