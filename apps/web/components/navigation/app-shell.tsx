"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const appNavigation = [
  { label: "오늘", href: "/" },
  { label: "기록", href: "/history" },
  { label: "프로그램", href: "/program" },
  { label: "내 정보", href: "/profile" },
] as const;

export function shouldShowBottomNavigation(pathname: string): boolean {
  return (
    pathname !== "/onboarding" && !pathname.startsWith("/session/") && !pathname.startsWith("/auth")
  );
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const showNavigation = shouldShowBottomNavigation(pathname);

  return (
    <>
      <main
        id="main"
        className={showNavigation ? "pb-[calc(50px+env(safe-area-inset-bottom))]" : undefined}
      >
        {children}
      </main>
      {showNavigation ? <BottomNavigation pathname={pathname} /> : null}
    </>
  );
}

function BottomNavigation({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="주요 탐색"
      className="fixed inset-x-0 bottom-0 z-40 mx-auto flex min-h-[calc(50px+env(safe-area-inset-bottom))] max-w-md border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      {appNavigation.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-inset ${
              active ? "text-primary" : "text-fg-muted"
            }`}
          >
            <span aria-hidden="true" className="text-[15px] leading-none">
              {active ? "●" : "○"}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
