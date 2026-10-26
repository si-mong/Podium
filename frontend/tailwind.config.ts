import type { Config } from "tailwindcss";
import defaultColors from "tailwindcss/colors";
import plugin from "tailwindcss/plugin";

// ── 다크 모드 ────────────────────────────────────────────────────────────────
// 화면마다 dark: 클래스를 붙이는 대신, 색 팔레트 자체를 CSS 변수로 바꿔서 한 번에 처리한다.
//   - 라이트: 원래 Tailwind 색 그대로
//   - 다크(<html class="dark">): 단계를 뒤집는다 (50↔950, 100↔900 …). 밝은 배경은 어둡게, 진한 글자는 밝게.
//   - white 는 카드 배경으로 많이 써서 다크에서는 stone-900, 페이지 배경(stone-50)은 stone-950 이 된다.
//   - black 은 영상 배경·덮개라 바꾸지 않는다.
// 모드 전환은 components/ThemeToggle.tsx, 깜빡임 방지 스크립트는 app/layout.tsx.
const THEMED = ["slate", "stone", "red", "orange", "amber", "yellow", "green", "emerald", "teal", "sky", "blue", "indigo", "purple", "pink", "rose"] as const;
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;
const FLIP: Record<string, string> = { "50": "950", "100": "900", "200": "800", "300": "700", "400": "600", "500": "500", "600": "400", "700": "300", "800": "200", "900": "100", "950": "50" };

const rgb = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const palette = (name: string) => defaultColors[name as keyof typeof defaultColors] as unknown as Record<string, string>;

const themedColors: Record<string, string | Record<string, string>> = {
  white: "rgb(var(--c-white) / <alpha-value>)",
};
const lightVars: Record<string, string> = { "--c-white": "255 255 255" };
const darkVars: Record<string, string> = { "--c-white": rgb(palette("stone")["900"]) };
for (const name of THEMED) {
  themedColors[name] = Object.fromEntries(SHADES.map((s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]));
  for (const s of SHADES) {
    lightVars[`--c-${name}-${s}`] = rgb(palette(name)[s]);
    darkVars[`--c-${name}-${s}`] = rgb(palette(name)[FLIP[s]]);
  }
}
// 다크에서 페이지 배경(stone-50)과 카드(white)가 구분되도록 stone-50 은 한 단계 더 어둡게
darkVars["--c-stone-50"] = "12 10 9";

const config: Config = {
  darkMode: "class",
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
        ...themedColors,
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
  plugins: [
    plugin(({ addBase }) => {
      addBase({ ":root": lightVars, ":root.dark": { ...darkVars, colorScheme: "dark" } });
    }),
  ],
};
export default config;
