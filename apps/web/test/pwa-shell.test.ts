import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "..");

describe("PWA app shell contract", () => {
  it("precaches build assets and never caches API responses", async () => {
    const [sw, nextConfig] = await Promise.all([
      readFile(path.join(appRoot, "app/sw.ts"), "utf8"),
      readFile(path.join(appRoot, "next.config.mjs"), "utf8"),
    ]);

    expect(nextConfig).toContain("exclude: [/\\.woff2?$/i]");
    expect(sw).toContain('pathname.startsWith("/v1/")');
    expect(sw).toContain('pathname.startsWith("/api/v1/")');
    expect(sw).toContain('request.method === "GET"');
    expect(sw).toContain('request.mode === "navigate"');
    expect(sw).toContain("new NetworkFirst");
    expect(sw).toContain('caches.open("afc-pages-v1")');
    expect(sw).toContain('self.addEventListener("activate"');
  });
});
