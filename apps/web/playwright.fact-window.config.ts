import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * BUG-10 fact-window E2E (Q8): the same production web build and real API, except the API is the
 * test-only bootstrap with one control route that moves the server's UTC "today" mid-run
 * (apps/api/test/support/fact-window-e2e-server.ts). The browser clock is moved by the spec, so a
 * workout can cross UTC midnight (KST 09:00) with both clocks on one timeline.
 *
 * The control token is generated once in the runner process and inherited by the API server and
 * the worker (workers re-load this file and keep the inherited value).
 */
const CONTROL_TOKEN = process.env.AFC_E2E_CONTROL_TOKEN ?? randomBytes(16).toString("hex");
process.env.AFC_E2E_CONTROL_TOKEN = CONTROL_TOKEN;
const SPEC = /24-fact-window\.spec\.ts/;

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: SPEC,
  projects: base.projects?.map((project) => ({ ...project, testMatch: SPEC })),
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, index) =>
    index === 0
      ? {
          ...server,
          command:
            "pnpm --filter api db:migrate && pnpm --filter api db:seed && pnpm --filter api exec tsc -p test/tsconfig.fact-window-e2e.json && pnpm --filter api exec node node_modules/.fact-window-harness/test/support/fact-window-e2e-server.js",
          env: { ...server.env, AFC_E2E_CONTROL_TOKEN: CONTROL_TOKEN },
        }
      : server,
  ),
});
