import { describe, expect, it } from "vitest";
import type { components, paths } from "../lib/api-types";

// 런타임 호출 없이, 코드젠 타입이 openapi 계약대로 쓰이는지 컴파일 타임으로 검증한다.
type ExercisesOk = paths["/exercises"]["get"]["responses"][200]["content"]["application/json"];
type Exercise = components["schemas"]["Exercise"];

describe("api-types (openapi 코드젠)", () => {
  it("GET /exercises 200 응답 타입을 그대로 쓸 수 있다", () => {
    const body: ExercisesOk = {
      items: [
        {
          id: "e_bench_press",
          name_ko: "바벨 벤치프레스",
          name_en: "Barbell Bench Press",
          movement_pattern: "horizontal_push",
          primary_muscles: ["chest"],
          equipment: "barbell",
          difficulty: "intermediate",
          substitutions: ["e_incline_db_press"],
          rep_range_low: 5,
          rep_range_high: 10,
          media_url: null,
        },
      ],
      next_cursor: null,
    };
    const first: Exercise | undefined = body.items[0];

    expect(first?.id).toBe("e_bench_press");
    expect(body.next_cursor).toBeNull();
  });
});
