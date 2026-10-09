"use client";

// 첫 화면(/) — 로그인돼 있으면 대시보드로 보내고, 아니면 서비스 소개(랜딩) 화면을 보여준다.
// 로그아웃하면 여기로 온다.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  BarChart2, Video, Sparkles, MessageSquare, ChevronRight, Mic, Eye, Hand, LineChart,
} from "lucide-react";
import { isLoggedIn } from "@/utils/auth";

const FEATURES = [
  { icon: Eye, title: "시선·자세 분석", desc: "청중을 보고 있는지, 자세가 안정적인지 구간별로 확인해요." },
  { icon: Hand, title: "제스처 분석", desc: "손동작이 너무 적거나 산만하지 않은지 횟수와 시점으로 보여줘요." },
  { icon: Mic, title: "말하기 분석", desc: "말 속도, '음·어' 같은 필러, 반복, 긴 침묵을 찾아줘요." },
  { icon: LineChart, title: "회차별 비교", desc: "연습을 거듭할수록 무엇이 나아졌는지 한눈에 비교해요." },
];

const STEPS = [
  { icon: Video, title: "발표 촬영", desc: "웹캠으로 바로 찍거나 영상 파일을 올려요." },
  { icon: Sparkles, title: "AI 분석", desc: "몸짓과 목소리를 구간별로 나눠 분석해요." },
  { icon: MessageSquare, title: "피드백 확인", desc: "구간별 개선점과 종합 총평을 받아봐요." },
];

export default function LandingPage() {
  const router = useRouter();
  // 로그인 여부를 확인하기 전에는 아무것도 그리지 않는다 (로그인 사용자에게 랜딩이 깜빡이지 않게).
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) router.replace("/dashboard");
    else setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {/* 상단 바 */}
      <header className="h-20 bg-white/80 backdrop-blur-md border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto h-full px-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-2 rounded-xl shadow-sm shadow-blue-200">
              <BarChart2 className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">발표 영상 분석</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-800 transition-colors"
            >
              로그인
            </Link>
            <Link
              href="/signup"
              className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 transition-colors"
            >
              회원가입
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-16 space-y-16">
        {/* 소개 */}
        <section className="text-center space-y-6">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 px-3 py-1 rounded-full">
            <Sparkles className="w-3.5 h-3.5" />
            AI 발표 코치
          </span>
          <h2 className="text-4xl md:text-5xl font-extrabold text-slate-800 leading-tight tracking-tight">
            발표 연습 영상 한 편으로<br />
            말하기와 태도를 함께 점검하세요
          </h2>
          <p className="text-slate-500 text-lg leading-relaxed max-w-2xl mx-auto">
            촬영만 하면 목소리와 몸짓을 구간별로 분석해서
            무엇을 고치면 좋을지 구체적으로 알려드려요.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-6 py-3.5 rounded-xl transition-colors shadow-sm shadow-blue-200"
            >
              무료로 시작하기
              <ChevronRight className="w-4 h-4" />
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 bg-white hover:bg-slate-50 text-slate-700 text-sm font-bold px-6 py-3.5 rounded-xl border border-slate-200 transition-colors"
            >
              로그인
            </Link>
          </div>
        </section>

        {/* 분석 항목 */}
        <section>
          <h3 className="text-lg font-bold text-slate-800 mb-4">무엇을 분석하나요?</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="bg-white rounded-2xl border border-slate-200 p-6">
                  <div className="bg-blue-50 p-2 rounded-lg w-fit mb-3">
                    <Icon className="w-5 h-5 text-blue-600" />
                  </div>
                  <p className="font-bold text-slate-800">{f.title}</p>
                  <p className="text-sm text-slate-500 mt-1 leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* 이용 방법 */}
        <section>
          <h3 className="text-lg font-bold text-slate-800 mb-4">이렇게 사용해요</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="bg-white rounded-2xl border border-slate-200 p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="bg-blue-50 p-2 rounded-lg">
                      <Icon className="w-5 h-5 text-blue-600" />
                    </div>
                    <span className="text-xs font-bold text-slate-400">STEP {i + 1}</span>
                  </div>
                  <p className="font-bold text-slate-800">{step.title}</p>
                  <p className="text-sm text-slate-500 mt-1 leading-relaxed">{step.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* 마무리 */}
        <section className="bg-blue-600 rounded-3xl p-10 text-center space-y-4 shadow-sm shadow-blue-200">
          <h3 className="text-2xl font-extrabold text-white">다음 발표, 미리 연습해 보세요</h3>
          <p className="text-blue-100">가입하고 첫 발표 영상을 분석해 보세요.</p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 bg-white hover:bg-blue-50 text-blue-700 text-sm font-bold px-6 py-3.5 rounded-xl transition-colors"
          >
            시작하기
            <ChevronRight className="w-4 h-4" />
          </Link>
        </section>
      </main>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} Podium
      </footer>
    </div>
  );
}
