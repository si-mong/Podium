import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import ThemeToggle from "@/components/ThemeToggle";
import { THEME_KEY } from "@/utils/theme";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Podium · AI 발표 연습",
  description: "발표 영상을 올리면 말하기와 제스처를 분석해 구간별 피드백을 드려요.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: 아래 스크립트가 렌더링 전에 class="dark" 를 붙여서 서버 HTML 과 달라지는 건 의도한 것
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* 다크 모드를 화면이 그려지기 전에 적용 (안 하면 다크 사용자에게 흰 화면이 잠깐 번쩍인다) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`,
          }}
        />
        {/* 한글 글꼴 Pretendard (무료). 홈·첫 화면(ServiceGuide)에서 쓴다.
            dynamic-subset: 화면에 실제로 나온 글자 조각만 내려받아서 가볍다 */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <ThemeToggle />
      </body>
    </html>
  );
}
