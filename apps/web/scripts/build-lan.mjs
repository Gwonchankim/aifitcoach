/**
 * Production PWA build for a physical device on the LAN.
 * The public API base must be baked into client chunks at build time; setting it only at start
 * would leave the phone calling localhost:3001 (the phone itself) over mixed content.
 */
/* global process */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextCli = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextCli, "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: "/api/v1" },
});

child.on("exit", (code) => process.exit(code ?? 1));
