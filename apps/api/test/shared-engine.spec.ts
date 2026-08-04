import { recommendNextSet } from "shared";
import type { RecommendationInput } from "shared";

/**
 * 배선 스모크: 백엔드(권위)가 packages/shared의 추천 엔진을 실제로 import 해 쓸 수 있는지 확인한다.
 * 계약 자체는 packages/shared의 골든 테스트가 검증한다(여기서 규칙을 재검증하지 않는다).
 */
describe("shared 추천 엔진 배선", () => {
  it("api에서 recommendNextSet를 호출할 수 있다", () => {
    const input: RecommendationInput = {
      goal: "hypertrophy",
      exercise: { type: "compound", region: "upper", step_kg: 2.5 },
      target: { reps_low: 8, reps_high: 12, rir: 2 },
      last_sets: [
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
        { w: 60, reps: 12, rir: 2 },
      ],
      rules_version: "2026.07.1",
    };

    const out = recommendNextSet(input);

    expect(out.weight).toBe(62.5);
    expect(out.reason_code).toBe("WEIGHT_UP_REP_TARGET_MET");
    expect(out.rules_version).toBe("2026.07.1");
  });
});
