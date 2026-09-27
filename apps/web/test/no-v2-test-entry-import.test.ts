import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = resolve(directory, item.name);
    return item.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(item.name) ? [file] : [];
  });
}
describe("reserved bundle harness stays outside production", () => {
  it("has no test-server import, provider override, or test selector in production source", () => {
    const roots = [
      "../api/src",
      "app",
      "components",
      "lib",
      ...["hooks", "store"].filter(existsSync),
    ];
    for (const root of roots)
      for (const file of sourceFiles(resolve(root))) {
        const source = readFileSync(file, "utf8");
        expect(source, file).not.toMatch(
          /v2-split-e2e-server|overrideProvider\s*\(|NEXT_PUBLIC_[A-Z_]*(?:RULES|BUNDLE)|process\.env\.(?:AFC_)?(?:RULES_VERSION|RULES_BUNDLE)/,
        );
      }
  });
});
