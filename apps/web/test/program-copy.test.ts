import { describe, expect, it } from "vitest";
import type { Program } from "../lib/api";
import { excludedHeading, excludedReason, whyThisRoutine } from "../app/program/program-copy";
import { formatKg, formatNumber, formatRate } from "../lib/program-labels";

function program(patch: Partial<Program> = {}): Program {
  return {
    program_id: "p_1",
    goal: "hypertrophy",
    split_type: "upper_lower",
    rules_version: "2026.08.1",
    excluded_exercises: [],
    sessions: [
      { day: "MON", focus: "upper", exercises: new Array(5).fill(null).map(() => exercise()) },
      { day: "TUE", focus: "lower", exercises: new Array(5).fill(null).map(() => exercise()) },
    ],
    ...patch,
  } as Program;
}

function exercise() {
  return {
    exercise_id: "e_bench_press",
    sets: 3,
    reps_low: 8,
    reps_high: 12,
    target_rir: 2,
    rest_sec: 120,
  };
}

describe("'왜 이 루틴'", () => {
  it("목표·일수·분할·운동 수로 문장을 만든다", () => {
    expect(whyThisRoutine(program())).toEqual([
      "근비대 목표에 맞춰 주 2일 상·하체 분할 방식으로 짰어요.",
      "운동하는 날마다 운동 5개를 배치했어요.",
    ]);
  });

  it("서버가 실제로 내려주는 push_pull_legs 도 한국어로 읽는다", () => {
    const lines = whyThisRoutine(program({ split_type: "push_pull_legs" }));
    expect(lines[0]).toContain("밀기·당기기·하체 분할");
  });

  it("모르는 split_type 은 분할 문구를 통째로 생략한다 (AC-S2-1)", () => {
    const lines = whyThisRoutine(program({ split_type: "bro_split" }));
    expect(lines[0]).toBe("근비대 목표에 맞춰 주 2일 짰어요.");
    expect(lines.join(" ")).not.toContain("bro_split");
  });

  it("세션이 없으면 문장을 만들지 않는다", () => {
    expect(whyThisRoutine(program({ sessions: [] }))).toEqual([]);
  });
});

describe("제외 운동 섹션", () => {
  it("제외가 있으면 개수를 제목에 넣는다", () => {
    expect(excludedHeading(3)).toBe("안전을 위해 뺀 운동 3개");
  });

  it("제외가 0건이면 그 사실을 알린다", () => {
    expect(excludedHeading(0)).toBe("안전을 위해 뺀 운동은 없어요");
  });

  it("사유는 부위 라벨로 다시 쓴다 — movement_pattern 원문을 쓰지 않는다", () => {
    expect(excludedReason("knee")).toBe("무릎에 부담이 큰 동작이라 뺐어요.");
    expect(excludedReason("squat")).toBeNull();
  });
});

describe("숫자 표기 (UX_STATES §1.3)", () => {
  it("정수면 소수점을 생략하고, 소수는 1자리까지 쓴다", () => {
    expect(formatNumber(60)).toBe("60");
    expect(formatNumber(62.5)).toBe("62.5");
    expect(formatNumber(62.44)).toBe("62.4");
    expect(formatNumber(3450)).toBe("3,450");
  });

  it("무게에는 kg 단위를 붙인다", () => {
    expect(formatKg(62.5)).toBe("62.5kg");
  });

  it("완료율은 0~1 비율을 백분율로 바꾸고 범위를 벗어난 값은 잘라낸다", () => {
    expect(formatRate(0.25)).toBe("25%");
    expect(formatRate(1.4)).toBe("100%");
    expect(formatRate(-1)).toBe("0%");
  });
});
