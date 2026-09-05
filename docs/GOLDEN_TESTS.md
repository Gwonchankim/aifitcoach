# 골든 테스트 사용법 (추천 엔진 계약)

- 파일: `specs/golden_tests.json` (케이스 배열). 각 케이스는 `input`과 `expect`.
- 구현: `packages/shared`의 `recommendNextSet(input)`가 모든 `expect`를 만족해야 한다.
- 테스트 러너(예: vitest/jest): golden_tests.json을 로드해 각 케이스를 파라미터라이즈 실행.
  - `expect.weight` → 반환 weight와 정확히 일치.
  - `expect.reps_low` → 반환 reps_low와 일치.
  - `expect.reason_code` → 정확 일치. `expect.reason_code_in` → 포함 중 하나.
  - `expect.e1rm` → `|반환 - 기대| <= (expect.e1rm_tolerance || defaults.e1rm_tolerance)`.
  - `expect.confidence_max` → 반환 confidence <= 값.
  - `expect.suggest_substitution` / 기타 플래그 → 반환 값과 일치.
  - `expect.recommended_action` → 대상 canonical ID를 포함한 객체 또는 null과 정확히 일치. 숫자·reason과 별도로 제안 대상을 검증한다.
- **CI 게이트**: 이 테스트는 CI의 test 스텝에 포함되어야 하며 실패 시 머지를 차단한다.
- **금지**: 통과를 위해 케이스를 삭제·완화하지 말 것. 로직이 스펙(RECOMMENDATION_ENGINE.md)과 다르면 스펙을 먼저 확인/질문.

## 예시(러너 스켈레톤, vitest)
```ts
import cases from "../../docs/specs/golden_tests.json";
import { recommendNextSet } from "../src/recommend";
describe("golden", () => {
  for (const c of cases.cases) {
    it(c.id, () => {
      const out = recommendNextSet({ ...c.input, rules_version: cases.rules_version });
      if (c.expect.weight !== undefined) expect(out.weight).toBe(c.expect.weight);
      if (c.expect.reps_low !== undefined) expect(out.reps_low).toBe(c.expect.reps_low);
      if (c.expect.reason_code) expect(out.reason_code).toBe(c.expect.reason_code);
      if (c.expect.reason_code_in) expect(c.expect.reason_code_in).toContain(out.reason_code);
      if (c.expect.e1rm !== undefined) {
        const tol = c.expect.e1rm_tolerance ?? cases.defaults.e1rm_tolerance;
        expect(Math.abs(out.e1rm - c.expect.e1rm)).toBeLessThanOrEqual(tol);
      }
    });
  }
});
```
