"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  // 클라이언트당 1개. 오프라인 재시도 정책은 STEP 6에서 outbox 와 함께 다룬다.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
