import type { Recommendation, RecommendationInput } from "./types";

/**
 * 다음 세트 추천(핵심 IP). 백엔드(권위)와 프론트(오프라인 미러)가 이 함수를 공유한다.
 * STEP 3에서 docs/RECOMMENDATION_ENGINE.md 규칙대로 구현한다. 계약: docs/specs/golden_tests.json.
 */
export function recommendNextSet(_input: RecommendationInput): Recommendation {
  throw new Error("not implemented");
}
