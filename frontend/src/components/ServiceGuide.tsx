"use client";

// 서비스 안내 화면 — 로그인 전 첫 화면(/)과 로그인 후 홈(/home)이 똑같이 쓴다.
//   1) 가운데 떠 있는 알약 모양 상단 바 (Podium 워드마크 + 오른쪽 버튼)
//   2) 소개: 작은 아이콘 타일 + 아주 큰 제목 + 사실 한 줄 + 검은 알약 버튼
//   3) 분석하는 항목 (회색 글자 한 줄)
//   4) 이렇게 사용해요: 스크롤 따라 진행 — UsageSteps.tsx
// 디자인: 파란색 없이 검정·흰색·따뜻한 회색(stone)만 쓰고, 글꼴은 Pretendard (layout.tsx 에서 불러옴).
// 두 화면의 차이는 상단 오른쪽 버튼(headerActions)과 시작 버튼(primaryAction)뿐이다.

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import UsageSteps from "./UsageSteps";

interface Props {
  headerActions: ReactNode; // 상단 오른쪽 버튼들 (로그인/회원가입 또는 내 기록/로그아웃)
  primaryAction: { label: string; onClick: () => void }; // 소개 아래 검은 버튼
  secondaryAction?: { label: string; onClick: () => void };
}

// 분석하는 항목 — 실제로 분석하는 것만 적는다
const ANALYSIS_ITEMS = ["발화 속도", "필러", "무음", "반복", "제스처", "시선", "자세"];

// Podium 기호: 발표 단상(2등·1등·3등 단) 모양. 글자색(currentColor)을 따른다.
export function PodiumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <rect x="1" y="11" width="7" height="11" rx="1.5" />
      <rect x="8.5" y="4" width="7" height="18" rx="1.5" />
      <rect x="16" y="14" width="7" height="8" rx="1.5" />
    </svg>
  );
}

export default function ServiceGuide({ headerActions, primaryAction, secondaryAction }: Props) {
  return (
    <div className="min-h-screen bg-white text-stone-900 font-['Pretendard_Variable',Pretendard,sans-serif]">
      {/* 1) 상단 바 — 화면 가운데 떠 있는 알약 모양 */}
      <div className="sticky top-4 z-20 px-4">
        <header className="max-w-2xl mx-auto h-14 rounded-full bg-stone-100/90 backdrop-blur flex items-center justify-between pl-6 pr-2">
          <div className="flex items-center gap-1.5">
            <PodiumMark className="w-5 h-5" />
            <span className="text-lg font-extrabold tracking-tight">Podium</span>
          </div>
          <div className="flex items-center gap-1">{headerActions}</div>
        </header>
      </div>

      <main className="max-w-5xl mx-auto px-6">
        {/* 2) 소개 */}
        <section className="pt-24 pb-16 text-center motion-safe:animate-fade-up">
          {/* 작은 아이콘 타일 */}
          <div className="mx-auto w-16 h-16 rounded-2xl bg-stone-100 shadow-[inset_0_-2px_0_rgba(0,0,0,0.06)] flex items-center justify-center">
            <PodiumMark className="w-8 h-8 text-stone-800" />
          </div>

          <h1 className="mt-8 text-5xl md:text-6xl font-extrabold tracking-[-0.04em] leading-[1.1]">
            발표 연습,
            <br />
            구간마다 고쳐보세요.
          </h1>
          <p className="mt-6 text-lg text-stone-500 leading-relaxed">
            목소리와 제스처, 시선을 분석하고 발표를 내용 흐름에 따라 구간으로 나눠
            <br className="hidden md:block" />
            구간별 피드백과 전체 총평을 보여줍니다.
          </p>

          <div className="mt-8 flex items-center justify-center gap-2">
            <button
              onClick={primaryAction.onClick}
              className="h-11 px-5 rounded-full bg-stone-900 hover:bg-stone-700 text-white text-[15px] font-semibold transition-colors"
            >
              {primaryAction.label}
            </button>
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="h-11 pl-5 pr-2 rounded-full border border-stone-300 hover:bg-stone-50 text-[15px] font-semibold flex items-center gap-2 transition-colors"
              >
                {secondaryAction.label}
                <span className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center">
                  <ArrowRight className="w-4 h-4" />
                </span>
              </button>
            )}
          </div>

          {/* 3) 분석하는 항목 — 회색 글자 한 줄 */}
          <div className="mt-20">
            <p className="text-sm text-stone-500">분석하는 항목</p>
            <ul className="mt-5 flex flex-wrap justify-center gap-x-10 gap-y-3">
              {ANALYSIS_ITEMS.map((item) => (
                <li key={item} className="text-xl font-bold tracking-tight text-stone-400">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 4) 이렇게 사용해요 — 스크롤하면 단계가 하나씩 켜지고 오른쪽 그림이 바뀐다 (UsageSteps.tsx) */}
        <section className="pt-16 border-t border-stone-200 motion-safe:animate-fade-up [animation-delay:80ms]">
          <h2 className="text-3xl font-extrabold tracking-[-0.03em]">이렇게 사용해요.</h2>
          <div className="mt-10">
            <UsageSteps />
          </div>
        </section>
      </main>

      <footer className="mt-16 border-t border-stone-200 py-8 text-center text-xs text-stone-400">
        © {new Date().getFullYear()} Podium ·{" "}
        <Link href="/terms" className="hover:text-stone-600 hover:underline">이용약관</Link> ·{" "}
        <Link href="/privacy" className="hover:text-stone-600 hover:underline">개인정보 처리방침</Link>
      </footer>
    </div>
  );
}
