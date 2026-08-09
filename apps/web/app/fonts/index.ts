import localFont from "next/font/local";

/**
 * 폰트는 **셀프호스팅**한다(DESIGN_TOKENS §7).
 * `fonts.googleapis.com` 을 쓰면 이 앱의 전제(PWA·오프라인)가 깨진다 — 헬스장 네트워크에서
 * 숫자가 폴백 폰트로 흔들리고, 오프라인 진입 후에는 아예 못 받는다.
 *
 * 조달: pretendard@1.3.9 의 `woff2-subset`(KS X 1001 서브셋, 원본 748KB → 261KB)와
 * @fontsource/jetbrains-mono@5.3.0 의 latin 서브셋(21KB/웨이트). 라이선스는 둘 다 OFL —
 * 원문을 이 폴더에 함께 둔다(`OFL-*.txt`).
 *
 * `preload`: Pretendard 는 4웨이트 합계가 1MB 라 preload 하지 않는다. `display: swap` 이라
 * 본문은 시스템 한글 폰트로 즉시 보이고, 느린 망에서 임계 리소스와 대역폭을 다투지 않는다.
 * 반대로 숫자(JetBrains Mono)는 합계 85KB이고 **자릿수 정렬이 흔들리면 안 되는** 값이라 preload 한다.
 */
export const pretendard = localFont({
  src: [
    { path: "./Pretendard-Regular.subset.woff2", weight: "400", style: "normal" },
    { path: "./Pretendard-Medium.subset.woff2", weight: "500", style: "normal" },
    { path: "./Pretendard-SemiBold.subset.woff2", weight: "600", style: "normal" },
    { path: "./Pretendard-Bold.subset.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-pretendard",
  display: "swap",
  preload: false,
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Noto Sans KR", "sans-serif"],
});

export const jetbrainsMono = localFont({
  src: [
    { path: "./JetBrainsMono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./JetBrainsMono-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./JetBrainsMono-latin-600.woff2", weight: "600", style: "normal" },
    { path: "./JetBrainsMono-latin-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});
