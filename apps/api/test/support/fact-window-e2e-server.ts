import "reflect-metadata";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.setup";
import { TEST_TODAY_ENV, isoDate, utcToday } from "../../src/common/date/utc-day";

/**
 * BUG-10 E2E only (Q8). The real app — auth, CSRF, controllers, guards, storage — plus ONE
 * harness control route that moves the server's UTC "today" mid-run, so a browser scenario can
 * cross UTC midnight (KST 09:00) with the browser clock and the server on one timeline.
 *
 * The route lives only in this test bootstrap: production `src/main.ts` never registers it, this
 * file is outside `tsconfig.build.json` (which excludes `test`), and `utcToday()` still ignores the
 * override wherever `testOverridesAllowed()` is false. It also requires this run's random token.
 */
const CONTROL_PATH = "/__e2e/today";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function bootstrap() {
  const token = process.env.AFC_E2E_CONTROL_TOKEN;
  if (!token || token.length < 16)
    throw new Error("AFC_E2E_CONTROL_TOKEN (>=16 chars) is required");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  const http = app.getHttpAdapter().getInstance() as {
    post: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
  };
  http.post(CONTROL_PATH, (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const header = req.headers["x-afc-e2e-control"];
    if (!sameToken(Array.isArray(header) ? header[0] : header, token))
      return reply(403, { error: "forbidden" });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      let today: unknown;
      try {
        today = (JSON.parse(raw) as { today?: unknown }).today;
      } catch {
        return reply(400, { error: "invalid json" });
      }
      if (typeof today !== "string" || !DATE.test(today))
        return reply(400, { error: "today must be YYYY-MM-DD" });
      process.env[TEST_TODAY_ENV] = today;
      // Read back through the real clock adapter: proves the server now sees this day.
      return reply(200, { today: isoDate(utcToday()) });
    });
  });
  await app.listen(process.env.PORT ?? 3361);
}
void bootstrap();
