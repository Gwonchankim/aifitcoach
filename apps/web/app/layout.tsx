import type { Metadata } from "next";
import "./globals.css";
import { jetbrainsMono, pretendard } from "./fonts";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "AIFITCOACH",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // 폰트 변수는 `<html>` 에 붙인다 — globals.css 의 `:root` 가 곧 `<html>` 이라
    // `--font-sans`/`--font-mono` 가 같은 스코프에서 해석된다.
    <html lang="ko" className={`${pretendard.variable} ${jetbrainsMono.variable}`}>
      <body>
        {/* 스킵 링크: 키보드·스크린리더 사용자가 반복 내비게이션을 건너뛴다(UX_STATES §7.1). */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-fg focus:ring-3 focus:ring-focus"
        >
          본문 바로가기
        </a>
        <Providers>
          <main id="main">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
