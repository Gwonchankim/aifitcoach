import { describe, expect, it } from "vitest";
import { cn } from "../components/ui/cn";

describe("cn", () => {
  it("같은 Tailwind 클래스 그룹에서는 뒤의 클래스를 남긴다", () => {
    expect(cn("rounded-full", "rounded-card")).toBe("rounded-card");
  });
});
