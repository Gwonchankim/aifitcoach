// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exercise } from "../lib/api";
import {
  ExercisePickerSheet,
  type ExercisePickerSheetProps,
} from "../components/session/ExercisePickerSheet";
import {
  matchesExerciseSearch,
  normalizeExerciseSearch,
} from "../components/session/exercise-catalog";

const exercise = (
  id: string,
  name_ko: string,
  name_en: string,
  primary_muscles = ["chest"],
): Exercise => ({
  id,
  name_ko,
  name_en,
  primary_muscles,
  movement_pattern: "horizontal_push",
  equipment: "machine",
  difficulty: "beginner",
  mechanic: "compound",
  region: "upper",
  metric: "reps",
  step_kg: 2.5,
  default_time_low_sec: null,
  default_time_high_sec: null,
  substitutions: [],
  media_url: null,
});
const catalog = [
  exercise("e_chest_press_machine", "체스트 프레스 머신", "Chest Press Machine"),
  exercise("e_machine_row", "머신 로우", "Machine Row", ["lats"]),
  exercise("e_low_row_machine", "로우 로우 머신", "Low Row Machine", ["lats"]),
  exercise("e_high_row_machine", "하이 로우 머신", "High Row Machine", ["upper_back"]),
  exercise(
    "e_incline_chest_press_machine",
    "머신 인클라인 벤치프레스",
    "Incline Chest Press Machine",
  ),
  exercise("e_assisted_dips", "어시스트 딥스 머신", "Assisted Dip Machine"),
];
const props = (overrides: Partial<ExercisePickerSheetProps> = {}): ExercisePickerSheetProps => ({
  open: true,
  mode: { type: "add" },
  catalog,
  inRoutine: new Set(),
  pending: false,
  errorText: null,
  onSelect: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});
afterEach(cleanup);

describe("canonical catalog search", () => {
  it("normalizes whitespace and case, including blank queries", () => {
    expect(normalizeExerciseSearch(" \t LOW Row\nMachine ")).toBe("lowrowmachine");
    expect(normalizeExerciseSearch(" \t\n ")).toBe("");
  });
  it.each([
    [" 머신 벤치 프레스 ", "e_chest_press_machine"],
    ["MACHINE BENCH PRESS", "e_chest_press_machine"],
    ["시티드\t머신로우", "e_machine_row"],
    ["Seated Machine Row", "e_machine_row"],
    ["LOW ROW machine", "e_low_row_machine"],
    ["하이로우", "e_high_row_machine"],
    ["INCLINE CHEST PRESS", "e_incline_chest_press_machine"],
    ["어시스트 딥스", "e_assisted_dips"],
  ])("%s returns only %s without changing the canonical row", (query, id) => {
    expect(catalog.filter((item) => matchesExerciseSearch(item, query))).toEqual([
      catalog.find((item) => item.id === id),
    ]);
  });
  it("does not grant aliases to similarly named or unknown IDs", () => {
    expect(
      matchesExerciseSearch(
        exercise("unknown", "체스트 프레스 머신", "Chest Press Machine"),
        "머신 벤치 프레스",
      ),
    ).toBe(false);
    expect(catalog.filter((item) => matchesExerciseSearch(item, "not found"))).toEqual([]);
  });
});

describe("real add/swap picker", () => {
  it("searches all regions from chest, clears to the chosen tab and selects the canonical ID", () => {
    const inputProps = props();
    render(<ExercisePickerSheet {...inputProps} />);
    const search = screen.getByRole("searchbox", { name: "운동 검색" });
    expect(screen.queryByRole("button", { name: /^머신 로우/ })).toBeNull();
    fireEvent.change(search, { target: { value: "시티드 머신 로우" } });
    expect(screen.getByText("전체 부위에서 검색해요.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^머신 로우/ }));
    expect(inputProps.onSelect).toHaveBeenCalledWith("e_machine_row");
    fireEvent.click(screen.getByRole("button", { name: "검색어 지우기" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(screen.queryByRole("button", { name: /^머신 로우/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "등" }));
    fireEvent.change(search, { target: { value: "  \t " } });
    expect(screen.getByRole("button", { name: /^머신 로우/ })).toBeTruthy();
    expect(screen.queryByText("전체 부위에서 검색해요.")).toBeNull();
  });
  it("excludes the swap source, prioritizes substitutions, and blocks duplicate/pending selections", () => {
    const inputProps = props({
      mode: { type: "swap", exerciseId: "e_low_row_machine" },
      catalog: catalog.map((item) =>
        item.id === "e_low_row_machine" ? { ...item, substitutions: ["e_machine_row"] } : item,
      ),
      inRoutine: new Set(["e_machine_row"]),
    });
    const view = render(<ExercisePickerSheet {...inputProps} />);
    fireEvent.change(screen.getByLabelText("운동 검색"), { target: { value: "row" } });
    const results = within(screen.getByRole("tabpanel")).getAllByRole("button");
    expect(results.map((item) => item.textContent)).toEqual([
      "머신 로우머신이미 루틴에 있어요",
      "하이 로우 머신머신",
    ]);
    fireEvent.click(results[0]);
    expect(inputProps.onSelect).not.toHaveBeenCalled();
    view.rerender(<ExercisePickerSheet {...inputProps} pending />);
    fireEvent.click(screen.getByRole("button", { name: /^하이 로우 머신/ }));
    expect(inputProps.onSelect).not.toHaveBeenCalled();
  });
  it("renders no matches, keeps query on retry, and distinguishes unavailable/loading catalog", () => {
    const inputProps = props();
    const view = render(<ExercisePickerSheet {...inputProps} />);
    fireEvent.change(screen.getByLabelText("운동 검색"), { target: { value: "없는 운동" } });
    expect(screen.getByText("검색 결과가 없어요. 다른 이름으로 검색해 보세요.")).toBeTruthy();
    const onRetryCatalog = vi.fn();
    view.rerender(
      <ExercisePickerSheet
        {...inputProps}
        catalog={[]}
        catalogError="연결 후 다시 시도해 주세요."
        onRetryCatalog={onRetryCatalog}
      />,
    );
    expect(screen.queryByText(/검색 결과가 없어요/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetryCatalog).toHaveBeenCalledOnce();
    view.rerender(<ExercisePickerSheet {...inputProps} catalog={[]} catalogLoading />);
    expect(screen.getByText("운동 목록을 불러오는 중이에요.")).toBeTruthy();
    expect(screen.queryByText(/검색 결과가 없어요/)).toBeNull();
    expect((screen.getByLabelText("운동 검색") as HTMLInputElement).value).toBe("없는 운동");
  });
  it("preserves arrow-tab focus, Escape close/return, and resets search on reopen", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const inputProps = props();
    const view = render(<ExercisePickerSheet {...inputProps} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "가슴" })),
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "가슴" }), { key: "ArrowRight" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("tab", { name: "등" })),
    );
    fireEvent.change(screen.getByLabelText("운동 검색"), { target: { value: "row" } });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(inputProps.onClose).toHaveBeenCalledOnce();
    view.rerender(<ExercisePickerSheet {...inputProps} open={false} />);
    expect(document.activeElement).toBe(trigger);
    view.rerender(<ExercisePickerSheet {...inputProps} />);
    expect((screen.getByLabelText("운동 검색") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("tab", { name: "가슴" }).getAttribute("aria-selected")).toBe("true");
    trigger.remove();
  });
});
