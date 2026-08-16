import { describe, expect, it } from "vitest";
import { appNavigation, shouldShowBottomNavigation } from "../components/navigation/app-shell";

describe("4탭 앱 셸", () => {
  it("오늘·기록·프로그램·내 정보를 실제 경로로 제공한다", () => {
    expect(appNavigation).toEqual([
      { label: "오늘", href: "/" },
      { label: "기록", href: "/history" },
      { label: "프로그램", href: "/program" },
      { label: "내 정보", href: "/profile" },
    ]);
  });

  it("세션과 온보딩에는 하단 내비게이션을 붙이지 않는다", () => {
    expect(shouldShowBottomNavigation("/onboarding")).toBe(false);
    expect(shouldShowBottomNavigation("/session/session_1")).toBe(false);
    expect(shouldShowBottomNavigation("/")).toBe(true);
    expect(shouldShowBottomNavigation("/history")).toBe(true);
  });
});
