"use client";

// 서비스 안내 화면 — 로그인 전 첫 화면(/)과 로그인 후 홈(/home)이 똑같이 쓴다.
//   1) 한 줄 소개
//   2) 이렇게 사용해요: 실제 화면 이름 그대로 5단계 순서 (스크롤 따라 진행 — UsageSteps.tsx)
// 두 화면의 차이는 상단 오른쪽 버튼(headerActions)과 시작 버튼(primaryAction)뿐이다.

import type { ReactNode } from "react";
import Link from "next/link";
import { BarChart2, ChevronRight } from "lucide-react";
import UsageSteps from "./UsageSteps";

interface Props {
  headerActions: ReactNode; // 상단 오른쪽 버튼들 (로그인/회원가입 또는 내 기록/로그아웃)
  primaryAction: { label: string; onClick: () => void }; // 소개 아래 큰 버튼
  secondaryAction?: { label: string; onClick: () => void };
}

export default function ServiceGuide({ headerActions, primaryAction, secondaryAction }: Props) {
  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {/* 상단 바 */}
      <header className="h-20 bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto h-full px-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-2 rounded-xl">
              <BarChart2 className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">Podium</h1>
          </div>
          <div className="flex items-center gap-2">{headerActions}</div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-14 space-y-14">
        {/* 1) 한 줄 소개 */}
        <section className="motion-safe:animate-fade-up">
          <h2 className="text-3xl md:text-4xl font-extrabold text-slate-800 leading-snug tracking-tight">
            발표 영상을 찍으면,<br />
            구간마다 무엇을 고치면 좋을지 알려드려요
          </h2>
          <p className="mt-4 text-slate-500 leading-relaxed max-w-2xl">
            Podium은 발표 연습 영상에서 목소리와 제스쳐를 분석하고, 발표를 내용 흐름에 따라 구간으로 나눠
            구간별 피드백과 전체 총평을 보여줘서 발표 연습을 도와줘요.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              onClick={primaryAction.onClick}
              className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-5 py-3 rounded-xl transition-colors"
            >
              {primaryAction.label}
              <ChevronRight className="w-4 h-4" />
            </button>
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="inline-flex items-center bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-sm font-bold px-5 py-3 rounded-xl transition-colors"
              >
                {secondaryAction.label}
              </button>
            )}
          </div>
        </section>

        {/* 2) 이렇게 사용해요 — 스크롤하면 단계가 하나씩 켜지고 오른쪽 그림이 바뀐다 (UsageSteps.tsx) */}
        <section className="motion-safe:animate-fade-up [animation-delay:80ms]">
          <h3 className="text-xl font-extrabold text-slate-800">이렇게 사용해요</h3>
          <div className="mt-8">
            <UsageSteps />
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} Podium ·{" "}
        <Link href="/terms" className="hover:text-slate-600 hover:underline">이용약관</Link> ·{" "}
        <Link href="/privacy" className="hover:text-slate-600 hover:underline">개인정보 처리방침</Link>
      </footer>
    </div>
  );
}
