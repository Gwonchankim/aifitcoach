import { configDefaults, defineConfig } from "vitest/config";

/**
 * vitest 는 `test/**` 의 유닛 테스트만 돈다.
 * `e2e/**` 는 Playwright 전용이라 여기서 제외한다(둘이 섞이면 `pnpm --filter web test` 가 깨진다).
 */
export default defineConfig({
  // tsconfig 의 `jsx: "preserve"` 는 Next 빌드용이라 vite 가 tsx 를 그대로 둔다.
  // 컴포넌트 렌더 결과를 검증하려면 여기서 JSX 를 실제로 변환해야 한다(vite 8 = oxc).
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
