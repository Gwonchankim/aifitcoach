import path from "node:path";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";

/** Next 앱 루트. cwd 가 루트든 apps/web 이든(=`next build` 내부 lint) 같은 곳을 가리켜야 한다. */
const WEB_DIR = path.join(import.meta.dirname, "apps", "web");

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "apps/web/next-env.d.ts",
      // Playwright/Lighthouse 산출물(도구 생성물)
      "apps/web/e2e/.artifacts/**",
      "apps/web/e2e/.report/**",
      "apps/web/e2e/lighthouse/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // 타입 검사가 담당하므로 끈다(jest/vitest 전역, Node 전역 오탐 방지).
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  /**
   * Next.js 앱 전용 규칙(apps/web). `next build` 가 경고하던 두 플러그인을 여기서 켠다.
   * - @next/eslint-plugin-next: next 와 같은 버전으로 고정한다.
   * - eslint-plugin-react-hooks 5.x: eslint-config-next 15 가 쓰는 계열(훅 규칙만, 컴파일러 규칙 없음).
   * exhaustive-deps 는 recommended 기본값이 warn 이지만, 경고를 남기지 않기 위해 error 로 올린다.
   */
  {
    // 이 설정 파일 자신도 포함한다 — `next build` 는 **설정 파일**의 config 를 계산해
    // 플러그인 등록 여부를 판정한다(안 넣으면 "plugin was not detected" 경고가 남는다).
    files: ["apps/web/**/*.{ts,tsx}", "eslint.config.mjs"],
    // 모노레포라 Next 앱 루트를 알려줘야 app 디렉터리를 찾는다(no-html-link-for-pages).
    settings: { next: { rootDir: WEB_DIR } },
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
    },
  },
  prettier,
);
