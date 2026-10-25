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
      },
      animation: {
        "fade-up": "fade-up 0.3s ease-out both",
      },
    },
  },
  plugins: [],
};
export default config;
