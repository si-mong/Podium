import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      // 화면이 처음 뜰 때 살짝 나타나기 (흐릿하게 → 선명하게 + 8px 아래에서 올라옴, 0.3초).
      // 사용: className="motion-safe:animate-fade-up" — 운영체제에서 "애니메이션 줄이기"를 켠 사용자에겐 안 움직인다.
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // 첫 화면 "분석하는 항목": 선택된 항목 아래 막대가 차오르며 다음 항목으로 넘어갈 때까지 남은 시간을 보여준다
        "fill-x": {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.3s ease-out both",
        "fill-x": "fill-x var(--fill-duration, 2.4s) linear both",
      },
    },
  },
  plugins: [],
};
export default config;
