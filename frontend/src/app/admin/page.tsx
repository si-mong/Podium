"use client";

// 관리자 화면(/admin) — 외부 API(Gemini/OpenAI/Modal) 연결 점검.
// 분석이 실패했을 때 우리 코드 문제인지, 모델 제공자 쪽 문제인지를 영상 없이 바로 가린다.
// 관리자가 아니면 홈으로 돌려보낸다 (실제 차단은 백엔드 require_admin 이 한다).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle, Play, ShieldCheck } from "lucide-react";
import { apiFetch, errorMessage } from "@/utils/api";
import { isLoggedIn } from "@/utils/auth";
import { AdminHeader } from "./adminShared";

const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", openai: "OpenAI", modal: "Modal GPU" };

interface TargetInfo {
  target: string;
  label: string;
  provider: string;
  model: string;
  key_configured: boolean;
}
interface HealthOverview {
  targets: TargetInfo[];
  whisper_model: string;
}
interface PingResult {
  ok: boolean;
  latency_ms: number;
  reply: string | null;
  error: string | null;
  checked_at: string; // 화면에서 붙이는 점검 시각
}

export default function AdminPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<HealthOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, PingResult>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    (async () => {
      const res = await apiFetch("/admin/health");
      if (res.status === 401) return; // apiFetch 가 이미 로그인 화면으로 보냄
      if (res.status === 403) {
        router.replace("/home");
        return;
      }
      if (!res.ok) {
        setError(await errorMessage(res, "점검 정보를 불러오지 못했습니다."));
        return;
      }
      setOverview(await res.json());
    })();
  }, [router]);

  const ping = async (target: string) => {
    setRunning((prev) => new Set(prev).add(target));
    try {
      const res = await apiFetch(`/admin/health/${target}`, { method: "POST" });
      const checked_at = new Date().toLocaleTimeString("ko-KR");
      const result: PingResult = res.ok
        ? { ...(await res.json()), checked_at }
        : { ok: false, latency_ms: 0, reply: null, error: await errorMessage(res, "요청 실패"), checked_at };
      setResults((prev) => ({ ...prev, [target]: result }));
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(target);
        return next;
      });
    }
  };

  const pingAll = () => overview?.targets.forEach((t) => ping(t.target));

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <AdminHeader />

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">모듈 연결 점검</h2>
            <p className="text-sm text-slate-500 mt-1">
              각 단계가 쓰는 모델에 짧은 요청을 보내 응답 여부와 응답 시간을 확인해요. Modal 은 배포 여부만 확인하고 GPU 는 켜지 않아요.
            </p>
          </div>
          <button
            onClick={pingAll}
            disabled={!overview || running.size > 0}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-colors"
          >
            <Play className="w-4 h-4" />
            전체 점검
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
        )}

        {!overview && !error && (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            불러오는 중…
          </div>
        )}

        {overview && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm divide-y divide-slate-100">
            {overview.targets.map((t) => {
              const r = results[t.target];
              const busy = running.has(t.target);
              return (
                <div key={t.target} className="p-5 flex flex-col md:flex-row md:items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-800">{t.label}</div>
                    <div className="text-sm text-slate-500 mt-0.5">
                      {PROVIDER_LABEL[t.provider] ?? t.provider} · <code className="text-slate-600">{t.model}</code>
                      {!t.key_configured && (
                        <span className="ml-2 text-red-600 font-semibold">{t.provider === "modal" ? "Modal 토큰 없음" : "API 키 없음"}</span>
                      )}
                      {t.provider === "modal" && !t.model.startsWith("modal:") && (
                        <span className="ml-2 text-amber-700 font-semibold">지금은 서버에서 직접 실행 중 (WHISPER_MODEL 이 modal: 아님)</span>
                      )}
                    </div>
                    {r && (
                      <div className={`text-sm mt-2 ${r.ok ? "text-emerald-700" : "text-red-700"} break-all`}>
                        {r.ok ? (
                          <span className="inline-flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4" />
                            정상 · {(r.latency_ms / 1000).toFixed(1)}초
                          </span>
                        ) : (
                          <span className="inline-flex items-start gap-1.5">
                            <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>실패{r.latency_ms ? ` · ${(r.latency_ms / 1000).toFixed(1)}초` : ""} — {r.error}</span>
                          </span>
                        )}
                        <span className="text-slate-400 ml-2">({r.checked_at})</span>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => ping(t.target)}
                    disabled={busy || !t.key_configured}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 w-24 px-3 py-2 rounded-xl text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-white transition-colors"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                    {busy ? "확인 중" : "점검"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
