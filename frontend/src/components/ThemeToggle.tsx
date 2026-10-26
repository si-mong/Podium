"use client";

// 라이트/다크 모드 전환 버튼 — layout.tsx 에서 모든 화면 오른쪽 아래에 띄운다.
// 고른 모드는 localStorage("podium_theme")에 저장하고, 고른 적이 없으면 운영체제 설정을 따른다.
// 첫 화면이 하얗게 번쩍이지 않도록 처음 적용은 layout.tsx 의 <head> 스크립트가 먼저 한다.

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_KEY } from "@/utils/theme";

export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);   // null: 아직 모름 (서버 렌더링 중)

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {}
  };

  if (dark === null) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "라이트 모드로 바꾸기" : "다크 모드로 바꾸기"}
      title={dark ? "라이트 모드" : "다크 모드"}
      className="fixed bottom-4 right-4 z-50 w-11 h-11 rounded-full bg-stone-900 text-white shadow-lg flex items-center justify-center hover:bg-stone-700 transition-colors"
    >
      {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}
