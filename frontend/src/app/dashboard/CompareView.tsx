"use client";

// 비교 분석 화면 — 같은 폴더의 두 회차를 비교한다 (설계: docs/Dev-비교분석.md).
//   ① 총 지표 비교   : GET /projects/{id}/compare 의 metrics (분당 횟수로 맞춰 비교, 판정은 백엔드가 함)
//   ② 구간별 비교    : 같은 라벨(도입·해결방안 …) 구간끼리. 두 회차 영상·스크립트·지표를 나란히
//   ③ AI 비교 피드백 : POST /projects/{id}/compare/feedback — 지난 회차 개선점이 고쳐졌는지 GPT 가 판정 (저장됨)

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, BarChart2, Columns, FileText, Lightbulb, Loader2, RefreshCw, Sparkles, ThumbsUp } from 'lucide-react';
import { API_BASE, apiFetch } from '@/utils/api';
import { fmtTime } from './InteractiveScript';

// 백엔드 응답 형태 (app/schemas/compare.py)
type Verdict = 'improved' | 'same' | 'worse' | null;
interface MetricDiff {
  key: string; label: string; unit: string; direction: 'lower' | 'higher' | 'band' | 'neutral';
  base: number | null; target: number | null; verdict: Verdict;
  base_count?: number | null; target_count?: number | null;
}
interface SegmentBrief { segment_id: number; title: string; t_start: number; t_end: number; stt_text: string | null; rating: string | null }
interface LabelCompare {
  label: string; status: 'both' | 'only_base' | 'only_target';
  metrics: MetricDiff[]; base_segments: SegmentBrief[]; target_segments: SegmentBrief[];
}
interface CompareSession { session_id: number; session_no: number; created_at: string; comparable: boolean; has_video: boolean }
interface FeedbackItem { status: 'resolved' | 'improved' | 'persists' | 'new'; title: string; previous: string | null; detail: string }
interface CompareFeedback {
  comparison_id: number; status: string; headline: string | null; items: FeedbackItem[];
  error: string | null; created_at: string; stale: boolean;
}
interface ProjectCompare {
  sessions: CompareSession[]; base: CompareSession | null; target: CompareSession | null;
  metrics: MetricDiff[]; labels: LabelCompare[]; warnings: string[]; feedback: CompareFeedback | null;
}

const VERDICT_STYLE: Record<string, { text: string; cls: string }> = {
  improved: { text: '좋아짐', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  same: { text: '비슷함', cls: 'bg-stone-100 text-stone-500 border-stone-200' },
  worse: { text: '나빠짐', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};
const ITEM_STYLE: Record<FeedbackItem['status'], { text: string; cls: string }> = {
  resolved: { text: '해결됨', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  improved: { text: '좋아짐', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  persists: { text: '여전함', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  new: { text: '새로 생김', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

function fmtValue(v: number | null | undefined, unit: string): string {
  if (v == null) return '-';
  if (unit === '%') return `${(v * 100).toFixed(1)}%`;
  if (unit === '초') return fmtTime(v);
  if (unit === '음절/분') return `${Math.round(v)}`;
  if (unit === '회/분') return v.toFixed(1);
  return `${v}`;
}
// 값 옆에 붙일 작은 단위 (초는 m:ss 로 이미 표현돼서 생략)
const unitSuffix = (unit: string) => (unit === '%' || unit === '초' ? '' : unit);

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  if (!verdict) return null;
  const s = VERDICT_STYLE[verdict];
  return <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md border whitespace-nowrap ${s.cls}`}>{s.text}</span>;
}

// 비교 화면용 영상. 티켓(30분)을 받아 붙이고, 만료돼 실패하면 다시 받아 같은 위치에서 잇는다.
// seek 이 바뀔 때마다(구간을 누를 때마다) 그 위치로 옮긴다.
function CompareVideo({ sessionId, hasVideo, seek }: { sessionId: number; hasVideo: boolean; seek: { t: number; n: number } }) {
  const [ticket, setTicket] = useState<string | null>(null);
  const issuedAt = useRef(0);
  const resumeAt = useRef<number | null>(null);
  const ref = useRef<HTMLVideoElement>(null);

  const fetchTicket = async () => {
    try {
      const res = await apiFetch(`/sessions/${sessionId}/video/ticket`, { method: 'POST' });
      if (!res.ok) return null;
      issuedAt.current = Date.now();
      return ((await res.json()) as { ticket: string }).ticket;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    setTicket(null);
    if (hasVideo) fetchTicket().then((t) => !cancelled && setTicket(t));
    return () => { cancelled = true; };
  }, [sessionId, hasVideo]);

  const moveTo = (sec: number) => {
    const v = ref.current;
    if (!v) return;
    const go = () => { v.currentTime = Math.max(0, sec); };
    if (v.readyState >= 1 && Number.isFinite(v.duration)) go();
    else resumeAt.current = sec;
  };
  useEffect(() => { moveTo(seek.t); }, [seek.n]);

  if (!hasVideo) {
    return <div className="aspect-video bg-stone-100 rounded-lg flex items-center justify-center text-sm text-stone-400">영상이 없어요</div>;
  }
  if (!ticket) {
    return <div className="aspect-video bg-stone-100 rounded-lg flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-stone-400" /></div>;
  }
  return (
    <video
      ref={ref}
      src={`${API_BASE}/sessions/${sessionId}/video?ticket=${encodeURIComponent(ticket)}`}
      controls
      playsInline
      className="w-full aspect-video bg-black rounded-lg"
      onLoadedMetadata={(e) => {
        // 브라우저로 찍은 webm 은 길이 정보가 없어(Infinity) 이동이 안 될 수 있다 → 끝으로 한 번 보내 길이를 계산시킨 뒤 되돌린다
        const v = e.currentTarget;
        const start = resumeAt.current ?? seek.t;
        resumeAt.current = null;
        if (Number.isFinite(v.duration)) { v.currentTime = start; return; }
        const back = () => { v.removeEventListener('timeupdate', back); v.currentTime = start; };
        v.addEventListener('timeupdate', back);
        v.currentTime = 1e7;
      }}
      onError={async (e) => {
        if (Date.now() - issuedAt.current < 10_000) return; // 방금 받은 티켓도 실패면 만료 문제가 아님 → 반복하지 않음
        resumeAt.current = e.currentTarget.currentTime;
        const t = await fetchTicket();
        if (t) setTicket(t);
      }}
    />
  );
}

// 한 회차 칸: 영상 + 구간 버튼 + 스크립트
function SessionColumn({ title, tone, session, segments }: {
  title: string; tone: 'base' | 'target'; session: CompareSession; segments: SegmentBrief[];
}) {
  const [seek, setSeek] = useState({ t: segments[0]?.t_start ?? 0, n: 0 });
  useEffect(() => { setSeek((s) => ({ t: segments[0]?.t_start ?? 0, n: s.n + 1 })); }, [segments]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${tone === 'target' ? 'bg-stone-800 text-white' : 'bg-stone-200 text-stone-600'}`}>{title}</span>
        <span className="font-bold text-stone-800">{session.session_no}회차</span>
      </div>
      <CompareVideo sessionId={session.session_id} hasVideo={session.has_video} seek={seek} />
      {segments.length === 0 ? (
        <div className="text-sm text-stone-400 bg-stone-50 rounded-lg px-4 py-6 text-center">이 회차에는 이 구간이 없어요</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {segments.map((s) => (
              <button key={s.segment_id} onClick={() => setSeek((p) => ({ t: s.t_start, n: p.n + 1 }))}
                className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-stone-200 bg-white text-stone-600 hover:bg-stone-100">
                {fmtTime(s.t_start)}~{fmtTime(s.t_end)} · {s.title}
              </button>
            ))}
          </div>
          <div className="bg-stone-50 rounded-lg p-4 max-h-56 overflow-y-auto">
            <h4 className="text-xs font-bold text-stone-500 mb-2 flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" />스크립트</h4>
            {segments.map((s) => (
              <p key={s.segment_id} className="text-sm text-stone-700 leading-relaxed mb-2 last:mb-0">{s.stt_text || '(전사문 없음)'}</p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function CompareView({ projectId, targetSessionId, onTargetChange }: {
  projectId: string; targetSessionId: string; onTargetChange: (sessionId: string) => void;
}) {
  const [baseId, setBaseId] = useState<number | null>(null);
  const [data, setData] = useState<ProjectCompare | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [labelIdx, setLabelIdx] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // 이번 회차를 바꾸면 이전 회차는 다시 기본값(바로 앞 회차)으로
  useEffect(() => { setBaseId(null); }, [targetSessionId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadError(null);
    setGenError(null);
    const q = new URLSearchParams();
    if (targetSessionId) q.set('target', targetSessionId);
    if (baseId != null) q.set('base', String(baseId));
    (async () => {
      let res = await apiFetch(`/projects/${projectId}/compare?${q}`);
      // 지금 보던 회차가 아직 비교할 수 없는 회차면(분석 전) 기본 회차로 다시 받는다
      if (res.status === 400 && targetSessionId && baseId == null) res = await apiFetch(`/projects/${projectId}/compare`);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError('비교 결과를 불러오지 못했어요.');
        return;
      }
      setData(await res.json());
      setLabelIdx(0);
    })();
    return () => { cancelled = true; };
  }, [projectId, targetSessionId, baseId]);

  const generate = async () => {
    if (!data?.base || !data.target) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await apiFetch(`/projects/${projectId}/compare/feedback?base=${data.base.session_id}&target=${data.target.session_id}`, { method: 'POST' });
      if (!res.ok) throw new Error();
      const feedback: CompareFeedback = await res.json();
      setData((d) => (d ? { ...d, feedback } : d));
    } catch {
      setGenError('AI 비교 피드백을 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setGenerating(false);
    }
  };

  if (loadError) {
    return <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-xl px-4 py-3">{loadError}</div>;
  }
  if (!data) {
    return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>;
  }

  const comparable = data.sessions.filter((s) => s.comparable);
  if (!data.base || !data.target) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-10 text-center">
        <Columns className="w-8 h-8 text-stone-300 mx-auto mb-3" />
        <p className="font-bold text-stone-700">분석이 끝난 회차가 2개 이상 있어야 비교할 수 있어요</p>
        <p className="text-sm text-stone-500 mt-1">지금 이 폴더에서 비교할 수 있는 회차: {comparable.length}개</p>
      </div>
    );
  }

  const { base, target } = data;
  const label = data.labels[Math.min(labelIdx, data.labels.length - 1)];
  const fb = data.feedback && data.feedback.status === 'done' ? data.feedback : null;
  const better = fb ? fb.items.filter((i) => i.status === 'resolved' || i.status === 'improved') : [];
  const remain = fb ? fb.items.filter((i) => i.status === 'persists' || i.status === 'new') : [];

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
      {/* 회차 선택 */}
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-4 sm:p-5 flex flex-wrap items-center gap-3">
        <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2 mr-auto">
          <span className="bg-stone-100 text-stone-700 p-1.5 rounded-xl"><Columns className="w-5 h-5" /></span>
          회차 비교
        </h3>
        <div className="flex items-center gap-2">
          <select value={base.session_id} onChange={(e) => setBaseId(Number(e.target.value))}
            className="border border-stone-200 rounded-lg px-3 py-2 text-sm font-semibold text-stone-700 bg-white">
            {comparable.filter((s) => s.session_id !== target.session_id).map((s) => (
              <option key={s.session_id} value={s.session_id}>이전: {s.session_no}회차</option>
            ))}
          </select>
          <ArrowRight className="w-4 h-4 text-stone-400 shrink-0" />
          <select value={target.session_id} onChange={(e) => onTargetChange(e.target.value)}
            className="border border-stone-200 rounded-lg px-3 py-2 text-sm font-semibold text-stone-800 bg-white">
            {comparable.filter((s) => s.session_id !== base.session_id).map((s) => (
              <option key={s.session_id} value={s.session_id}>이번: {s.session_no}회차</option>
            ))}
          </select>
        </div>
      </div>

      {data.warnings.map((w) => (
        <div key={w} className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />{w}
        </div>
      ))}

      {/* ① 총 지표 비교 — 한 박스 안에 구분선 */}
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-5 sm:p-6">
        <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2 mb-1">
          <span className="bg-stone-100 text-stone-700 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5" /></span>
          총 지표 비교
        </h3>
        <p className="text-xs text-stone-500 mb-4">발표 길이가 회차마다 달라서 횟수는 분당 횟수로 비교해요. 작은 차이는 &lsquo;비슷함&rsquo;으로 봐요.</p>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-px bg-stone-100 border border-stone-100 rounded-xl overflow-hidden">
          {data.metrics.map((m) => (
            <div key={m.key} className="bg-white p-4 flex flex-col gap-2 min-w-0">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <span className="text-sm font-bold text-stone-600 break-keep">{m.label}</span>
                <VerdictBadge verdict={m.verdict} />
              </div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-base font-bold text-stone-400">{fmtValue(m.base, m.unit)}</span>
                <ArrowRight className="w-3.5 h-3.5 text-stone-300 self-center" />
                <span className="text-xl font-extrabold text-stone-800">{fmtValue(m.target, m.unit)}</span>
                <span className="text-xs text-stone-400">{unitSuffix(m.unit)}</span>
              </div>
              {m.base_count != null && m.target_count != null && (
                <span className="text-xs text-stone-400">{m.base_count}회 → {m.target_count}회</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ② 구간별 비교 */}
      {label && (
        <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-5 sm:p-6">
          <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2 mb-1">
            <span className="bg-stone-100 text-stone-700 p-1.5 rounded-xl"><Columns className="w-5 h-5" /></span>
            구간별 비교
          </h3>
          <p className="text-xs text-stone-500 mb-4">같은 성격의 구간(라벨)끼리 묶어서 비교해요.</p>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 mb-5">
            {data.labels.map((l, idx) => (
              <button key={l.label} onClick={() => setLabelIdx(idx)}
                className={`py-2.5 px-3 rounded-xl text-sm font-bold border transition-all flex flex-wrap items-center justify-center gap-1.5 break-keep
                  ${idx === labelIdx ? 'bg-stone-800 text-white border-stone-800' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'}`}>
                {l.label}
                {l.status !== 'both' && (
                  <span className={`text-[10px] font-bold px-1 rounded ${idx === labelIdx ? 'bg-white/20' : 'bg-stone-200 text-stone-500'}`}>
                    {l.status === 'only_base' ? '이번엔 없음' : '새로 생김'}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <SessionColumn title="이전" tone="base" session={base} segments={label.base_segments} />
            <SessionColumn title="이번" tone="target" session={target} segments={label.target_segments} />
          </div>

          <div className="mt-5 grid grid-cols-2 xl:grid-cols-3 gap-px bg-stone-100 border border-stone-100 rounded-xl overflow-hidden">
            {label.metrics.map((m) => (
              <div key={m.key} className="bg-white p-3 flex flex-col gap-1 min-w-0">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <span className="text-xs font-bold text-stone-500 break-keep">{m.label}</span>
                  <VerdictBadge verdict={m.verdict} />
                </div>
                <div className="flex items-baseline gap-1 flex-wrap">
                  <span className="text-sm font-bold text-stone-400">{fmtValue(m.base, m.unit)}</span>
                  <ArrowRight className="w-3 h-3 text-stone-300 self-center" />
                  <span className="text-base font-extrabold text-stone-800">{fmtValue(m.target, m.unit)}</span>
                  <span className="text-[11px] text-stone-400">{unitSuffix(m.unit)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ③ AI 비교 피드백 */}
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
          <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2 sm:mr-auto">
            <span className="bg-stone-100 text-stone-700 p-1.5 rounded-xl"><Lightbulb className="w-5 h-5" /></span>
            AI 비교 피드백
          </h3>
          {fb && (
            <button onClick={generate} disabled={generating}
              className="text-sm font-semibold text-stone-600 border border-stone-200 rounded-lg px-3 py-1.5 hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />다시 만들기
            </button>
          )}
        </div>

        {fb?.stale && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-2.5 mb-4">
            피드백을 만든 뒤 회차가 다시 분석됐어요. &lsquo;다시 만들기&rsquo;로 최신 결과를 반영하세요.
          </div>
        )}
        {genError && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-xl px-4 py-2.5 mb-4">{genError}</div>}

        {!fb ? (
          <div className="text-center py-8">
            <p className="text-sm text-stone-500 mb-4">
              {base.session_no}회차에서 받은 개선점을 {target.session_no}회차에서 고쳤는지 AI 가 확인해 드려요.
            </p>
            <button onClick={generate} disabled={generating}
              className="bg-stone-900 text-white font-bold text-sm rounded-xl px-5 py-3 inline-flex items-center gap-2 hover:bg-stone-800 disabled:opacity-60">
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {generating ? '비교하는 중… (10초 정도)' : 'AI 비교 피드백 만들기'}
            </button>
          </div>
        ) : (
          <>
            {fb.headline && <p className="text-base font-bold text-stone-800 mb-4">{fb.headline}</p>}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-px bg-stone-100 border border-stone-100 rounded-xl overflow-hidden">
              {[{ title: '나아진 점', icon: ThumbsUp, items: better }, { title: '남은 과제', icon: AlertCircle, items: remain }].map((col) => (
                <div key={col.title} className="bg-white p-5">
                  <h4 className="font-bold text-stone-700 flex items-center gap-2 mb-3"><col.icon className="w-4 h-4" />{col.title}</h4>
                  {col.items.length === 0 ? (
                    <p className="text-sm text-stone-400">없어요</p>
                  ) : (
                    <ul className="space-y-4">
                      {col.items.map((it, i) => (
                        <li key={i}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md border ${ITEM_STYLE[it.status].cls}`}>{ITEM_STYLE[it.status].text}</span>
                            <span className="text-sm font-bold text-stone-800">{it.title}</span>
                          </div>
                          {it.previous && <p className="text-xs text-stone-400 mb-1">지난 지적: {it.previous}</p>}
                          <p className="text-sm text-stone-700 leading-relaxed">{it.detail}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
