"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ApiError, api } from "../../lib/api";

function LoadingAuth() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md items-center justify-center p-4">
      <p className="text-sm text-fg-muted" role="status">
        인증 상태를 확인하고 있어요.
      </p>
    </div>
  );
}

/**
 * App Router에는 서버 세션을 직접 읽는 middleware가 없으므로, 보호 화면에 들어오기 전에
 * `/me`로 세션을 확인한다. 인증 화면 자체는 이 검사를 건너뛴다.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = pathname.startsWith("/auth");
  const profile = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    enabled: !isPublic,
    retry: false,
  });
  const unauthenticated = profile.error instanceof ApiError && profile.error.status === 401;

  useEffect(() => {
    if (unauthenticated) router.replace("/auth");
  }, [router, unauthenticated]);

  if (isPublic) return <>{children}</>;
  if (profile.isPending || unauthenticated) return <LoadingAuth />;
  return <>{children}</>;
}
