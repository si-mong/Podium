"use client";

// 관리자 화면 공용 — 상단 바(메뉴), 단계 이름, 상태 배지, 시간 표시.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart2, ChevronLeft } from "lucide-react";

export const STEP_LABELS: Record<string, string> = {
  preprocess: "전처리",
  motion: "동작 분석",
  voice: "음성 분석",
  segments: "구간 분리",
  segment_feedback: "구간 피드백",
  overall_feedback: "종합 피드백",
};
export const STEP_ORDER = Object.keys(STEP_LABELS);

const STATUS_STYLE: Record<string, { label: string; cls: string; dot: string }> = {
  succeeded: { label: "성공", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  partial: { label: "일부 실패", cls: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500" },
  failed: { label: "실패", cls: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" },
  running: { label: "실행 중", cls: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-500" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { label: status, cls: "bg-slate-50 text-slate-600 border-slate-200" };
  return <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded-md border ${s.cls}`}>{s.label}</span>;
}

// 단계 하나를 작은 점으로 (목록 화면용). 실행 기록이 없으면 회색 테두리.
export function StepDot({ status, title }: { status?: string; title: string }) {
  const dot = status ? STATUS_STYLE[status]?.dot ?? "bg-slate-400" : "border border-slate-300 bg-white";
  return <span title={title} className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />;
}

export const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "-" : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`;

export const fmtSec = (sec: number | null | undefined) =>
  sec == null ? "-" : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";

const NAV = [
  { href: "/admin/analyses", label: "분석 현황" },
  { href: "/admin", label: "모듈 점검" },
];

export function AdminHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  return (
    <header className="h-20 bg-white/80 backdrop-blur-md border-b border-slate-200 sticky top-0 z-10">
      <div className="max-w-6xl mx-auto h-full px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-2 rounded-xl shadow-sm shadow-blue-200">
              <BarChart2 className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">관리자</h1>
          </div>
          <nav className="flex items-center gap-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  active(n.href) ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <button
          onClick={() => router.push("/home")}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-50 hover:text-blue-700 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          홈으로
        </button>
      </div>
    </header>
  );
}
