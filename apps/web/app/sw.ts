/// <reference lib="webworker" />

import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/**
 * T-UI-2의 범위는 폰트 런타임 캐시뿐이다.
 * 앱 셸·API·동기화 캐시는 STEP 6에서 별도 계약과 함께 연결한다.
 */
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin && request.destination === "font" && url.pathname.endsWith(".woff2"),
      handler: new CacheFirst({
        cacheName: "afc-fonts-v1",
        // E2E가 HTTP 캐시를 비운 뒤 probe query를 붙여도 같은 해시 자산을 실제 SW에서 읽게 한다.
        matchOptions: { ignoreSearch: true },
        plugins: [
          new ExpirationPlugin({
            maxEntries: 128,
            maxAgeSeconds: 365 * 24 * 60 * 60,
          }),
        ],
      }),
    },
  ],
});

serwist.addEventListeners();
