"use client";

// 홈 화면(/home) — 서비스 소개 + 내 연습 요약 + 최근 기록 바로가기.
// 대시보드 사이드바 로고를 누르면 여기로 온다.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BarChart2, Video, Sparkles, MessageSquare, FolderOpen, ChevronRight, Loader2, Mic, Eye, LogOut,
} from "lucide-react";
import { API_BASE, apiFetch } from "@/utils/api";
import { clearTokens, getRefreshToken, isLoggedIn } from "@/utils/auth";

interface ApiSession {
  session_id: number;
  session_no: number;
  status: string;
  created_at: string;
}
interface ApiProject {
  project_id: number;
  title: string;
  created_at: string;
  sessions: ApiSession[];
}

// 가장 최근 연습(세션) 시각. 연습이 없으면 프로젝트 생성 시각.
const lastActivity = (p: ApiProject) =>
  p.sessions.reduce((latest, s) => (s.created_at > latest ? s.created_at : latest), p.created_at);

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });

const STEPS = [
  { icon: Video, title: "발표 촬영", desc: "웹캠으로 바로 찍거나 영상 파일을 올려요." },
  { icon: Sparkles, title: "AI 분석", desc: "자세·시선·제스처와 말 속도·필러·무음을 분석해요." },
  { icon: MessageSquare, title: "피드백 확인", desc: "구간별 개선점과 종합 총평을 받아봐요." },
];

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const res = await apiFetch("/projects");
        if (res.status === 401) return; // apiFetch 가 이미 로그인 화면으로 보냄
        if (!res.ok) throw new Error("failed to load projects");
        setProjects(await res.json());
      } catch (err) {
        console.error(err);
        setError(true);
      }
    })();
  }, [router]);

  // 로그아웃: 서버에 refresh 토큰 폐기를 알리고(실패해도 무시), 저장된 토큰을 지운 뒤 첫 화면(랜딩)으로.
  const logout = async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).catch(() => {});
    }
    clearTokens();
    router.replace("/");
  };

  const totalSessions = projects?.reduce((sum, p) => sum + p.sessions.length, 0) ?? 0;
  const recent = [...(projects ?? [])]
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)))
    .slice(0, 4);

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
            <button
              onClick={() => router.push("/dashboard")}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50 hover:text-blue-700 transition-colors"
            >
              내 기록
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              로그아웃
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 space-y-12">
        {/* 소개 + 시작 버튼 */}
        <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-10 flex flex-col md:flex-row md:items-center gap-8">
          <div className="flex-1 space-y-4">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-700 bg-blue-50 border border-blue-100 px-3 py-1 rounded-full">
              <Sparkles className="w-3.5 h-3.5" />
              AI 발표 코치
            </span>
            <h2 className="text-3xl font-extrabold text-slate-800 leading-snug tracking-tight">
              발표 연습 영상 한 편으로<br />
              말하기와 태도를 함께 점검하세요
            </h2>
            <p className="text-slate-500 leading-relaxed">
              촬영만 하면 목소리와 몸짓을 구간별로 분석해서 무엇을 고치면 좋을지 알려드려요.
            </p>
            <button
              onClick={() => router.push("/dashboard")}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-5 py-3 rounded-xl transition-colors shadow-sm shadow-blue-200"
            >
              연습 시작하기
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 md:w-72 shrink-0">
            <div className="bg-slate-50 rounded-2xl border border-slate-100 p-5">
              <FolderOpen className="w-5 h-5 text-blue-600 mb-3" />
              <p className="text-2xl font-extrabold text-slate-800">{projects ? projects.length : "-"}</p>
              <p className="text-xs font-semibold text-slate-500 mt-1">발표 주제</p>
            </div>
            <div className="bg-slate-50 rounded-2xl border border-slate-100 p-5">
              <Mic className="w-5 h-5 text-blue-600 mb-3" />
              <p className="text-2xl font-extrabold text-slate-800">{projects ? totalSessions : "-"}</p>
              <p className="text-xs font-semibold text-slate-500 mt-1">연습 회차</p>
            </div>
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

        {/* 최근 기록 */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-slate-800">최근 기록</h3>
            <button
              onClick={() => router.push("/dashboard")}
              className="text-sm font-semibold text-slate-500 hover:text-blue-700 transition-colors"
            >
              전체 보기
            </button>
          </div>

          {error ? (
            <p className="text-sm text-slate-500 bg-white rounded-2xl border border-slate-200 p-6">
              기록을 불러오지 못했습니다. 백엔드 서버(localhost:8000)가 켜져 있는지 확인하세요.
            </p>
          ) : projects === null ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 bg-white rounded-2xl border border-slate-200 p-6">
              <Loader2 className="w-4 h-4 animate-spin" />
              불러오는 중...
            </div>
          ) : recent.length === 0 ? (
            <div className="text-center bg-white rounded-2xl border border-dashed border-slate-300 p-10">
              <Eye className="w-6 h-6 text-slate-300 mx-auto mb-3" />
              <p className="text-sm text-slate-500">아직 기록이 없어요. 첫 발표 연습을 시작해 보세요!</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {recent.map((p) => (
                <button
                  key={p.project_id}
                  onClick={() => router.push(`/dashboard?view=sessions&folder=${p.project_id}`)}
                  className="group text-left bg-white rounded-2xl border border-slate-200 p-5 hover:border-blue-200 hover:shadow-sm transition-all flex items-center gap-4"
                >
                  <div className="bg-slate-100 group-hover:bg-blue-50 p-3 rounded-xl transition-colors">
                    <FolderOpen className="w-5 h-5 text-slate-500 group-hover:text-blue-600 transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-800 truncate">{p.title}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      연습 {p.sessions.length}회 · 최근 {formatDate(lastActivity(p))}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
