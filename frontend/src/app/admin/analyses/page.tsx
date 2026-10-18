"use client";

// 관리자 · 분석 현황(/admin/analyses) — 전체 회원의 분석 실행 기록.
// 단계별 성공률·평균 소요 시간 + 세션 목록(단계별 최근 실행 결과). 행을 누르면 상세로.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, RefreshCw } from "lucide-react";
import { apiFetch, errorMessage } from "@/utils/api";
import { isLoggedIn } from "@/utils/auth";
import { AdminHeader, STEP_LABELS, STEP_ORDER, StatusBadge, StepDot, fmtDate, fmtMs, fmtSec } from "../adminShared";

interface StepStat { step: string; runs: number; succeeded: number; partial: number; failed: number; running: number; avg_ms: number | null }
interface Stats { days: number; sessions: number; completed: number; failed_sessions: number; steps: StepStat[] }
interface StepRun { status: string; duration_ms: number | null; model: string | null; error: string | null; started_at: string }
interface Item {
  session_id: number; session_no: number; project_title: string; user_email: string; status: string;
  created_at: string; duration_sec: number | null; last_run_at: string | null; has_failure: boolean;
  steps: Record<string, StepRun>;
}

const PAGE = 30;
const SESSION_STATUS: Record<string, string> = {
  recording: "촬영 중", processing: "처리 중", preprocessed: "전처리 완료", analyzed: "동작 분석 완료", segmented: "분석 완료",
};

export default function AdminAnalysesPage() {
  const router = useRouter();
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<Stats | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
      if (onlyFailed) qs.set("only_failed", "true");
      if (email) qs.set("email", email);
      const [sRes, lRes] = await Promise.all([
        apiFetch(`/admin/analyses/stats?days=${days}`),
        apiFetch(`/admin/analyses?${qs}`),
      ]);
      if (sRes.status === 403 || lRes.status === 403) {
        router.replace("/home");
        return;
      }
      if (!sRes.ok || !lRes.ok) {
        setError(await errorMessage(!sRes.ok ? sRes : lRes, "분석 현황을 불러오지 못했습니다."));
        return;
      }
      setStats(await sRes.json());
      const list = await lRes.json();
      setItems(list.items);
      setTotal(list.total);
    } finally {
      setLoading(false);
    }
  }, [days, page, onlyFailed, email, router]);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  const successRate = stats && stats.sessions ? Math.round((stats.completed / stats.sessions) * 100) : null;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <AdminHeader />

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">분석 현황</h2>
            <p className="text-sm text-slate-500 mt-1">회원들의 분석 단계별 실행 결과와 소요 시간이에요. 영상은 표시하지 않아요.</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white text-slate-700"
            >
              <option value={1}>최근 1일</option>
              <option value={7}>최근 7일</option>
              <option value={30}>최근 30일</option>
            </select>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              새로고침
            </button>
          </div>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

        {stats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "분석한 세션", value: stats.sessions, unit: "개" },
                { label: "끝까지 완료", value: stats.completed, unit: "개" },
                { label: "완료율", value: successRate ?? "-", unit: successRate == null ? "" : "%" },
                { label: "실패가 있었던 세션", value: stats.failed_sessions, unit: "개", danger: stats.failed_sessions > 0 },
              ].map((c) => (
                <div key={c.label} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                  <div className="text-sm text-slate-500 font-semibold">{c.label}</div>
                  <div className={`text-3xl font-extrabold mt-1 ${c.danger ? "text-red-600" : "text-slate-800"}`}>
                    {c.value}
                    <span className="text-base font-bold text-slate-400 ml-1">{c.unit}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="px-5 py-3 font-semibold">단계</th>
                    <th className="px-5 py-3 font-semibold text-right">실행</th>
                    <th className="px-5 py-3 font-semibold text-right">성공</th>
                    <th className="px-5 py-3 font-semibold text-right">일부 실패</th>
                    <th className="px-5 py-3 font-semibold text-right">실패</th>
                    <th className="px-5 py-3 font-semibold text-right">평균 소요</th>
                  </tr>
                </thead>
                <tbody>
                  {STEP_ORDER.map((key) => {
                    const s = stats.steps.find((x) => x.step === key);
                    return (
                      <tr key={key} className="border-b border-slate-50 last:border-0">
                        <td className="px-5 py-3 font-semibold text-slate-700">{STEP_LABELS[key]}</td>
                        <td className="px-5 py-3 text-right text-slate-700">{s?.runs ?? 0}</td>
                        <td className="px-5 py-3 text-right text-emerald-700">{s?.succeeded ?? 0}</td>
                        <td className={`px-5 py-3 text-right ${s?.partial ? "text-amber-700 font-bold" : "text-slate-400"}`}>{s?.partial ?? 0}</td>
                        <td className={`px-5 py-3 text-right ${s?.failed ? "text-red-600 font-bold" : "text-slate-400"}`}>{s?.failed ?? 0}</td>
                        <td className="px-5 py-3 text-right text-slate-700">{fmtMs(s?.avg_ms)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setPage(0);
              setEmail(emailInput.trim());
            }}
            className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2"
          >
            <Search className="w-4 h-4 text-slate-400" />
            <input
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="회원 이메일로 찾기"
              className="text-sm outline-none w-56 bg-transparent"
            />
          </form>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyFailed}
              onChange={(e) => {
                setPage(0);
                setOnlyFailed(e.target.checked);
              }}
              className="w-4 h-4 accent-red-600"
            />
            실패가 있었던 세션만
          </label>
          <span className="text-sm text-slate-400 ml-auto">총 {total}개</span>
        </div>

        {!items && !error && (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            불러오는 중…
          </div>
        )}

        {items && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  <th className="px-5 py-3 font-semibold">만든 시각</th>
                  <th className="px-5 py-3 font-semibold">회원</th>
                  <th className="px-5 py-3 font-semibold">프로젝트 · 회차</th>
                  <th className="px-5 py-3 font-semibold text-right">길이</th>
                  <th className="px-5 py-3 font-semibold">단계</th>
                  <th className="px-5 py-3 font-semibold">상태</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-slate-400">조건에 맞는 세션이 없어요.</td>
                  </tr>
                )}
                {items.map((it) => {
                  const failedStep = STEP_ORDER.find((k) => ["failed", "partial"].includes(it.steps[k]?.status ?? ""));
                  return (
                    <tr
                      key={it.session_id}
                      onClick={() => router.push(`/admin/analyses/${it.session_id}`)}
                      className="border-b border-slate-50 last:border-0 hover:bg-slate-50 cursor-pointer"
                    >
                      <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(it.created_at)}</td>
                      <td className="px-5 py-3 text-slate-700 max-w-[200px] truncate">{it.user_email}</td>
                      <td className="px-5 py-3 text-slate-700 max-w-[220px] truncate">
                        {it.project_title} <span className="text-slate-400">· {it.session_no}회차</span>
                      </td>
                      <td className="px-5 py-3 text-right text-slate-600">{fmtSec(it.duration_sec)}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          {STEP_ORDER.map((k) => (
                            <StepDot
                              key={k}
                              status={it.steps[k]?.status}
                              title={`${STEP_LABELS[k]}: ${it.steps[k] ? `${it.steps[k].status} · ${fmtMs(it.steps[k].duration_ms)}` : "기록 없음"}`}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {failedStep ? (
                          <span className="inline-flex items-center gap-1.5">
                            <StatusBadge status={it.steps[failedStep].status} />
                            <span className="text-xs text-slate-500">{STEP_LABELS[failedStep]}</span>
                          </span>
                        ) : (
                          <span className="text-slate-600">{SESSION_STATUS[it.status] ?? it.status}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {items && pages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold border border-slate-200 bg-white disabled:text-slate-300"
            >
              이전
            </button>
            <span className="text-sm text-slate-500">{page + 1} / {pages}</span>
            <button
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="px-3 py-1.5 rounded-lg text-sm font-semibold border border-slate-200 bg-white disabled:text-slate-300"
            >
              다음
            </button>
          </div>
        )}

        <p className="text-xs text-slate-400">
          단계 점: 초록 성공 · 노랑 일부 실패 · 빨강 실패 · 파랑 실행 중 · 빈 원 기록 없음. 실행 기록은 이 기능을 배포한 뒤부터 쌓여요.
        </p>
      </main>
    </div>
  );
}
