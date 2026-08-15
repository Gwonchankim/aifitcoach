/// <reference lib="webworker" />

import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const isApiRequest = (pathname: string) =>
  pathname.startsWith("/v1/") || pathname.startsWith("/api/v1/");

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        request.method === "GET" &&
        request.mode === "navigate" &&
        !isApiRequest(url.pathname),
      handler: new NetworkFirst({
        cacheName: "afc-pages-v1",
      }),
    },
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

// The first document load happens before a newly installed worker controls the page,
// so the navigation route cannot observe it. Warm only the generic root document while
// activating; subsequent controlled navigations are refreshed by NetworkFirst.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(new Request(new URL("/", self.location.origin)));
      if (response.ok) {
        const cache = await caches.open("afc-pages-v1");
        await cache.put(new Request(new URL("/", self.location.origin)), response);
      }
    })(),
  );
});

serwist.addEventListeners();
