"use client";

// 단일 분석 화면 — 위에서 아래로 ① 종합 피드백 ② 구간별 지표 ③ 구간별 영상 타임라인과 스크립트 ④ 구간별 AI 피드백.
// 데이터를 불러오고 영상을 다루는 일은 page.tsx 가 하고, 여기서는 받은 값을 보여 주기만 한다.

import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import InteractiveScript, { fmtTime, ScriptData, TimestampText, VideoChunk } from './InteractiveScript';

// 구간(STEP 4)과 구간별 피드백(STEP 5) — GET /sessions/{id}/segment-feedback
type SegmentRating = '잘함' | '보통' | '개선필요';
export interface ApiSegment {
  segment_id: number;
  label: string | null;
  title: string;
  t_start: number;
  t_end: number;
  // 아직 없으면 null. rating 은 나중에 추가돼서 예전에 분석한 구간은 null
  feedback: { rating: SegmentRating | null; strengths: string[]; improvements: string[] } | null;
}
// 구간별 지표 — GET /sessions/{id}/segments/trend 의 points
export interface TrendPoint {
  segment_id: number;
  label: string | null;
  title: string;
  filler_count: number | null;
  repetition_count: number | null;
  speaking_rate_spm: number | null;
  silence_ratio: number | null; // 0~1
}
// GET /sessions/{id}/voice-summary 응답. 아직 없는 값은 null.
export interface VoiceSummary {
  filler_count: number | null;
  repetition_count: number | null;
  silence_ratio: number | null;          // 0~1
  avg_speaking_rate_spm: number | null;  // 음절/분
}

// 구간 이름으로 보여줄 글자 — 분류 라벨(도입 등)이 있으면 그걸, 없으면 한 줄 요약 제목.
export const segmentName = (seg: { label: string | null; title: string }) => seg.label || seg.title;

// gesture_counts 7종(app/pipeline/step2_video_analysis.py) 중 일반/부정적 제스처로 묶는 기준.
const GENERAL_GESTURE_KEYS = ['explanatory_gesture', 'pointing', 'body_movement'];
const NEGATIVE_GESTURE_KEYS = ['distracting_gesture', 'touching_face_or_hair', 'fidgeting_with_objects', 'closed_posture'];

const sumCounts = (chunks: VideoChunk[], keys: string[]) =>
  chunks.reduce((total, c) => total + keys.reduce((sum, k) => sum + (c.gesture_counts?.[k] || 0), 0), 0);

// 동작 분석 조각(약 20초)을 "시작 시각"이 속한 구간 한 곳에만 넣는다 — 마지막 구간만 끝 시각도 포함.
// (STEP 4 집계 API 는 경계에 걸친 조각을 겹치는 구간마다 넣어서 구간별 합이 실제 총합보다 커진다.)
function chunksOfSegment(segments: ApiSegment[], chunks: VideoChunk[], idx: number) {
  const seg = segments[idx];
  const isLast = idx === segments.length - 1;
  return chunks.filter((c) => c.t_start >= seg.t_start && (c.t_start < seg.t_end || isLast));
}

// 구간과 겹치는 무음 시간의 합(초)
function silenceSecIn(script: ScriptData | null, from: number, to: number) {
  return (script?.silences ?? []).reduce((sum, s) => sum + Math.max(0, Math.min(s.t_end, to) - Math.max(s.t_start, from)), 0);
}

// 문단을 문장으로 나눈다. 마침표 뒤에 공백이 있을 때만 잘라서 "1.5" 같은 숫자는 안 잘린다.
const splitSentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

// 지표 탭. tone: 적을수록 좋은 지표는 빨강 계열, 좋고 나쁨을 따지지 않는 지표는 회색 계열.
const METRICS = [
  { id: 'filler', tab: '필러 단어 빈도', unit: '회', peak: '최다 구간', tone: 'rgb(var(--c-rose-600))' },
  { id: 'rate', tab: '평균 말하기 속도', unit: '음절/분', peak: '가장 빠른 구간', tone: 'rgb(var(--c-stone-600))' },
  { id: 'silence', tab: '전체 무음 시간', unit: '초', peak: '최다 구간', tone: 'rgb(var(--c-rose-600))' },
  { id: 'repetition', tab: '말 더듬기', unit: '회', peak: '최다 구간', tone: 'rgb(var(--c-rose-600))' },
  { id: 'general', tab: '일반 제스처', unit: '회', peak: '최다 구간', tone: 'rgb(var(--c-stone-600))' },
  { id: 'negative', tab: '부정적 제스처', unit: '회', peak: '최다 구간', tone: 'rgb(var(--c-rose-600))' },
] as const;
type MetricId = typeof METRICS[number]['id'];

const RATING_TONE: Record<SegmentRating, string> = {
  '잘함': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '보통': 'bg-stone-100 text-stone-600 border-stone-200',
  '개선필요': 'bg-orange-50 text-orange-700 border-orange-200',
};

const PLOT_LEFT = 36, PLOT_RIGHT = 12; // 구간별 지표 그래프의 왼쪽 축 폭·오른쪽 여백

const tabClass = (on: boolean) =>
  `pb-2 -mb-px border-b-2 whitespace-nowrap text-sm transition-colors ${on ? 'border-stone-900 text-stone-900 font-bold' : 'border-transparent text-stone-500 font-medium hover:text-stone-800'}`;

function Section({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-stone-200 pt-7 mt-9">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-4">
        <h3 className="font-extrabold text-stone-900 text-lg">{title}</h3>
        {hint && <div className="text-[14px] text-stone-500">{hint}</div>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-stone-50 border border-dashed border-stone-200 py-8 px-4 text-center text-sm text-stone-400 font-medium">{children}</div>;
}

// ② 구간별 지표 — 왼쪽 요약 수치, 오른쪽 구간별 선 그래프. 그래프를 누르면 그 구간으로 이동한다.
function SegmentMetrics({ segments, trend, chunks, script, voice, activeIndex, onSelect }: {
  segments: ApiSegment[]; trend: TrendPoint[]; chunks: VideoChunk[]; script: ScriptData | null;
  voice: VoiceSummary | null; activeIndex: number; onSelect: (idx: number) => void;
}) {
  const [metricId, setMetricId] = useState<MetricId>('filler');
  const metric = METRICS.find((m) => m.id === metricId)!;

  const valueOf = (seg: ApiSegment, idx: number): number => {
    const p = trend.find((t) => t.segment_id === seg.segment_id);
    switch (metricId) {
      case 'filler': return p?.filler_count ?? 0;
      case 'rate': return Math.round(p?.speaking_rate_spm ?? 0);
      case 'silence': return Math.round(silenceSecIn(script, seg.t_start, seg.t_end) * 10) / 10;
      case 'repetition': return p?.repetition_count ?? 0;
      case 'general': return sumCounts(chunksOfSegment(segments, chunks, idx), GENERAL_GESTURE_KEYS);
      case 'negative': return sumCounts(chunksOfSegment(segments, chunks, idx), NEGATIVE_GESTURE_KEYS);
    }
  };
  const data = segments.map((seg, idx) => ({ idx, name: segmentName(seg), value: valueOf(seg, idx) }));

  const total: number | null = (() => {
    switch (metricId) {
      case 'filler': return voice?.filler_count ?? null;
      case 'rate': return voice?.avg_speaking_rate_spm == null ? null : Math.round(voice.avg_speaking_rate_spm);
      case 'silence': return script ? Math.round((script.silences ?? []).reduce((s, x) => s + x.duration, 0) * 10) / 10 : null;
      case 'repetition': return voice?.repetition_count ?? null;
      case 'general': return chunks.length ? sumCounts(chunks, GENERAL_GESTURE_KEYS) : null;
      case 'negative': return chunks.length ? sumCounts(chunks, NEGATIVE_GESTURE_KEYS) : null;
    }
  })();

  const max = Math.max(0, ...data.map((d) => d.value));
  const peaks = max > 0 ? data.filter((d) => d.value === max).map((d) => d.name) : [];
  const shortUnit = metric.unit.length <= 1;

  return (
    <>
      <div className="flex gap-5 border-b border-stone-200 mb-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {METRICS.map((m) => (
          <button key={m.id} onClick={() => setMetricId(m.id)} className={tabClass(m.id === metricId)}>{m.tab}</button>
        ))}
      </div>
      <div className="rounded-2xl border border-stone-200 p-5 grid grid-cols-1 sm:grid-cols-[170px_minmax(0,1fr)] gap-4 items-center">
        <div className="min-w-0">
          <p className="text-[14px] text-stone-500">{metric.tab} · 전체</p>
          <p className="my-1 font-extrabold text-stone-900 text-[34px] leading-tight whitespace-nowrap">
            {total ?? '-'}
            {total != null && <span className={shortUnit ? '' : 'text-base font-bold ml-1 text-stone-500'}>{metric.unit}</span>}
          </p>
          <p className="text-[14px] text-stone-500 break-keep">
            {peaks.length > 0 ? `${metric.peak} · ${peaks.join(' · ')}` : '모든 구간에서 없었어요'}
          </p>
        </div>
        {/* 눌린 가로 위치로 구간을 찾는다 (점뿐 아니라 그 구간 칸 어디를 눌러도 이동) */}
        <div
          className="h-[200px] min-w-0 cursor-pointer [&_*]:outline-none"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const idx = Math.floor(((e.clientX - rect.left - PLOT_LEFT) / (rect.width - PLOT_LEFT - PLOT_RIGHT)) * segments.length);
            if (segments[idx]) onSelect(idx);
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 18, right: PLOT_RIGHT, bottom: 4, left: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="idx" type="category" scale="band" interval={0} axisLine={false} tickLine={false} dy={6}
                tick={({ x, y, payload }: { x: number | string; y: number | string; payload: { value: number } }) => {
                  const name = data[payload.value]?.name ?? '';
                  return (
                    <text x={Number(x)} y={Number(y) + 8} textAnchor="middle" fontSize={13.5}
                      fontWeight={payload.value === activeIndex ? 700 : 500}
                      fill={payload.value === activeIndex ? 'rgb(var(--c-stone-900))' : 'var(--chart-axis)'}>
                      {name.length > 7 ? `${name.slice(0, 6)}…` : name}
                    </text>
                  );
                }}
              />
              <YAxis axisLine={false} tickLine={false} width={PLOT_LEFT} domain={[0, 'auto']} allowDecimals={false} tick={{ fill: 'var(--chart-axis)', fontSize: 13 }} />
              <Tooltip
                cursor={{ stroke: 'var(--chart-cursor-line)', strokeWidth: 1 }}
                labelFormatter={(idx) => data[Number(idx)]?.name ?? ''}
                formatter={(value) => [`${value}${metric.unit}`, metric.tab]}
                contentStyle={{ borderRadius: 10, border: '1px solid rgb(var(--c-stone-200))', background: 'rgb(var(--c-white))', fontSize: 14, padding: '8px 12px' }}
              />
              <Line
                type="monotone" dataKey="value" stroke={metric.tone} strokeWidth={2} isAnimationActive={false}
                dot={{ r: 4, fill: 'var(--chart-dot-ring)', stroke: metric.tone, strokeWidth: 2 }}
                activeDot={{ r: 6, fill: metric.tone, stroke: 'var(--chart-dot-ring)', strokeWidth: 2 }}
                label={({ x, y, value }: { x?: number | string; y?: number | string; value?: unknown }) =>
                  Number(value) > 0 ? <text x={Number(x)} y={Number(y) - 10} textAnchor="middle" fontSize={13} fontWeight={700} fill={metric.tone}>{String(value)}</text> : <g />}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

// 구간 등급 뱃지 — 구간별 AI 피드백의 범례와 각 행에서 같이 쓴다.
function RatingBadge({ rating }: { rating: SegmentRating }) {
  return <span className={`shrink-0 px-2.5 py-0.5 rounded-full border text-[13px] font-bold whitespace-nowrap ${RATING_TONE[rating]}`}>{rating}</span>;
}

// ④ 구간별 AI 피드백 한 행. 번호 · 구간 정보 · 등급은 늘 보이고, 펼치면 잘한 점 · 개선점, 접으면 요약 한 줄.
function SegmentFeedbackRow({ seg, no, open, onToggle, onSeek }: { seg: ApiSegment; no: number; open: boolean; onToggle: () => void; onSeek: (sec: number) => void }) {
  const fb = seg.feedback;
  const timeRange = `${fmtTime(seg.t_start)}~${fmtTime(seg.t_end)}`;
  const timeButton = (
    <button
      onClick={(e) => { e.stopPropagation(); onSeek(seg.t_start); }}
      title="이 구간부터 재생"
      className="font-mono text-[14px] text-stone-500 hover:text-stone-900 hover:underline whitespace-nowrap"
    >
      {timeRange}
    </button>
  );
  const chevron = (
    <button
      aria-expanded={open}
      aria-label={`${segmentName(seg)} 피드백 ${open ? '접기' : '펼치기'}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="p-1 -m-1 text-stone-400 hover:text-stone-800 shrink-0"
    >
      <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
  const number = <span className="w-8 h-8 rounded-full bg-stone-100 text-stone-600 text-[14px] font-bold flex items-center justify-center shrink-0">{no}</span>;

  if (!open) {
    // 접힌 행의 요약 — 백엔드에 따로 요약이 없어서 첫 번째 개선점(없으면 잘한 점, 구간 제목)을 한 줄로 보여 준다
    const summary = fb?.improvements[0] ?? fb?.strengths[0] ?? seg.title;
    return (
      <div onClick={onToggle} className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[240px_minmax(0,1fr)_auto] gap-x-5 gap-y-1 items-center py-4 cursor-pointer group">
        <div className="flex items-center gap-3 min-w-0">
          {number}
          <div className="min-w-0 flex-1">
            <h4 className="font-extrabold text-stone-900 text-[16px] truncate group-hover:underline">{segmentName(seg)}</h4>
            {timeButton}
          </div>
          {fb?.rating && <RatingBadge rating={fb.rating} />}
        </div>
        <p className="hidden md:block text-[15px] text-stone-500 truncate">{summary}</p>
        {chevron}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)] gap-x-5 gap-y-4 py-6">
      <div className="flex items-start gap-3 min-w-0">
        {number}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-h-8">
            <h4 onClick={onToggle} className="flex-1 min-w-0 font-extrabold text-stone-900 text-[16px] truncate cursor-pointer hover:underline">{segmentName(seg)}</h4>
            {fb?.rating && <RatingBadge rating={fb.rating} />}
            {chevron}
          </div>
          {timeButton}
          <p className="mt-1 text-[14.5px] text-stone-600 break-keep">{seg.title}</p>
        </div>
      </div>
      {fb ? (
        <>
          <div className="min-w-0">
            <h5 className="text-[15px] font-bold text-emerald-700 mb-2">잘한 점</h5>
            {fb.strengths.length === 0 ? <p className="text-[15px] text-stone-400">없어요</p> : (
              <div className="space-y-2.5">
                {fb.strengths.map((item, i) => (
                  <p key={i} className="text-[15px] text-stone-700 leading-relaxed"><TimestampText text={item} onSeek={onSeek} /></p>
                ))}
              </div>
            )}
          </div>
          <div className="min-w-0 bg-orange-50 rounded-xl p-4">
            <h5 className="text-[15px] font-bold text-orange-800 mb-2">개선점</h5>
            {fb.improvements.length === 0 ? <p className="text-[15px] text-stone-400">없어요</p> : (
              <div className="space-y-2.5">
                {fb.improvements.map((item, i) => (
                  <p key={i} className="text-[15px] text-stone-700 leading-relaxed"><TimestampText text={item} onSeek={onSeek} /></p>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="md:col-span-2 text-sm text-stone-400 font-medium">이 구간의 AI 피드백이 아직 없습니다.</p>
      )}
    </div>
  );
}

export default function SingleView({
  topicName, sessionName, onOpenFolder, missingSteps, retrying, retryLabel, retryFailed, retryError, onRetry, reportHref, headline, summary, durationSec, voice, chunks, script,
  segments, trend, activeSegmentIndex, playingSegment, currentTime, isPlaying, videoNode, onSeek, onSelectSegment,
}: {
  topicName: string; sessionName: string; onOpenFolder: () => void;
  missingSteps: string[]; retrying: boolean; retryLabel: string; retryFailed: boolean; retryError: string | null;
  onRetry: () => void; reportHref: string; headline: string | null; summary: string | null; durationSec: number | null;
  voice: VoiceSummary | null; chunks: VideoChunk[]; script: ScriptData | null;
  segments: ApiSegment[]; trend: TrendPoint[]; activeSegmentIndex: number; playingSegment: ApiSegment | null;
  currentTime: number; isPlaying: boolean; videoNode: React.ReactNode;
  onSeek: (sec: number) => void; onSelectSegment: (idx: number) => void;
}) {
  const [scriptPlain, setScriptPlain] = useState(false); // false = 분석 스크립트, true = 원본 스크립트(문장만)

  // 처음에는 앞의 두 구간만 펼쳐 둔다. 세션이 바뀌면 다시 처음 상태로.
  const firstTwoKey = segments.slice(0, 2).map((s) => s.segment_id).join(',');
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  useEffect(() => { setOpenIds(new Set(segments.slice(0, 2).map((s) => s.segment_id))); }, [firstTwoKey]);
  const toggleOpen = (id: number) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const sentences = useMemo(() => (summary ? splitSentences(summary) : []), [summary]);

  const countOf = (key: string) => (chunks.length ? sumCounts(chunks, [key]) : null);
  const statCards: { title: string; value: string; alert: boolean }[] = [
    { title: '발표 길이', value: durationSec != null ? fmtTime(durationSec) : '-', alert: false },
    { title: '필러 단어', value: voice?.filler_count != null ? `${voice.filler_count}회` : '-', alert: (voice?.filler_count ?? 0) > 0 },
    { title: '설명 제스처', value: countOf('explanatory_gesture') != null ? `${countOf('explanatory_gesture')}회` : '-', alert: false },
    { title: '얼굴·머리 만지기', value: countOf('touching_face_or_hair') != null ? `${countOf('touching_face_or_hair')}회` : '-', alert: (countOf('touching_face_or_hair') ?? 0) > 0 },
  ];

  // 그래프나 구간 버튼을 누르면 영상이 그 구간부터 재생되므로, 영상이 화면에 보이게 스크롤한다.
  const goToSegment = (idx: number) => {
    onSelectSegment(idx);
    document.getElementById('single-video-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const totalLength = segments.reduce((sum, s) => sum + Math.max(s.t_end - s.t_start, 0), 0);

  return (
    <div className="bg-white rounded-3xl shadow-sm px-5 sm:px-8 py-7">
      {/* 경로 — 폴더 이름을 누르면 그 폴더(세션 목록 + 종합추이)로 */}
      <div className="flex items-center gap-1.5 text-[14px] text-stone-500 min-w-0 mb-5">
        <button onClick={onOpenFolder} title={`${topicName} 폴더로 이동`} className="hover:text-stone-900 hover:underline truncate">{topicName}</button>
        <span className="text-stone-300">/</span>
        <span className="font-semibold text-stone-900 whitespace-nowrap">{sessionName}</span>
      </div>

      {missingSteps.length > 0 && (
        <div className="flex items-start gap-2.5 bg-orange-50 text-orange-800 rounded-xl px-4 py-3 mb-6">
          {retrying ? <Loader2 className="w-4 h-4 mt-1 shrink-0 animate-spin" /> : <AlertCircle className="w-4 h-4 mt-1 shrink-0" />}
          <div className="min-w-0 flex-1">
            {retrying ? (
              <>
                <p className="font-bold text-[16px]">다시 분석하는 중이에요</p>
                <p className="text-[15px] mt-0.5">{retryLabel || '준비하고 있어요'}. 몇 분 걸릴 수 있으니 이 화면을 닫지 말아 주세요.</p>
              </>
            ) : (
              <>
                <p className="font-bold text-[16px]">{retryFailed ? '다시 분석했지만 끝내지 못했어요' : '분석이 끝까지 진행되지 않았어요'}</p>
                <p className="text-[15px] mt-0.5 break-keep">
                  {missingSteps.join(', ')} 결과가 없어요. 아래에는 분석된 곳까지만 보여요.
                  {retryFailed && ' 계속 안 되면 오류를 신고해 주세요.'}
                </p>
                {retryError && <p className="text-[14px] mt-1 break-words">{retryError}</p>}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2.5">
                  <button onClick={onRetry} className="bg-stone-900 text-white font-bold text-[15px] rounded-lg px-3.5 py-1.5 hover:bg-stone-700 inline-flex items-center gap-1.5">
                    <RefreshCw className="w-4 h-4" />다시 분석하기
                  </button>
                  <a href={reportHref} className="text-[15px] font-semibold underline underline-offset-2 hover:text-orange-900">오류 신고하기</a>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ① 종합 피드백 */}
      <h3 className="font-extrabold text-stone-900 text-lg mb-3">종합 피드백</h3>
      <div className="grid grid-cols-1 min-[1000px]:grid-cols-[minmax(0,1fr)_256px] gap-x-10 gap-y-6 items-start">
        <div className="min-w-0">
          {headline && <h2 className="text-[26px] leading-[1.35] font-extrabold text-stone-900 mb-4 text-balance break-keep">{headline}</h2>}
          {summary ? (
            <ul className="space-y-2">
              {sentences.map((sentence, i) => (
                <li key={i} className="flex gap-2.5 text-[15.5px] text-stone-700 leading-[1.75]">
                  <span className="mt-[0.72em] w-1 h-1 rounded-full bg-stone-400 shrink-0" />
                  <span className="min-w-0"><TimestampText text={sentence} onSeek={onSeek} /></span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>종합 피드백이 없습니다. 구간별 분석까지 끝난 세션에서 표시됩니다.</Empty>
          )}
        </div>
        <div className="bg-stone-100 rounded-2xl p-5 grid grid-cols-2 gap-x-4 gap-y-5">
          {statCards.map((c) => (
            <div key={c.title} className="min-w-0">
              <p className="text-[14px] text-stone-500 break-keep">{c.title}</p>
              <p className={`mt-1 text-[22px] leading-tight font-extrabold whitespace-nowrap ${c.alert ? 'text-rose-600' : 'text-stone-900'}`}>{c.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ② 구간별 지표 */}
      <Section title="구간별 지표" hint="점을 누르면 해당 구간으로 이동합니다">
        {trend.length > 0 && segments.length > 0 ? (
          <SegmentMetrics segments={segments} trend={trend} chunks={chunks} script={script} voice={voice} activeIndex={activeSegmentIndex} onSelect={goToSegment} />
        ) : (
          <Empty>구간별 지표가 없습니다. 구간 분리까지 끝난 세션에서 그래프가 표시됩니다.</Empty>
        )}
      </Section>

      {/* ③ 구간별 영상 타임라인과 스크립트 — 양쪽 머리글 높이를 같게 해서 영상과 스크립트 상자의 윗선을 맞춘다 */}
      <div id="single-video-section" className="scroll-mt-4">
        <section className="border-t border-stone-200 pt-7 mt-9">
          <div className="grid grid-cols-1 min-[1000px]:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] gap-x-8 gap-y-6 items-start">
            <div className="min-w-0">
              <h3 className="min-h-10 flex items-center mb-3 font-extrabold text-stone-900 text-lg">구간별 영상 타임라인</h3>
              <div className="relative bg-black rounded-xl overflow-hidden aspect-video">
                {videoNode}
                {playingSegment && (
                  <div className="absolute top-3 left-3 bg-black/70 text-white px-2.5 py-1 rounded-md text-[14px] font-semibold pointer-events-none">
                    {segmentName(playingSegment)}
                  </div>
                )}
              </div>
              {segments.length > 0 ? (
                <>
                  {/* 구간 길이에 비례한 타임라인 — 누르면 그 구간부터 재생 */}
                  <div className="flex gap-1 mt-2" role="group" aria-label="구간 타임라인">
                    {segments.map((seg, idx) => (
                      <button
                        key={seg.segment_id}
                        onClick={() => onSelectSegment(idx)}
                        title={`${segmentName(seg)} (${fmtTime(seg.t_start)}~${fmtTime(seg.t_end)})`}
                        aria-label={`${segmentName(seg)} 구간으로 이동`}
                        style={{ flexGrow: totalLength ? Math.max(seg.t_end - seg.t_start, 0) / totalLength : 1, flexBasis: 8 }}
                        className="py-1.5 group min-w-0"
                      >
                        <span className={`block h-1.5 rounded-full transition-colors ${idx === activeSegmentIndex ? 'bg-stone-800' : 'bg-stone-200 group-hover:bg-stone-300'}`} />
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 mt-1.5">
                    {segments.map((seg, idx) => (
                      <button
                        key={seg.segment_id}
                        onClick={() => onSelectSegment(idx)}
                        title={seg.title}
                        className={`pb-0.5 border-b-2 text-[15px] whitespace-nowrap transition-colors ${idx === activeSegmentIndex ? 'border-stone-900 text-stone-900 font-bold' : 'border-transparent text-stone-600 font-medium hover:text-stone-900'}`}
                      >
                        {segmentName(seg)} <span className="font-mono text-[14px] font-normal text-stone-500">{fmtTime(seg.t_start)}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="mt-3"><Empty>구간 분석 결과가 없습니다. 음성 분석과 구간 분리까지 끝난 세션에서 구간 타임라인이 표시됩니다.</Empty></div>
              )}
            </div>
            <div className="min-w-0">
              <div className="min-h-10 flex items-center justify-between gap-3 mb-3">
                <div className="flex bg-stone-100 rounded-lg p-1 shrink-0">
                  {[{ plain: false, label: '분석 스크립트' }, { plain: true, label: '원본 스크립트' }].map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() => setScriptPlain(opt.plain)}
                      className={`px-3 py-1 rounded-md text-[15px] font-bold whitespace-nowrap transition-colors ${scriptPlain === opt.plain ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className="min-w-0 truncate text-[14px] text-stone-500">문장을 누르면 재생</span>
              </div>
              <div className="rounded-xl border border-stone-200 p-2">
                <InteractiveScript
                  script={script}
                  videoChunks={chunks}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  onSeek={onSeek}
                  plain={scriptPlain}
                  segmentStarts={segments.map((s) => s.t_start)}
                  heightClass="h-[340px]"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ④ 구간별 AI 피드백 */}
      <Section
        title="구간별 AI 피드백"
        hint={segments.some((s) => s.feedback?.rating) && <div className="flex gap-1.5">{(['잘함', '보통', '개선필요'] as const).map((r) => <RatingBadge key={r} rating={r} />)}</div>}
      >
        {segments.length > 0 ? (
          <div className="divide-y divide-stone-200 border-b border-stone-200 -mt-4">
            {segments.map((seg, idx) => (
              <SegmentFeedbackRow key={seg.segment_id} seg={seg} no={idx + 1} open={openIds.has(seg.segment_id)} onToggle={() => toggleOpen(seg.segment_id)} onSeek={onSeek} />
            ))}
          </div>
        ) : (
          <Empty>구간별 피드백이 없습니다. 구간 분리와 구간별 분석이 끝난 세션에서 표시됩니다.</Empty>
        )}
      </Section>

      {/* 분석은 끝났지만 결과가 이상할 때를 위한 신고 링크 */}
      <p className="mt-5 text-[14px] text-stone-500 text-right">
        결과가 이상한가요? <a href={reportHref} className="font-semibold underline underline-offset-2 hover:text-stone-900">오류 신고하기</a>
      </p>
    </div>
  );
}
