import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Same production Web, isolated real API with only the reserved bundle provider overridden. */
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: /23-cardio-prescription-read\.spec\.ts/,
  projects: base.projects?.map((project) => ({
    ...project,
    testMatch: /23-cardio-prescription-read\.spec\.ts/,
  })),
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) =>
    index === 0
      ? {
          ...server,
          command:
            "pnpm --filter api db:migrate && pnpm --filter api db:seed && pnpm --filter api exec tsc -p test/tsconfig.v2-split-e2e.json && pnpm --filter api exec node node_modules/.v2-split-harness/test/support/v2-split-e2e-server.js",
        }
      : server,
  ),
});
