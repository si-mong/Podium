import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Podium - 발표 연습 분석",
  description: "AI 발표 코치 - 발화 연습 영상을 분석하여 피드백을 제공합니다.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
