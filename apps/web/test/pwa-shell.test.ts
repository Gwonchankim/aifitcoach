import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "..");

describe("PWA app shell contract", () => {
  it("precaches build assets and never caches API responses", async () => {
    const [sw, nextConfig, packageJson, buildLan, startLan, verifyLan] = await Promise.all([
      readFile(path.join(appRoot, "app/sw.ts"), "utf8"),
      readFile(path.join(appRoot, "next.config.mjs"), "utf8"),
      readFile(path.join(appRoot, "package.json"), "utf8"),
      readFile(path.join(appRoot, "scripts/build-lan.mjs"), "utf8"),
      readFile(path.join(appRoot, "scripts/start-lan.mjs"), "utf8"),
      readFile(path.join(appRoot, "scripts/verify-lan-pwa.mjs"), "utf8"),
    ]);

    expect(nextConfig).toContain("exclude: [/\\.woff2?$/i]");
    expect(sw).toContain('pathname.startsWith("/v1/")');
    expect(sw).toContain('pathname.startsWith("/api/v1/")');
    expect(sw).toContain('request.method === "GET"');
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw).toContain("new NetworkFirst");
    expect(sw).toContain('caches.open("afc-pages-v1")');
    expect(sw).toContain('self.addEventListener("activate"');
    expect(packageJson).toContain('"build:lan"');
    expect(packageJson).toContain('"start:lan"');
    expect(buildLan).toContain('NEXT_PUBLIC_API_BASE_URL: "/api/v1"');
    expect(startLan).toContain("createServer");
    expect(startLan).toContain('process.env.NODE_ENV = "production"');
    expect(verifyLan).toContain("navigator.serviceWorker.controller");
    expect(verifyLan).toContain('caches.open("afc-fonts-v1")');
    expect(verifyLan).toContain("context.setOffline(true)");
  });
});
