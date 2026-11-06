"use client";

// 비교 분석 화면 — 같은 폴더의 두 회차를 비교한다 (설계: docs/Dev-비교분석.md).
// 먼저 프로젝트와 회차 2개를 고르고(SessionPicker) "비교하기"를 누르면 아래 결과를 보여 준다.
//   ① 총 지표 비교   : GET /projects/{id}/compare 의 metrics (레이더 차트. 분당 횟수로 맞춰 비교, 판정은 백엔드가 함)
//   ② AI 비교 피드백 : POST /projects/{id}/compare/feedback — 지난 회차 개선점이 고쳐졌는지 GPT 가 판정 (저장됨)
//   ③ 구간별 비교    : 같은 라벨(도입·해결방안 …) 구간끼리. 지표 막대와 두 회차 영상·스크립트를 나란히
// 회차 고르기 화면 아래에는 이 폴더에서 만든 AI 비교 기록(GET /projects/{id}/comparisons)을 보여 주고, 누르면 그 비교를 다시 연다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Columns, History, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { API_BASE, apiFetch } from '@/utils/api';
import InteractiveScript, { fmtTime, normalizeSentence, ScriptData, VideoChunk } from './InteractiveScript';

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
// 지난 AI 비교 기록 한 줄. 회차를 지우면 그 회차 id 가 비어(null) 다시 열 수 없다.
interface ComparisonListItem {
  comparison_id: number; base_session_id: number | null; target_session_id: number | null;
  base_session_no: number; target_session_no: number; status: string; headline: string | null; created_at: string;
}
interface ProjectCompare {
  sessions: CompareSession[]; base: CompareSession | null; target: CompareSession | null;
  metrics: MetricDiff[]; labels: LabelCompare[]; warnings: string[]; feedback: CompareFeedback | null;
}

const ITEM_TEXT: Record<FeedbackItem['status'], { text: string; cls: string }> = {
  resolved: { text: '해결됨', cls: 'text-emerald-700' },
  improved: { text: '좋아짐', cls: 'text-teal-700' },
  persists: { text: '여전함', cls: 'text-amber-700' },
  new: { text: '새로 생김', cls: 'text-rose-700' },
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

// 비교 화면용 영상. 티켓(30분)을 받아 붙이고, 만료돼 실패하면 다시 받아 같은 위치에서 잇는다.
// seek 이 바뀔 때마다(구간·스크립트를 누를 때마다) 그 위치로 옮긴다. seek.play 면 옮긴 뒤 재생까지 한다.
// 재생 위치·재생 여부는 onTime·onPlaying 으로 알려 준다 (스크립트에서 지금 문장을 강조하는 데 씀).
function CompareVideo({ sessionId, hasVideo, seek, onTime, onPlaying }: {
  sessionId: number; hasVideo: boolean; seek: { t: number; n: number; play?: boolean };
  onTime: (sec: number) => void; onPlaying: (playing: boolean) => void;
}) {
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
    const go = () => {
      v.currentTime = Math.max(0, sec);
      if (seek.play) v.play().catch(() => {}); // 자동 재생이 막혀도 이동은 된 상태로 둔다
    };
    if (v.readyState >= 1 && Number.isFinite(v.duration)) go();
    else resumeAt.current = sec;
  };
  useEffect(() => { moveTo(seek.t); }, [seek.n]);

  if (!hasVideo) {
    return <div className="aspect-video bg-stone-100 rounded-xl flex items-center justify-center text-[15px] text-stone-400">영상이 없어요</div>;
  }
  if (!ticket) {
    return <div className="aspect-video bg-stone-100 rounded-xl flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-stone-400" /></div>;
  }
  return (
    <video
      ref={ref}
      src={`${API_BASE}/sessions/${sessionId}/video?ticket=${encodeURIComponent(ticket)}`}
      controls
      playsInline
      className="w-full aspect-video bg-black rounded-xl"
      onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
      onPlay={() => onPlaying(true)}
      onPause={() => onPlaying(false)}
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

// 한 회차의 스크립트(문장·무음·필러·반복)와 동작 분석 조각을 받아 둔다. 회차가 바뀔 때만 다시 받는다.
function useSessionScript(sessionId: number) {
  const [script, setScript] = useState<ScriptData | null>(null);
  const [chunks, setChunks] = useState<VideoChunk[]>([]);
  useEffect(() => {
    let cancelled = false;
    setScript(null);
    setChunks([]);
    (async () => {
      const [sRes, aRes] = await Promise.all([
        apiFetch(`/sessions/${sessionId}/script`).catch(() => null),
        apiFetch(`/sessions/${sessionId}/analysis`).catch(() => null),
      ]);
      if (cancelled) return;
      if (sRes?.ok) setScript(await sRes.json());
      if (aRes?.ok) setChunks(((await aRes.json()) as { analyses: VideoChunk[] }).analyses);
    })();
    return () => { cancelled = true; };
  }, [sessionId]);
  return { script, chunks };
}

// 세션 전체 스크립트에서 지금 고른 구간(들) 시간 안에 있는 것만 남긴다.
function scriptInSegments(script: ScriptData, chunks: VideoChunk[], segments: SegmentBrief[]) {
  const inside = (t: number) => segments.some((s) => t >= s.t_start - 0.01 && t < s.t_end);
  return {
    script: {
      sentences: script.sentences.filter((x) => inside(x.t_start)),
      silences: script.silences.filter((x) => inside(x.t_start)),
      fillers: script.fillers.filter((x) => inside(x.t_start)),
      repetitions: script.repetitions.filter((x) => inside(x.t_start)),
    },
    chunks: chunks.filter((c) => inside(c.t_start)),
  };
}

// 한 회차 칸: 영상 + (구간이 여럿이면) 구간 버튼 + 스크립트. tone 이 이전(회색 점선)/이번(주황 네모) 표시를 정한다.
function SessionColumn({ tone, session, segments, script, chunks, scriptOpen, sameSentences }: {
  tone: 'base' | 'target'; session: CompareSession; segments: SegmentBrief[];
  script: ScriptData | null; chunks: VideoChunk[]; scriptOpen: boolean; sameSentences: Set<string>;
}) {
  const [seek, setSeek] = useState<{ t: number; n: number; play?: boolean }>({ t: segments[0]?.t_start ?? 0, n: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => { setSeek((s) => ({ t: segments[0]?.t_start ?? 0, n: s.n + 1 })); }, [segments]);

  const filtered = script ? scriptInSegments(script, chunks, segments) : null;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-baseline gap-2 min-w-0 h-6">
        <SessionMark tone={tone} />
        <span className="font-extrabold text-stone-900 text-[15px] whitespace-nowrap">{session.session_no}회차</span>
        <span className="text-[14px] text-stone-500 truncate">
          {segments[0]?.title ?? '이 구간 없음'}{segments.length > 1 ? ` 외 ${segments.length - 1}개` : ''}
        </span>
        <span className="ml-auto font-mono text-[14px] text-stone-500 whitespace-nowrap">{rangeText(segments)}</span>
      </div>
      <CompareVideo sessionId={session.session_id} hasVideo={session.has_video} seek={seek} onTime={setCurrentTime} onPlaying={setIsPlaying} />
      {segments.length === 0 ? (
        <div className="text-[15px] text-stone-400 border border-stone-200 rounded-xl px-4 py-6 text-center">이 회차에는 이 구간이 없어요</div>
      ) : (
        <>
          {segments.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {segments.map((s) => (
                <button key={s.segment_id} onClick={() => setSeek((p) => ({ t: s.t_start, n: p.n + 1 }))}
                  className="text-[14px] font-semibold px-2 py-0.5 rounded-md border border-stone-200 text-stone-600 hover:bg-stone-100">
                  {fmtTime(s.t_start)}~{fmtTime(s.t_end)} · {s.title}
                </button>
              ))}
            </div>
          )}
          {scriptOpen && (
            <div className="rounded-xl border border-stone-200 p-2 flex-1">
              {!filtered ? (
                <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-stone-400" /></div>
              ) : (
                <InteractiveScript
                  script={filtered.script}
                  videoChunks={filtered.chunks}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  onSeek={(sec) => setSeek((p) => ({ t: sec, n: p.n + 1, play: true }))}
                  segmentStarts={segments.map((s) => s.t_start)}
                  heightClass="max-h-[400px]"
                  sameSentences={sameSentences}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// 이전 회차 = 회색 점선, 이번 회차 = 주황 네모. 레이더·막대·영상 칸에서 같은 표시를 쓴다.
function SessionMark({ tone }: { tone: 'base' | 'target' }) {
  return tone === 'target'
    ? <span className="inline-block w-2.5 h-2.5 rounded-sm bg-orange-600 shrink-0 self-center" />
    : <span className="inline-block w-4 border-t-2 border-dashed border-stone-400 shrink-0 self-center" />;
}

const rangeText = (segments: SegmentBrief[]) => segments.map((s) => `${fmtTime(s.t_start)}~${fmtTime(s.t_end)}`).join(', ') || '-';

const VERDICT_TEXT: Record<string, { text: string; cls: string }> = {
  improved: { text: '좋아짐', cls: 'text-emerald-700' },
  same: { text: '비슷함', cls: 'text-stone-500' },
  worse: { text: '나빠짐', cls: 'text-rose-700' },
};

// 좋아짐 3 · 비슷함 2 · 나빠짐 1
function VerdictCounts({ metrics }: { metrics: MetricDiff[] }) {
  return (
    <div className="flex items-center gap-3 text-[14px] font-semibold whitespace-nowrap">
      {(['improved', 'same', 'worse'] as const).map((v) => (
        <span key={v} className={VERDICT_TEXT[v].cls}>{VERDICT_TEXT[v].text} {metrics.filter((m) => m.verdict === v).length}</span>
      ))}
    </div>
  );
}

// 레이더 축: 바깥쪽일수록 좋게 0~1 로 바꾼다.
//   full : 이 값이면 중심(가장 나쁨). 화면용 눈금으로, 판정(좋아짐/나빠짐)은 백엔드 값을 그대로 쓴다.
//   말하기 속도: 적정 범위(250~450 음절/분, 백엔드 SPM_SLOW·SPM_FAST) 안이면 맨 바깥, 벗어난 만큼 안쪽으로.
const RADAR_AXES: { key: string; name: string; score: (v: number) => number }[] = [
  { key: 'eye_contact_ratio', name: '시선 맞춤', score: (v) => v },
  { key: 'filler_per_min', name: '필러', score: (v) => 1 - v / 5 },
  { key: 'silence_ratio', name: '무음 비율', score: (v) => 1 - v / 0.25 },
  { key: 'speaking_rate_spm', name: '말하기 속도', score: (v) => 1 - Math.max(250 - v, 0, v - 450) / 150 },
  { key: 'repetition_per_min', name: '말 더듬', score: (v) => 1 - v / 2 },
  { key: 'negative_gesture_per_min', name: '부정적 제스처', score: (v) => 1 - v / 3 },
];
const VERDICT_FILL: Record<string, string> = {
  improved: 'rgb(var(--c-emerald-700))', worse: 'rgb(var(--c-rose-700))', same: 'rgb(var(--c-stone-800))',
};

function RadarChart({ metrics, baseNo, targetNo }: { metrics: MetricDiff[]; baseNo: number; targetNo: number }) {
  const W = 400, H = 316, CX = W / 2, CY = H / 2, R = 88;
  const point = (i: number, r: number) => {
    const a = (-90 + i * 60) * (Math.PI / 180);
    return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
  };
  const poly = (scores: number[]) => scores.map((s, i) => point(i, Math.max(s, 0.04) * R).join(',')).join(' ');
  const rows = RADAR_AXES.map((axis) => ({ axis, m: metrics.find((x) => x.key === axis.key) }));
  const scoreOf = (axis: typeof RADAR_AXES[number], v: number | null | undefined) => (v == null ? 0 : Math.min(1, Math.max(0, axis.score(v))));
  const baseScores = rows.map(({ axis, m }) => scoreOf(axis, m?.base));
  const targetScores = rows.map(({ axis, m }) => scoreOf(axis, m?.target));

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label={rows.map(({ axis, m }) => `${axis.name} ${fmtValue(m?.base, m?.unit ?? '')}에서 ${fmtValue(m?.target, m?.unit ?? '')}`).join(', ')}>
        {[0.25, 0.5, 0.75, 1].map((ring) => (
          <polygon key={ring} points={poly(Array(6).fill(ring))} fill="none" stroke="rgb(var(--c-stone-200))" strokeWidth={1} />
        ))}
        {rows.map((_, i) => {
          const [x, y] = point(i, R);
          return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke="rgb(var(--c-stone-200))" strokeWidth={1} />;
        })}
        <polygon points={poly(baseScores)} fill="none" stroke="rgb(var(--c-stone-500))" strokeWidth={1.5} strokeDasharray="4 3" />
        <polygon points={poly(targetScores)} fill="rgb(var(--c-orange-600))" fillOpacity={0.14} stroke="rgb(var(--c-orange-600))" strokeWidth={2} />
        {targetScores.map((s, i) => {
          const [x, y] = point(i, Math.max(s, 0.04) * R);
          return <circle key={i} cx={x} cy={y} r={3.5} fill="var(--chart-dot-ring)" stroke="rgb(var(--c-orange-600))" strokeWidth={2} />;
        })}
        {rows.map(({ axis, m }, i) => {
          const [px, py] = point(i, R);
          const isTop = i === 0, isBottom = i === 3;
          const left = i > 3;
          const x = isTop || isBottom ? px : px + (left ? -12 : 12);
          const y = isTop ? py - 30 : isBottom ? py + 22 : py - 3;
          const anchor = isTop || isBottom ? 'middle' : left ? 'end' : 'start';
          const unit = m ? unitSuffix(m.unit) : '';
          return (
            <text key={axis.key} x={x} y={y} textAnchor={anchor} fontSize={14}>
              <tspan x={x} fontWeight={700} fill="rgb(var(--c-stone-900))">{axis.name}</tspan>
              <tspan x={x} dy={18} fontSize={13} fill="rgb(var(--c-stone-500))">{fmtValue(m?.base, m?.unit ?? '')} → </tspan>
              <tspan fontSize={13} fontWeight={700} fill={m?.verdict ? VERDICT_FILL[m.verdict] : 'rgb(var(--c-stone-800))'}>{fmtValue(m?.target, m?.unit ?? '')}</tspan>
              {unit && <tspan fontSize={13} fill="rgb(var(--c-stone-500))"> {unit}</tspan>}
            </text>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[14px] text-stone-500 mt-1">
        <span className="inline-flex items-center gap-1.5"><SessionMark tone="target" />이번 {targetNo}회차</span>
        <span className="inline-flex items-center gap-1.5"><SessionMark tone="base" />이전 {baseNo}회차</span>
        <span>숫자 색: <b className="text-emerald-700">좋아짐</b> <b className="text-rose-700">나빠짐</b> 검정 비슷함</span>
      </div>
    </>
  );
}

// 구간 지표 한 줄의 막대 두 개. 막대 길이는 이 지표에서 두 회차 중 큰 값을 기준으로 그린다.
function MetricBars({ m }: { m: MetricDiff }) {
  const max = Math.max(m.base ?? 0, m.target ?? 0);
  const width = (v: number | null) => (v && max > 0 ? `${(v / max) * 100}%` : '0%');
  const unit = unitSuffix(m.unit);
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_78px_50px] sm:grid-cols-[96px_minmax(0,1fr)_96px_56px] gap-x-3 items-center py-3 border-t border-stone-100">
      <span className="text-[15px] text-stone-700 break-keep">{m.label}</span>
      <div className="space-y-2.5">
        <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden"><div className="h-full rounded-full bg-stone-400" style={{ width: width(m.base) }} /></div>
        <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden"><div className={`h-full rounded-full ${m.verdict === 'improved' ? 'bg-emerald-600' : 'bg-orange-600'}`} style={{ width: width(m.target) }} /></div>
      </div>
      <div className="text-[14px] leading-[1.35] whitespace-nowrap">
        <p className="text-stone-500">{fmtValue(m.base, m.unit)} {unit}</p>
        <p className="font-bold text-stone-900">{fmtValue(m.target, m.unit)} <span className="font-normal text-stone-500">{unit}</span></p>
      </div>
      <span className={`text-[14px] font-semibold text-right ${m.verdict ? VERDICT_TEXT[m.verdict].cls : ''}`}>{m.verdict ? VERDICT_TEXT[m.verdict].text : ''}</span>
    </div>
  );
}

// 구간별 비교 — 구간 라벨 탭, 지표 막대, 두 회차 영상·스크립트. 두 회차에서 같은 문장은 노랗게 표시한다.
function SegmentCompare({ labels, base, target }: { labels: LabelCompare[]; base: CompareSession; target: CompareSession }) {
  const [labelIdx, setLabelIdx] = useState(0);
  const [scriptOpen, setScriptOpen] = useState(true); // 스크립트 펼침/접힘 (두 회차 같이)
  const baseData = useSessionScript(base.session_id);
  const targetData = useSessionScript(target.session_id);
  const label = labels[Math.min(labelIdx, labels.length - 1)];

  const sameSentences = useMemo(() => {
    if (!label || !baseData.script || !targetData.script) return new Set<string>();
    const textsIn = (script: ScriptData, segments: SegmentBrief[]) =>
      new Set(scriptInSegments(script, [], segments).script.sentences.map((s) => normalizeSentence(s.text)).filter(Boolean));
    const a = textsIn(baseData.script, label.base_segments);
    const b = textsIn(targetData.script, label.target_segments);
    return new Set(Array.from(a).filter((t) => b.has(t)));
  }, [label, baseData.script, targetData.script]);

  if (!label) return null;
  return (
    <section className="border-t border-stone-200 pt-7 mt-9">
      <h3 className="font-extrabold text-stone-900 text-lg">구간별 비교</h3>
      <p className="text-[14.5px] text-stone-500 mt-0.5 mb-4">같은 성격의 구간(라벨)끼리 묶어서 비교해요.</p>
      <div className="flex gap-5 border-b border-stone-200 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {labels.map((l, idx) => (
          <button key={l.label} onClick={() => setLabelIdx(idx)}
            className={`pb-2 -mb-px border-b-2 whitespace-nowrap text-sm transition-colors ${idx === labelIdx ? 'border-stone-900 text-stone-900 font-bold' : 'border-transparent text-stone-500 font-medium hover:text-stone-800'}`}>
            {l.label}
            {l.status !== 'both' && <span className="ml-1.5 text-[13px] font-normal text-stone-400">{l.status === 'only_base' ? '이번엔 없음' : '새로 생김'}</span>}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-stone-200 p-5 mt-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 mb-3">
          <div>
            <h4 className="font-extrabold text-stone-900 text-[15.5px]">{label.label} 구간 지표</h4>
            <p className="text-[14px] text-stone-500 mt-0.5">{base.session_no}회차 {rangeText(label.base_segments)} · {target.session_no}회차 {rangeText(label.target_segments)}</p>
          </div>
          <VerdictCounts metrics={label.metrics} />
        </div>
        <div>{label.metrics.map((m) => <MetricBars key={m.key} m={m} />)}</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-stone-500 pt-3 border-t border-stone-100">
          <span className="inline-flex items-center gap-1.5"><span className="w-4 h-1.5 rounded-full bg-stone-400" />{base.session_no}회차 (위)</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-4 h-1.5 rounded-full bg-orange-600" />{target.session_no}회차 (아래)</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-4 h-1.5 rounded-full bg-emerald-600" />{target.session_no}회차 (좋아진 지표)</span>
          <span>막대 길이는 지표마다 두 회차 중 큰 값을 기준으로 그려요</span>
        </div>
      </div>

      <div className="flex justify-end mt-4 mb-2">
        <button onClick={() => setScriptOpen((o) => !o)} className="text-[14.5px] font-semibold text-stone-600 hover:text-stone-900 flex items-center gap-1">
          {scriptOpen ? '스크립트 접기' : '스크립트 펼치기'}
          <ChevronDown className={`w-4 h-4 transition-transform ${scriptOpen ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <div className="grid grid-cols-1 min-[1000px]:grid-cols-2 gap-5">
        <SessionColumn tone="base" session={base} segments={label.base_segments} script={baseData.script} chunks={baseData.chunks} scriptOpen={scriptOpen} sameSentences={sameSentences} />
        <SessionColumn tone="target" session={target} segments={label.target_segments} script={targetData.script} chunks={targetData.chunks} scriptOpen={scriptOpen} sameSentences={sameSentences} />
      </div>
      {scriptOpen && (
        <p className="mt-3 text-[14px] text-stone-500"><mark className="bg-yellow-200 text-stone-900 rounded-sm px-1 mr-1.5">노란 표시</mark>두 회차에서 같은 문장</p>
      )}
    </section>
  );
}

function FeedbackItemBlock({ item }: { item: FeedbackItem }) {
  const s = ITEM_TEXT[item.status];
  return (
    <li>
      <div className="flex items-baseline gap-2">
        <span className="text-[15.5px] font-bold text-stone-900">{item.title}</span>
        <span className={`text-[14px] font-semibold whitespace-nowrap ${s.cls}`}>{s.text}</span>
      </div>
      {item.previous && <p className="text-[14px] text-stone-500 mt-0.5">지난 지적 · {item.previous}</p>}
      <p className="text-[15px] text-stone-700 leading-relaxed mt-1">{item.detail}</p>
    </li>
  );
}

// 회차 고르기 — 폴더의 회차를 카드로 보여 주고 2개를 고르게 한다. 분석이 안 끝난 회차는 고를 수 없다.
// 고른 순서와 상관없이 앞 회차가 "이전", 뒤 회차가 "이번"이 된다.
function SessionPicker({ projects, projectId, onProjectChange, sessions, picks, setPicks, onCompare, history, onOpenHistory }: {
  projects: { id: string; name: string }[]; projectId: string; onProjectChange: (id: string) => void;
  sessions: CompareSession[] | null; picks: number[]; setPicks: (p: number[]) => void; onCompare: () => void;
  history: ComparisonListItem[]; onOpenHistory: (base: number, target: number) => void;
}) {
  const toggle = (id: number) => {
    if (picks.includes(id)) setPicks(picks.filter((p) => p !== id));
    else setPicks([...picks.slice(-1), id]); // 이미 2개면 먼저 고른 것을 빼고 새로 고른 것을 넣는다
  };
  const chosen = (sessions ?? []).filter((s) => picks.includes(s.session_id)).sort((a, b) => a.session_no - b.session_no);
  const comparableCount = (sessions ?? []).filter((s) => s.comparable).length;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 bg-white rounded-xl shadow-sm border border-stone-200 p-5 sm:p-6">
      <h3 className="font-extrabold text-stone-800 text-xl flex items-center gap-2 mb-1">
        <span className="bg-stone-100 text-stone-700 p-1.5 rounded-xl"><Columns className="w-5 h-5" /></span>
        비교할 회차 2개를 골라 주세요
      </h3>
      <p className="text-sm text-stone-500 mb-4">같은 프로젝트 안에서 분석이 끝난 회차끼리 비교할 수 있어요. 앞 회차가 &lsquo;이전&rsquo;, 뒤 회차가 &lsquo;이번&rsquo;이 돼요.</p>

      {/* 프로젝트 선택 — 설명 바로 아래에 크게. 아직 안 골랐으면 주황 테두리로 강조 */}
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 mb-5 ${projectId ? 'border-stone-200 bg-stone-50' : 'border-amber-300 bg-amber-50'}`}>
        <span className="text-base font-bold text-stone-700">프로젝트</span>
        <select value={projectId} onChange={(e) => onProjectChange(e.target.value)}
          className="flex-1 min-w-[200px] border border-stone-300 rounded-lg px-3 py-2.5 text-[18px] font-semibold text-stone-800 bg-white">
          {!projectId && <option value="">비교할 프로젝트를 골라 주세요</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {!projectId ? (
        <p className="text-base text-stone-400 text-center py-6">프로젝트를 고르면 회차 목록이 나와요</p>
      ) : !sessions ? (
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-stone-400" /></div>
      ) : sessions.length === 0 ? (
        <p className="text-base text-stone-400 text-center py-10">이 프로젝트에는 아직 회차가 없어요</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {sessions.map((s) => {
              const on = picks.includes(s.session_id);
              return (
                <button key={s.session_id} disabled={!s.comparable} onClick={() => toggle(s.session_id)}
                  className={`text-left rounded-xl border px-4 py-3 transition-all flex items-start gap-3
                    ${on ? 'border-stone-800 bg-stone-50 ring-1 ring-stone-800' : 'border-stone-200 bg-white hover:bg-stone-50'}
                    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white`}>
                  <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-stone-800 border-stone-800' : 'border-stone-300'}`}>
                    {on && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-bold text-stone-800">{s.session_no}회차</span>
                    <span className="block text-sm text-stone-500">{s.created_at.slice(0, 10).replace(/-/g, '.')}{s.comparable ? '' : ' · 분석 전'}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {comparableCount < 2 && (
            <p className="text-base text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 mt-4">
              분석이 끝난 회차가 2개 이상 있어야 비교할 수 있어요. (지금 {comparableCount}개)
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3 mt-5">
            <span className="text-base font-semibold text-stone-600">
              {chosen.length === 2 ? `${chosen[0].session_no}회차 → ${chosen[1].session_no}회차` : `${chosen.length}/2 선택`}
            </span>
            <button onClick={onCompare} disabled={chosen.length !== 2}
              className="bg-stone-900 text-white font-bold text-base rounded-xl px-5 py-2.5 hover:bg-stone-800 disabled:opacity-40 flex items-center gap-1.5">
              비교하기 <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}

      {projectId && history.length > 0 && <CompareHistory items={history} onOpen={onOpenHistory} />}
    </div>
  );
}

// 지난 AI 비교 기록 — 이 폴더에서 AI 비교 피드백을 만든 회차 쌍 (최신순). 누르면 그 두 회차 비교를 다시 연다.
function CompareHistory({ items, onOpen }: { items: ComparisonListItem[]; onOpen: (base: number, target: number) => void }) {
  return (
    <div className="mt-6 pt-5 border-t border-stone-200">
      <h4 className="font-bold text-stone-700 text-base flex items-center gap-1.5 mb-3">
        <History className="w-4 h-4 text-stone-500" />
        지난 AI 비교 기록
      </h4>
      <ul className="space-y-2">
        {items.map((c) => {
          const openable = c.base_session_id != null && c.target_session_id != null;
          return (
            <li key={c.comparison_id}>
              <button disabled={!openable} onClick={() => openable && onOpen(c.base_session_id!, c.target_session_id!)}
                className="w-full text-left rounded-xl border border-stone-200 bg-white px-4 py-3 hover:bg-stone-50 transition-colors flex items-center gap-3
                  disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white">
                <span className="shrink-0 font-bold text-stone-800 whitespace-nowrap">
                  {c.base_session_no}회차 <ArrowRight className="inline w-3.5 h-3.5 text-stone-400 -mt-0.5" /> {c.target_session_no}회차
                </span>
                <span className="min-w-0 flex-1 text-[15px] text-stone-600 truncate">
                  {!openable ? '회차가 삭제돼 다시 열 수 없어요'
                    : c.status === 'error' ? <span className="text-rose-600">AI 비교 피드백을 만들지 못했어요</span>
                    : c.headline || 'AI 비교 피드백'}
                </span>
                <span className="shrink-0 text-sm text-stone-400">{c.created_at.slice(0, 10).replace(/-/g, '.')}</span>
                {openable && <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function CompareView({ projects, projectId, onProjectChange, initialSessionId, onOpenFolder }: {
  projects: { id: string; name: string }[];
  projectId: string;                       // 지금 열린 프로젝트 (없으면 '')
  onProjectChange: (projectId: string) => void;
  initialSessionId: string;                // 보던 회차가 있으면 미리 골라 둔다
  onOpenFolder: (projectId: string) => void; // 경로의 폴더 이름을 눌렀을 때
}) {
  const [sessions, setSessions] = useState<CompareSession[] | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [pair, setPair] = useState<{ base: number; target: number } | null>(null); // "비교하기"를 누른 두 회차
  const [data, setData] = useState<ProjectCompare | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [history, setHistory] = useState<ComparisonListItem[]>([]);

  // 프로젝트가 바뀌면 회차 목록을 새로 받고 고르기부터 다시
  useEffect(() => {
    setSessions(null);
    setPair(null);
    setData(null);
    setLoadError(null);
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const res = await apiFetch(`/projects/${projectId}/compare`);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError('회차 목록을 불러오지 못했어요.');
        return;
      }
      const list: CompareSession[] = (await res.json()).sessions;
      setSessions(list);
      const init = list.find((s) => String(s.session_id) === initialSessionId && s.comparable);
      setPicks(init ? [init.session_id] : []);
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // 지난 AI 비교 기록 — 폴더가 바뀔 때, 그리고 비교 결과에서 고르기 화면으로 돌아올 때(새로 만든 기록 반영) 받는다.
  // 기록을 못 받아도 비교 기능은 그대로 쓸 수 있으니 실패는 조용히 넘긴다.
  useEffect(() => {
    setHistory([]);
    if (!projectId || pair) return;
    let cancelled = false;
    apiFetch(`/projects/${projectId}/comparisons`)
      .then((res) => (res.ok ? res.json() : []))
      .then((list: ComparisonListItem[]) => { if (!cancelled) setHistory(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, pair]);

  // 두 회차를 고르고 "비교하기"를 누르면 비교 결과를 받는다
  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    setData(null);
    setLoadError(null);
    setGenError(null);
    (async () => {
      const res = await apiFetch(`/projects/${projectId}/compare?base=${pair.base}&target=${pair.target}`);
      if (cancelled) return;
      if (!res.ok) {
        setLoadError('비교 결과를 불러오지 못했어요.');
        return;
      }
      setData(await res.json());
    })();
    return () => { cancelled = true; };
  }, [pair]);

  const startCompare = () => {
    const chosen = (sessions ?? []).filter((s) => picks.includes(s.session_id)).sort((a, b) => a.session_no - b.session_no);
    if (chosen.length === 2) setPair({ base: chosen[0].session_id, target: chosen[1].session_id });
  };

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
    return (
      <div className="bg-rose-50 border border-rose-200 text-rose-700 text-base rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="mr-auto">{loadError}</span>
        {/* 비교를 열다 실패했으면(지난 기록의 회차가 다시 분석 전 상태가 된 경우 등) 고르기 화면으로 돌아갈 수 있게 */}
        {pair && (
          <button onClick={() => { setLoadError(null); setPair(null); }}
            className="flex items-center gap-1 text-sm font-semibold text-rose-700 hover:text-rose-900">
            <ArrowLeft className="w-4 h-4" /> 회차 다시 고르기
          </button>
        )}
      </div>
    );
  }
  if (!pair) {
    return (
      <SessionPicker projects={projects} projectId={projectId} onProjectChange={onProjectChange}
        sessions={sessions} picks={picks} setPicks={setPicks} onCompare={startCompare}
        history={history} onOpenHistory={(base, target) => { setPicks([base, target]); setPair({ base, target }); }} />
    );
  }
  if (!data || !data.base || !data.target) {
    return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>;
  }

  const { base, target } = data;
  const fb = data.feedback && data.feedback.status === 'done' ? data.feedback : null;
  const better = fb ? fb.items.filter((i) => i.status === 'resolved' || i.status === 'improved') : [];
  const remain = fb ? fb.items.filter((i) => i.status === 'persists' || i.status === 'new') : [];
  const metricOf = (key: string) => data.metrics.find((m) => m.key === key);
  const general = metricOf('general_gesture_per_min');
  const duration = metricOf('duration_sec');
  const projectName = projects.find((p) => p.id === projectId)?.name ?? '';

  return (
    <div className="bg-white rounded-2xl border border-stone-200 shadow-sm px-5 sm:px-8 py-7">
      {/* 경로 */}
      <div className="flex items-center gap-1.5 text-[14px] text-stone-500 min-w-0 mb-4">
        <button onClick={() => onOpenFolder(projectId)} title={`${projectName} 폴더로 이동`} className="hover:text-stone-900 hover:underline truncate">{projectName}</button>
        <span className="text-stone-300">/</span>
        <span className="font-semibold text-stone-900 whitespace-nowrap">회차 비교</span>
      </div>

      {/* 비교 중인 두 회차 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="flex items-center gap-2 mr-auto whitespace-nowrap">
          <SessionMark tone="base" />
          <span className="text-[14px] text-stone-500">이전</span>
          <span className="text-[22px] font-extrabold text-stone-500">{base.session_no}회차</span>
          <ArrowRight className="w-4 h-4 text-stone-400 mx-1" />
          <SessionMark tone="target" />
          <span className="text-[14px] text-stone-500">이번</span>
          <span className="text-[22px] font-extrabold text-stone-900">{target.session_no}회차</span>
        </h2>
        <VerdictCounts metrics={data.metrics} />
        <button onClick={() => setPair(null)}
          className="text-[15px] font-semibold text-stone-700 border border-stone-200 rounded-lg px-3 py-1.5 hover:bg-stone-50 flex items-center gap-1 whitespace-nowrap">
          <ChevronLeft className="w-4 h-4" />회차 다시 고르기
        </button>
      </div>

      <div className="grid grid-cols-1 min-[1000px]:grid-cols-2 gap-x-8 gap-y-8 mt-8">
        {/* ① 총 지표 비교 */}
        <section className="min-w-0">
          <h3 className="font-extrabold text-stone-900 text-lg">총 지표 비교</h3>
          <p className="text-[14.5px] text-stone-500 mt-0.5 mb-3 break-keep">바깥쪽일수록 좋아요. 횟수는 분당 횟수로 비교하고, 작은 차이는 &lsquo;비슷함&rsquo;으로 봐요.</p>
          <div className="rounded-2xl border border-stone-200 p-3 sm:p-4">
            <RadarChart metrics={data.metrics} baseNo={base.session_no} targetNo={target.session_no} />
          </div>
          <div className="bg-stone-100 rounded-xl px-4 py-3 mt-3 grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <p className="text-[14px] text-stone-500">일반 제스처</p>
              <p className="mt-1 text-[14px] text-stone-500 flex flex-wrap items-baseline gap-x-1.5">
                {fmtValue(general?.base, '회/분')} → <b className="text-[18px] font-extrabold text-stone-900">{fmtValue(general?.target, '회/분')}</b> 회/분
                {general?.base_count != null && general.target_count != null && <span>· {general.base_count}회 → {general.target_count}회</span>}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[14px] text-stone-500">발표 길이</p>
              <p className="mt-1 text-[14px] text-stone-500 flex flex-wrap items-baseline gap-x-1.5">
                {fmtValue(duration?.base, '초')} → <b className="text-[18px] font-extrabold text-stone-900">{fmtValue(duration?.target, '초')}</b>
              </p>
            </div>
          </div>
        </section>

        {/* ② AI 비교 피드백 */}
        <section className="min-w-0">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-extrabold text-stone-900 text-lg">AI 비교 피드백</h3>
            {fb && (
              <button onClick={generate} disabled={generating}
                className="text-[14.5px] font-semibold text-stone-600 hover:text-stone-900 flex items-center gap-1.5 disabled:opacity-50">
                <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />다시 만들기
              </button>
            )}
          </div>

          {fb?.stale && (
            <div className="bg-orange-50 text-orange-800 text-[15px] rounded-xl px-3.5 py-2.5 mb-3">
              피드백을 만든 뒤 회차가 다시 분석됐어요. &lsquo;다시 만들기&rsquo;로 최신 결과를 반영하세요.
            </div>
          )}
          {genError && <div className="bg-rose-50 text-rose-700 text-[15px] rounded-xl px-3.5 py-2.5 mb-3">{genError}</div>}

          {!fb ? (
            <div className="text-center py-12 rounded-2xl border border-dashed border-stone-200">
              <p className="text-[15.5px] text-stone-500 mb-4 px-4 break-keep">
                {base.session_no}회차에서 받은 개선점을 {target.session_no}회차에서 고쳤는지 AI 가 확인해 드려요.
              </p>
              <button onClick={generate} disabled={generating}
                className="bg-stone-900 text-white font-bold text-[15px] rounded-xl px-5 py-2.5 inline-flex items-center gap-2 hover:bg-stone-800 disabled:opacity-60">
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {generating ? '비교하는 중… (10초 정도)' : 'AI 비교 피드백 만들기'}
              </button>
            </div>
          ) : (
            <>
              {fb.headline && <p className="text-[21px] leading-snug font-extrabold text-stone-900 mb-4 break-keep text-balance">{fb.headline}</p>}
              <h4 className="text-[15px] font-bold text-emerald-700 mb-2.5">나아진 점</h4>
              {better.length === 0 ? <p className="text-[15px] text-stone-400 mb-4">없어요</p> : (
                <ul className="space-y-4 mb-5">{better.map((it, i) => <FeedbackItemBlock key={i} item={it} />)}</ul>
              )}
              <div className="bg-orange-50 rounded-xl p-4">
                <h4 className="text-[15px] font-bold text-orange-800 mb-2.5">남은 과제</h4>
                {remain.length === 0 ? <p className="text-[15px] text-stone-400">없어요</p> : (
                  <ul className="space-y-4">{remain.map((it, i) => <FeedbackItemBlock key={i} item={it} />)}</ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ③ 구간별 비교 + 스크립트. 두 회차가 바뀌면 탭·스크립트 상태를 처음으로 */}
      <SegmentCompare key={`${base.session_id}-${target.session_id}`} labels={data.labels} base={base} target={target} />
    </div>
  );
}
