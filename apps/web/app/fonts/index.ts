import localFont from "next/font/local";

/**
 * 폰트는 **셀프호스팅**한다(DESIGN_TOKENS §7).
 * `fonts.googleapis.com` 을 쓰면 이 앱의 전제(PWA·오프라인)가 깨진다 — 헬스장 네트워크에서
 * 숫자가 폴백 폰트로 흔들리고, 오프라인 진입 후에는 아예 못 받는다.
 *
 * 조달: Pretendard 는 공식 1.3.9 Variable Dynamic Subset 92개를
 * `pretendard-variable.css`가 unicode-range로 선택한다. `next/font/local`은 unicode-range를
 * 지원하지 않아 Pretendard만 별도 CSS이고, JetBrains Mono는 @fontsource 5.3.0의 latin
 * 서브셋(21KB/웨이트)을 계속 쓴다. 라이선스는 둘 다 OFL — 원문은 `OFL-*.txt`에 둔다.
 *
 * Pretendard는 `display: swap`과 수동 fallback metrics로 초기 표시와 레이아웃을 지키며,
 * 사용 글리프 슬라이스만 요청한다. 숫자(JetBrains Mono)는 합계 85KB이고
 * **자릿수 정렬이 흔들리면 안 되는** 값이라 preload 한다.
 */
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
