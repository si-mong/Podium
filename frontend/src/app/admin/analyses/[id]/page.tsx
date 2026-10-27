"use client";

// 관리자 · 분석 상세(/admin/analyses/[id]) — 세션 하나의 실행 기록 + 분석 결과.
// 결과는 사용자 대시보드와 같은 데이터를 백엔드가 그대로 내려준다. 영상은 보여주지 않는다.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, Loader2 } from "lucide-react";
import { apiFetch, errorMessage } from "@/utils/api";
import { isLoggedIn } from "@/utils/auth";
import { AdminHeader, STEP_LABELS, StatusBadge, fmtDate, fmtMs, fmtSec } from "../../adminShared";

const BAR_COLOR: Record<string, string> = {
  succeeded: "bg-teal-500", partial: "bg-amber-400", failed: "bg-red-500", running: "bg-blue-400",
};

// 최근 분석 1회의 단계별 타임라인. 막대 위치 = 분석 시작 후 언제 시작했는지, 길이 = 걸린 시간.
// 동작·음성처럼 동시에 도는 단계는 막대가 겹쳐 보인다.
function RunTimeline({ run }: { run: Run }) {
  const span = Math.max(
    run.total_ms ?? 0,
    ...run.steps.map((s) => s.offset_ms + (s.duration_ms ?? 0)),
    1,
  );
  return (
    <div className="space-y-2">
      {run.steps.map((s) => {
        const left = (s.offset_ms / span) * 100;
        const width = Math.max(((s.duration_ms ?? 0) / span) * 100, 0.8);
        return (
          <div key={s.step} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 font-semibold text-slate-700">{STEP_LABELS[s.step] ?? s.step}</span>
            <div className="relative flex-1 h-5 bg-slate-100 rounded-md overflow-hidden">
              <div
                className={`absolute top-0 h-full rounded-md ${BAR_COLOR[s.status] ?? "bg-slate-400"}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${STEP_LABELS[s.step] ?? s.step}: ${fmtMs(s.duration_ms)}`}
              />
            </div>
            <span className="w-20 shrink-0 text-right text-slate-600 whitespace-nowrap">{fmtMs(s.duration_ms)}</span>
          </div>
        );
      })}
    </div>
  );
}

interface Event {
  event_id: number; step: string; status: string; model: string | null; duration_ms: number | null;
  error: string | null; started_at: string; finished_at: string | null;
}
interface SegmentFb {
  segment_id: number; label: string; title: string; t_start: number; t_end: number;
  feedback: { strengths: string[]; improvements: string[] } | null;
}
interface Run {
  started_at: string; total_ms: number | null; completed: boolean;
  steps: { step: string; status: string; offset_ms: number; duration_ms: number | null }[];
}
interface Detail {
  session_id: number; session_no: number; project_title: string; project_trashed: boolean;
  user_email: string; user_name: string | null; user_affiliation: string | null; status: string; created_at: string; run: Run | null; events: Event[];
  results: {
    voice_summary?: { filler_count: number | null; repetition_count: number | null; silence_ratio: number | null; avg_speaking_rate_spm: number | null } | null;
    overall?: { overall_summary: string | null } | null;
    segments?: { segments: SegmentFb[] } | null;
    motion?: { analyses: { t_start: number; t_end: number; gesture_counts: Record<string, number> | null }[] } | null;
    script?: { sentences: { t_start: number; t_end: number; text: string }[] } | null;
  };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
      <h3 className="font-extrabold text-slate-800 mb-4">{title}</h3>
      {children}
    </section>
  );
}

export default function AdminAnalysisDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    (async () => {
      const res = await apiFetch(`/admin/analyses/${id}`);
      if (res.status === 403) {
        router.replace("/home");
        return;
      }
      if (!res.ok) {
        setError(await errorMessage(res, "세션 정보를 불러오지 못했습니다."));
        return;
      }
      setData(await res.json());
    })();
  }, [id, router]);

  const r = data?.results;
  const vs = r?.voice_summary;
  const motionTotal = (r?.motion?.analyses ?? []).reduce(
    (sum, a) => sum + Object.values(a.gesture_counts ?? {}).reduce((x, y) => x + (y || 0), 0),
    0,
  );

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <AdminHeader />

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-6">
        <button
          onClick={() => router.push("/admin/analyses")}
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-blue-700"
        >
          <ChevronLeft className="w-4 h-4" />
          분석 현황으로
        </button>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}
        {!data && !error && (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            불러오는 중…
          </div>
        )}

        {data && (
          <>
            <div>
              <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">
                {data.project_title} <span className="text-slate-400">· {data.session_no}회차</span>
              </h2>
              <p className="text-sm text-slate-500 mt-1">
                {data.user_name && <b className="text-slate-700">{data.user_name}</b>}
                {data.user_name && " · "}
                {data.user_email}
                {data.user_affiliation && ` · ${data.user_affiliation}`} · 세션 #{data.session_id} · {fmtDate(data.created_at)} · 상태 <code>{data.status}</code>
                {data.project_trashed && <span className="ml-2 text-amber-700 font-semibold">휴지통에 있는 프로젝트 (결과 생략)</span>}
              </p>
            </div>

            {data.run && (
              <Card title="최근 분석 소요 시간">
                <div className="flex items-end gap-3 mb-5">
                  <span className="text-3xl font-extrabold text-slate-800">
                    {data.run.total_ms == null ? "진행 중" : fmtMs(data.run.total_ms)}
                  </span>
                  <span className="text-sm text-slate-500 mb-1">
                    {new Date(data.run.started_at).toLocaleString("ko-KR")} 시작
                    {!data.run.completed && data.run.total_ms != null && " · 종합 피드백까지 끝나지 않음"}
                  </span>
                </div>
                <RunTimeline run={data.run} />
                <p className="text-xs text-slate-400 mt-4">
                  첫 단계 시작부터 마지막 단계 종료까지의 시간이에요. 동시에 도는 단계는 막대가 겹쳐 보여요.
                </p>
              </Card>
            )}

            <Card title="실행 기록">
              {data.events.length === 0 ? (
                <p className="text-sm text-slate-400">실행 기록이 없어요. 기록 기능을 배포하기 전에 분석한 세션일 수 있어요.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-100">
                        <th className="py-2 pr-4 font-semibold">시작</th>
                        <th className="py-2 pr-4 font-semibold">단계</th>
                        <th className="py-2 pr-4 font-semibold">결과</th>
                        <th className="py-2 pr-4 font-semibold text-right">소요</th>
                        <th className="py-2 pr-4 font-semibold">모델</th>
                        <th className="py-2 font-semibold">에러</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.events.map((ev) => (
                        <tr key={ev.event_id} className="border-b border-slate-50 last:border-0 align-top">
                          <td className="py-2 pr-4 text-slate-600 whitespace-nowrap">
                            {new Date(ev.started_at).toLocaleTimeString("ko-KR")}
                          </td>
                          <td className="py-2 pr-4 font-semibold text-slate-700 whitespace-nowrap">{STEP_LABELS[ev.step] ?? ev.step}</td>
                          <td className="py-2 pr-4"><StatusBadge status={ev.status} /></td>
                          <td className="py-2 pr-4 text-right text-slate-700 whitespace-nowrap">{fmtMs(ev.duration_ms)}</td>
                          <td className="py-2 pr-4 text-slate-500"><code className="text-xs">{ev.model ?? "-"}</code></td>
                          <td className="py-2 text-red-700 text-xs break-all">{ev.error ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {!data.project_trashed && (
              <>
                <Card title="종합 피드백">
                  <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                    {r?.overall?.overall_summary ?? <span className="text-slate-400">아직 없어요.</span>}
                  </p>
                </Card>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {[
                    { label: "필러", value: vs?.filler_count, unit: "회" },
                    { label: "반복", value: vs?.repetition_count, unit: "회" },
                    { label: "무음 비율", value: vs?.silence_ratio == null ? null : Math.round(vs.silence_ratio * 100), unit: "%" },
                    { label: "말 속도", value: vs?.avg_speaking_rate_spm == null ? null : Math.round(vs.avg_speaking_rate_spm), unit: "음절/분" },
                    { label: "제스처", value: r?.motion?.analyses?.length ? motionTotal : null, unit: "회" },
                  ].map((c) => (
                    <div key={c.label} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
                      <div className="text-sm text-slate-500 font-semibold">{c.label}</div>
                      <div className="text-2xl font-extrabold text-slate-800 mt-1">
                        {c.value ?? "-"}
                        {c.value != null && <span className="text-sm font-bold text-slate-400 ml-1">{c.unit}</span>}
                      </div>
                    </div>
                  ))}
                </div>

                <Card title={`구간별 피드백 (${r?.segments?.segments.length ?? 0}개)`}>
                  <div className="space-y-4">
                    {(r?.segments?.segments ?? []).map((s) => (
                      <div key={s.segment_id} className="border border-slate-100 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-blue-50 text-blue-700">{s.label}</span>
                          <span className="font-bold text-slate-800">{s.title}</span>
                          <span className="text-xs text-slate-400">{fmtSec(s.t_start)} – {fmtSec(s.t_end)}</span>
                        </div>
                        {s.feedback ? (
                          <div className="grid md:grid-cols-2 gap-3 text-sm">
                            <ul className="space-y-1">
                              {s.feedback.strengths.map((t, i) => <li key={i} className="text-emerald-800">+ {t}</li>)}
                            </ul>
                            <ul className="space-y-1">
                              {s.feedback.improvements.map((t, i) => <li key={i} className="text-amber-800">- {t}</li>)}
                            </ul>
                          </div>
                        ) : (
                          <p className="text-sm text-slate-400">피드백 없음</p>
                        )}
                      </div>
                    ))}
                    {!r?.segments?.segments.length && <p className="text-sm text-slate-400">구간이 아직 없어요.</p>}
                  </div>
                </Card>

                <Card title={`대본 (${r?.script?.sentences.length ?? 0}문장)`}>
                  <details>
                    <summary className="text-sm font-semibold text-blue-700 cursor-pointer select-none">펼쳐 보기</summary>
                    <div className="mt-3 space-y-1.5 text-sm max-h-[480px] overflow-y-auto">
                      {(r?.script?.sentences ?? []).map((s, i) => (
                        <p key={i} className="text-slate-700">
                          <span className="text-slate-400 text-xs mr-2">{fmtSec(s.t_start)}</span>
                          {s.text}
                        </p>
                      ))}
                    </div>
                  </details>
                </Card>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
