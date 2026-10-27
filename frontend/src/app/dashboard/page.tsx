"use client";

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Play, Pause,
  CheckCircle, AlertCircle, TrendingUp,
  BarChart2, Mic, Activity, Award, Video,
  Folder, FolderOpen, ChevronRight, ChevronDown, ArrowLeft, Plus, Trash2, Upload, X, FileText, MessageSquare, Columns, ThumbsUp, Lightbulb, Pencil, LogOut
} from 'lucide-react';
import {
  Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart
} from 'recharts';
import InteractiveScript, { TimestampText, fmtTime, ScriptData, VideoChunk } from './InteractiveScript';
import CompareView from './CompareView';
import { PodiumLogo } from '@/components/ServiceGuide';

const videoThumbnail = "/dashboard-video-thumbnail.png";

// API 호출은 apiFetch (로그인 토큰 자동 첨부, 만료 시 자동 갱신) — frontend/src/utils/api.ts
import { API_BASE, apiFetch } from '@/utils/api';
import { clearTokens, getRefreshToken, isLoggedIn } from '@/utils/auth';

// 백엔드 응답 형태 (app/schemas/project.py, app/schemas/session.py)
interface ApiSession {
  session_id: number;
  project_id: number;
  session_no: number; // 프로젝트 안에서의 회차 번호 — 앞 회차를 지워도 안 바뀐다
  status: string;
  full_video_path: string | null;
  pdf_path: string | null;
  created_at: string;
}
interface ApiProject {
  project_id: number;
  user_id: number;
  title: string;
  created_at: string;
  sessions: ApiSession[];
}
// 휴지통 목록 항목 (GET /projects/trash) — 프로젝트 + 버린 시각
interface ApiTrashProject extends ApiProject {
  deleted_at: string;
}

// 화면에서 쓰는 폴더(주제)/세션 형태. 이름·날짜는 표시용으로 여기서 만든다.
interface TopicSession {
  id: string;
  name: string;
  date: string;
}
interface Topic {
  id: string;
  name: string;
  sessions: TopicSession[];
}

function toTopic(p: ApiProject): Topic {
  // 프로젝트 "생성" 응답(POST /projects)에는 sessions 가 없다 (목록 조회에만 들어옴) → 없으면 빈 목록.
  const sortedSessions = [...(p.sessions ?? [])].sort((a, b) => a.session_id - b.session_id);
  return {
    id: String(p.project_id),
    name: p.title,
    sessions: sortedSessions.map((s) => ({
      id: String(s.session_id),
      name: `${s.session_no}회차 연습`, // 목록 순서(idx)로 매기면 앞 회차를 지울 때 이름이 당겨진다
      date: s.created_at.slice(0, 10).replace(/-/g, '.'),
    })),
  };
}

// 구간(STEP 4)과 구간별 피드백(STEP 5) — GET /sessions/{id}/segment-feedback
interface ApiSegment {
  segment_id: number;
  label: string | null;
  title: string;
  t_start: number;
  t_end: number;
  // 아직 없으면 null. rating 은 나중에 추가돼서 예전에 분석한 구간은 null
  feedback: { rating: SegmentRating | null; strengths: string[]; improvements: string[] } | null;
}

// 구간 등급(STEP 5 GPT 판정) — 구간별 피드백 카드 오른쪽 위 스티커
type SegmentRating = '잘함' | '보통' | '개선필요';
const RATING_STYLES: Record<SegmentRating, string> = {
  '잘함': 'bg-green-100 text-green-700 border-green-200',
  '보통': 'bg-stone-100 text-stone-600 border-stone-200',
  '개선필요': 'bg-amber-100 text-amber-700 border-amber-200',
};

// 구간별 지표 — GET /sessions/{id}/segments/trend 의 points
interface TrendPoint {
  segment_id: number;
  label: string | null;
  title: string;
  filler_count: number | null;
  repetition_count: number | null;
  speaking_rate_spm: number | null;
  silence_ratio: number | null; // 0~1
}

// 구간 이름으로 보여줄 글자 — 분류 라벨(도입 등)이 있으면 그걸, 없으면 한 줄 요약 제목.
const segmentName = (seg: { label: string | null; title: string }) => seg.label || seg.title;

// "내 기록" 폴더 카드 아이콘 — 윈도우 탐색기 폴더처럼 생긴 노란 폴더 (직접 그린 SVG).
// 뒤판(탭 달린 진한 노랑) + 안에 든 흰 종이 + 앞판(밝은 노랑) 세 겹.
function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 52" className={className} aria-hidden="true">
      <path d="M4 6a4 4 0 0 1 4-4h14.5a4 4 0 0 1 2.8 1.2L30 8h26a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="#E5A323" />
      <rect x="9" y="12" width="46" height="20" rx="2" fill="#FFFFFF" />
      <path d="M4 20a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="#FFC83D" />
    </svg>
  );
}

// --- Mock Data ---
// (비교/성장 분석 화면은 아직 Mock. 단일 분석 화면은 실제 데이터로 바꿨다.)

// gesture_counts 7종(app/pipeline/step2_video_analysis.py) 중 일반/부정적 제스처로 묶는 기준.
const GENERAL_GESTURE_KEYS = ["explanatory_gesture", "pointing", "body_movement"] as const;
const NEGATIVE_GESTURE_KEYS = ["distracting_gesture", "touching_face_or_hair", "fidgeting_with_objects", "closed_posture"] as const;

interface GestureTotals {
  general: number;
  negative: number;
}

// 구간마다 일반/부정적 제스처 횟수를 센다 (그래프용).
// 동작 분석 조각(약 20초)은 "시작 시각"이 속한 구간 한 곳에만 넣는다 — 마지막 구간만 끝 시각도 포함.
// (STEP 4 집계 API 는 경계에 걸친 조각을 겹치는 구간마다 넣어서 구간별 합이 실제 총합보다 커진다.
//  여기서 직접 세면 구간별 합이 상단 카드의 총합과 정확히 같다.)
function countGesturesBySegment(segments: ApiSegment[], chunks: VideoChunk[]): GestureTotals[] {
  return segments.map((seg, i) => {
    const isLast = i === segments.length - 1;
    let general = 0;
    let negative = 0;
    for (const chunk of chunks) {
      if (chunk.t_start < seg.t_start || (chunk.t_start >= seg.t_end && !isLast)) continue;
      const counts = chunk.gesture_counts || {};
      for (const key of GENERAL_GESTURE_KEYS) general += counts[key] || 0;
      for (const key of NEGATIVE_GESTURE_KEYS) negative += counts[key] || 0;
    }
    return { general, negative };
  });
}

// GET /sessions/{id}/voice-summary 응답. 아직 없는 값은 null.
interface VoiceSummary {
  filler_count: number | null;
  repetition_count: number | null;
  silence_ratio: number | null;          // 0~1
  avg_speaking_rate_spm: number | null;  // 음절/분
}

// 값이 없으면 "-", 있으면 단위를 붙여서 문자열로.
function formatStat(value: number | null | undefined, format: (v: number) => string) {
  return value == null ? "-" : format(value);
}

// 제스처/음성 카드는 실제 데이터. (말 더듬 횟수 = 반복 횟수)
// id는 SINGLE_METRICS_CONFIG의 id와 1:1로 맞춰뒀다 — 그래프에서 고른 지표에 맞는 총량 카드를 찾을 때 씀.
function buildSummaryStats(gestureTotals: GestureTotals | null, voice: VoiceSummary | null) {
  return [
    { id: "fillerTotal", title: "필러 단어 빈도", value: formatStat(voice?.filler_count, v => `${v}회`), icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: "wpm", title: "평균 말하기 속도", value: formatStat(voice?.avg_speaking_rate_spm, v => `${Math.round(v)} 음절/분`), icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: "silenceRatio", title: "전체 무음 비율", value: formatStat(voice?.silence_ratio, v => `${Math.round(v * 100)}%`), icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: "habits", title: "말 더듬 횟수", value: formatStat(voice?.repetition_count, v => `${v}회`), icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: "generalGesture", title: "일반 제스처", value: gestureTotals ? `${gestureTotals.general}회` : "-", icon: ThumbsUp, color: "text-stone-900", bg: "bg-stone-100" },
    { id: "negativeGesture", title: "부정적 제스처", value: gestureTotals ? `${gestureTotals.negative}회` : "-", icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ];
}

// 종합 피드백 부가 설명 문단을 문장 단위로 나눈다 ("~요. ~다." → ["~요.", "~다."]).
// 마침표·물음표·느낌표 뒤에 공백이 있을 때만 자르므로 "1.5" 같은 숫자는 안 잘린다.
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

const MENUS = [
  { id: 'sessions', label: '내 기록', icon: FolderOpen },
  { id: 'single', label: '단일 분석', icon: BarChart2 },
  { id: 'compare', label: '비교 분석', icon: Columns },
];

const GROWTH_METRICS_CONFIG = [
  { id: 'fillerTotal', label: '필러 단어 빈도', unit: '회', color: '#f43f5e', type: 'line' },
  { id: 'wpm', label: '평균 말하기 속도', unit: 'WPM', color: '#3b82f6', type: 'line' },
  { id: 'silenceRatio', label: '전체 무음 비율', unit: '%', color: '#c084fc', type: 'bar' },
  { id: 'habits', label: '말 더듬 횟수', unit: '회', color: '#fb923c', type: 'bar' }
];

// 단일 분석 그래프용 — 위 성장 분석 설정과 같은 모양인데 속도 단위만 STEP 3 기준(음절/분)이다.
// 값은 구간별 지표(/segments/trend)에서 온다. 말 더듬 횟수 = 반복 횟수 (상단 카드와 같은 기준).
// 일반/부정적 제스처는 구간별 지표 API 대신 동작 분석 조각에서 직접 센다 (countGesturesBySegment 참고).
const SINGLE_METRICS_CONFIG = [
  ...GROWTH_METRICS_CONFIG.map(m => (m.id === 'wpm' ? { ...m, unit: '음절/분' } : m)),
  { id: 'generalGesture', label: '일반 제스처', unit: '회', color: '#0ea5e9', type: 'line' },
  { id: 'negativeGesture', label: '부정적 제스처', unit: '회', color: '#ef4444', type: 'line' },
];

// 백엔드 GET 요청 → JSON. 실패하면 null (화면에서 그 부분만 비어 보이게 한다).
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// 종합추이 — GET /projects/{id}/trend. 회차마다 저장된 분석 결과(단일 분석 상단 카드와 같은 기준).
interface ProjectTrendPoint {
  session_id: number;
  session_no: number;
  duration_sec: number | null;
  filler_count: number | null;
  repetition_count: number | null;
  silence_ratio: number | null;      // 0~1
  speaking_rate_spm: number | null;
  general_gesture: number | null;
  negative_gesture: number | null;
}

// lowerIsBetter: 줄어들면 좋아진 것 (초록), 늘면 나빠진 것 (빨강). null 이면 좋고 나쁨을 따지지 않는다.
const TREND_METRICS = [
  { id: 'filler', label: '필러', unit: '회', color: '#f43f5e', type: 'line', lowerIsBetter: true,
    get: (p: ProjectTrendPoint) => p.filler_count },
  { id: 'rate', label: '말하기 속도', unit: '음절/분', color: '#3b82f6', type: 'line', lowerIsBetter: null,
    get: (p: ProjectTrendPoint) => (p.speaking_rate_spm == null ? null : Math.round(p.speaking_rate_spm)) },
  { id: 'silence', label: '무음 비율', unit: '%', color: '#c084fc', type: 'bar', lowerIsBetter: true,
    get: (p: ProjectTrendPoint) => (p.silence_ratio == null ? null : Math.round(p.silence_ratio * 1000) / 10) },
  { id: 'repetition', label: '말 더듬', unit: '회', color: '#fb923c', type: 'bar', lowerIsBetter: true,
    get: (p: ProjectTrendPoint) => p.repetition_count },
  { id: 'generalGesture', label: '일반 제스처', unit: '회', color: '#0ea5e9', type: 'line', lowerIsBetter: null,
    get: (p: ProjectTrendPoint) => p.general_gesture },
  { id: 'negativeGesture', label: '부정적 제스처', unit: '회', color: '#ef4444', type: 'line', lowerIsBetter: true,
    get: (p: ProjectTrendPoint) => p.negative_gesture },
] as const;

// 회차별 종합추이 그래프 (지표 버튼 + 첫 회차 대비 변화 + 그래프). "종합추이" 메뉴와 폴더 화면 오른쪽에서 같이 쓴다.
// 새로 분석하지 않고 저장된 결과만 모은다. 분석이 안 끝난 회차는 그래프에서 비워 둔다.
function GrowthTrendChart({ projectId }: { projectId: string }) {
  const [metricId, setMetricId] = useState<string>('filler');
  const [points, setPoints] = useState<ProjectTrendPoint[] | null>(null);   // null = 불러오는 중

  useEffect(() => {
    setPoints(null);
    getJson<{ points: ProjectTrendPoint[] }>(`/projects/${projectId}/trend`).then((d) => setPoints(d?.points ?? []));
  }, [projectId]);

  const empty = (text: string) => (
    <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-stone-400 bg-stone-50 rounded-2xl border border-dashed border-stone-200">
      <TrendingUp className="w-12 h-12 mb-3 text-stone-300" />
      <p className="font-bold text-[16px]">{text}</p>
    </div>
  );
  if (points === null) return empty('불러오는 중…');
  if (points.length === 0) return empty('해당 주제에 발표 연습 기록이 없습니다.');
  if (!points.some((p) => p.filler_count != null || p.general_gesture != null)) return empty('아직 분석이 끝난 회차가 없어요.');

  const metric = TREND_METRICS.find((m) => m.id === metricId)!;
  const chartData = points.map((p) => ({ session: `${p.session_no}회차`, value: metric.get(p) }));

  // 첫 회차 대비 변화 — 값이 있는 회차 중 처음과 마지막
  const valued = points.filter((p) => metric.get(p) != null);
  let change: { text: string; tone: string } | null = null;
  if (valued.length >= 2) {
    const a = metric.get(valued[0])!, b = metric.get(valued[valued.length - 1])!;
    const diff = Math.round((b - a) * 10) / 10;
    const head = `${valued[0].session_no}회차 ${a}${metric.unit} → ${valued[valued.length - 1].session_no}회차 ${b}${metric.unit}`;
    if (diff === 0) change = { text: `${head} (변화 없음)`, tone: 'text-stone-500' };
    else {
      const better = metric.lowerIsBetter == null ? null : (diff < 0) === metric.lowerIsBetter;
      change = {
        text: `${head} (${diff > 0 ? '+' : ''}${diff}${metric.unit})`,
        tone: better == null ? 'text-stone-600' : better ? 'text-emerald-600' : 'text-rose-600',
      };
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* 지표 선택 */}
      <div className="flex flex-wrap gap-2 mb-3">
        {TREND_METRICS.map((m) => (
          <button
            key={m.id}
            onClick={() => setMetricId(m.id)}
            className={`px-3.5 py-2 rounded-xl text-[14px] font-bold transition-all border ${
              metricId === m.id
                ? 'bg-stone-800 text-white border-stone-800 shadow-md shadow-stone-300'
                : 'bg-white text-stone-500 border-stone-200 hover:bg-stone-50 hover:text-stone-800'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className={`text-sm font-semibold mb-4 min-h-[20px] ${change?.tone ?? 'text-stone-400'}`}>
        {change ? change.text : '두 번 이상 분석하면 첫 회차 대비 변화가 보여요.'}
      </p>

      <div className="flex-1 min-h-[260px] w-full pr-4">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
            <CartesianGrid key="grid" strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
            <XAxis key="xaxis" dataKey="session" axisLine={false} tickLine={false} tick={{fill: 'var(--chart-axis)', fontSize: 14, fontWeight: 600}} dy={15} />
            <YAxis
              key={`yaxis-${metric.id}`}
              axisLine={false}
              tickLine={false}
              tick={{fill: metric.color, fontSize: 13, fontWeight: 700}}
              domain={[0, 'auto']}
              allowDecimals={metric.id === 'silence'}
              dx={-10}
              unit={metric.unit === '음절/분' ? '' : metric.unit}
            />
            <Tooltip
              key={`tooltip-${metric.id}`}
              cursor={{fill: 'var(--chart-cursor)', stroke: metric.type === 'line' ? 'var(--chart-cursor-line)' : 'none', strokeWidth: 1, strokeDasharray: '4 4'}}
              contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
              formatter={(value) => [value == null ? '분석 전' : `${value}${metric.unit}`, metric.label]}
            />
            {metric.type === 'line' ? (
              <Line
                key={`line-${metric.id}`}
                type="monotone"
                dataKey="value"
                name={metric.label}
                stroke={metric.color}
                strokeWidth={4}
                connectNulls
                dot={{r: 6, fill: metric.color, strokeWidth: 3, stroke: 'var(--chart-dot-ring)'}}
                activeDot={{r: 8}}
              />
            ) : (
              <Bar
                key={`bar-${metric.id}`}
                dataKey="value"
                name={metric.label}
                fill={metric.color}
                radius={[6, 6, 0, 0]}
                barSize={40}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PresentationAnalysisDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 화면 상태(어느 메뉴 / 어느 폴더 / 어느 세션)는 변수가 아니라 **주소(URL)** 에 담는다.
  // 화면을 옮길 때마다 주소가 바뀌어 방문 기록이 쌓이므로, 브라우저 뒤로가기·새로고침이 화면과 맞게 동작한다.
  //   view    : sessions(내 기록, 기본) | single | compare | trash
  //   (종합추이는 폴더 화면 오른쪽에 있어서 메뉴를 따로 두지 않는다. 예전 ?view=growth 주소는 내 기록으로)
  //   folder  : "내 기록"에서 열어 둔 폴더(프로젝트) id. 없으면 폴더 목록(아이콘)을 보여준다.
  //   session : 선택한 세션 id
  // 예) /dashboard?view=single&folder=3&session=12
  // 촬영 화면은 /dashboard?session=12 로 돌아오는데, view 가 없고 session 만 있으면 단일 분석으로 본다.
  const openFolderId = searchParams.get('folder');
  const activeSessionId = searchParams.get('session') || '';
  const viewParam = searchParams.get('view');
  const activeMenu = (viewParam === 'growth' ? 'sessions' : viewParam) || (activeSessionId ? 'single' : 'sessions');

  // 화면 이동 — 바꿀 값만 넘기면 나머지는 지금 값을 그대로 쓴다 (null 을 넘기면 그 값을 지운다).
  // replace=true 면 방문 기록을 새로 쌓지 않고 지금 주소를 바꿔치기한다 (자동 정리용).
  const goTo = (next: { view?: string; folder?: string | null; session?: string | null }, replace = false) => {
    const view = next.view ?? activeMenu;
    const folder = next.folder === undefined ? openFolderId : next.folder;
    const session = next.session === undefined ? activeSessionId : next.session;

    const params = new URLSearchParams();
    if (view !== 'sessions' || session) params.set('view', view); // 세션이 있으면 view 를 꼭 적는다 (위 기본값 규칙 때문)
    if (folder) params.set('folder', folder);
    if (session) params.set('session', session);
    const query = params.toString();
    if (query === searchParams.toString()) return; // 같은 화면을 또 누르면 기록을 쌓지 않는다
    const url = query ? `/dashboard?${query}` : '/dashboard';
    if (replace) router.replace(url);
    else router.push(url);
  };

  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Topics & Sessions State — 실제 데이터는 Podium 백엔드(/projects)에서 불러온다.
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsLoaded, setTopicsLoaded] = useState(false); // 목록을 한 번이라도 받아왔는지 (받기 전엔 빈 목록이라 정리하면 안 됨)

  // 주소와 실제 데이터를 맞춘다 (목록을 받아온 뒤에만).
  //  - 분석 화면인데 세션만 있고 폴더가 없으면(촬영 후 돌아옴) 그 세션이 든 폴더를 채운다
  //    → 위쪽 경로의 폴더 이름이나 뒤로가기로 그 폴더에 갈 수 있다.
  //  - 주소의 폴더/세션이 이미 지워졌으면(삭제 직후, 또는 뒤로가기로 예전 주소에 옴) 내 기록 화면으로 바꾼다.
  useEffect(() => {
    if (!topicsLoaded) return;
    const folderGone = !!openFolderId && !topics.some(t => t.id === openFolderId);
    const sessionTopic = topics.find(t => t.sessions.some(s => s.id === activeSessionId));
    const sessionGone = !!activeSessionId && !sessionTopic;
    if (folderGone || sessionGone) {
      goTo({ view: 'sessions', folder: folderGone ? null : undefined, session: sessionGone ? null : undefined }, true);
    } else if (sessionTopic && !openFolderId && activeMenu !== 'sessions') {
      // 분석 화면일 때만 채운다. 내 기록 화면에서 폴더가 비어 있는 건 사용자가 폴더를 닫은 것이므로 그대로 둔다.
      goTo({ folder: sessionTopic.id }, true);
    }
  }, [topicsLoaded, topics, openFolderId, activeSessionId]);

  const fetchTopics = async () => {
    try {
      const res = await apiFetch('/projects');
      if (res.status === 401) return; // 로그인이 풀림 → apiFetch 가 이미 로그인 화면으로 보냄
      if (!res.ok) throw new Error('failed to load projects');
      const data: ApiProject[] = await res.json();
      setTopics(data.map(toTopic));
      setTopicsLoaded(true);
    } catch (err) {
      console.error(err);
      alert('프로젝트 목록을 불러오지 못했습니다. 백엔드 서버(localhost:8000)가 켜져 있는지 확인하세요.');
    }
  };

  // 휴지통 목록 — 휴지통 화면을 열 때마다 새로 불러온다.
  const [trashItems, setTrashItems] = useState<ApiTrashProject[]>([]);

  const fetchTrash = async () => {
    const data = await getJson<ApiTrashProject[]>('/projects/trash');
    setTrashItems(data ?? []);
  };

  useEffect(() => {
    if (activeMenu === 'trash') fetchTrash();
  }, [activeMenu]);

  const [isAdmin, setIsAdmin] = useState(false);
  const [adminChecked, setAdminChecked] = useState(false);

  useEffect(() => {
    // 로그인 안 한 상태로 들어오면 바로 로그인 화면으로
    if (!isLoggedIn()) {
      router.replace('/login');
      return;
    }
    fetchTopics();
    // 관리자만 보이는 것: 비교 분석 메뉴. 실패하면 일반 회원 화면 그대로.
    apiFetch('/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => setIsAdmin(Boolean(me?.is_admin)))
      .catch(() => {})
      .finally(() => setAdminChecked(true));
  }, []);

  // 비교 분석은 아직 관리자에게만 공개 — 일반 회원이 주소로 들어오면 단일 분석으로 보낸다
  useEffect(() => {
    if (adminChecked && !isAdmin && activeMenu === 'compare') goTo({ view: 'single' }, true);
  }, [adminChecked, isAdmin, activeMenu]);

  // 로그아웃: 서버에 refresh 토큰 폐기를 알리고(실패해도 무시), 저장된 토큰을 지운 뒤 첫 화면(랜딩)으로.
  const logout = async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).catch(() => {});
    }
    clearTokens();
    router.replace('/');
  };

  // 선택된 세션의 실제 데이터 — 영상 경로, 동작 분석(STEP2), 음성 요약·스크립트(STEP3), 구간·피드백(STEP4·5)
  const [sessionVideoPath, setSessionVideoPath] = useState<string | null>(null);
  const [gestureTotals, setGestureTotals] = useState<GestureTotals | null>(null);
  const [voiceSummary, setVoiceSummary] = useState<VoiceSummary | null>(null);
  const [videoChunks, setVideoChunks] = useState<VideoChunk[]>([]);
  const [script, setScript] = useState<ScriptData | null>(null);
  const [scriptPlain, setScriptPlain] = useState(false); // 스크립트 보기: false = 분석 스크립트, true = 원본 스크립트(문장만)
  const [segments, setSegments] = useState<ApiSegment[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [overallFeedback, setOverallFeedback] = useState<string | null>(null); // GET /sessions/{id}/overall-feedback — 부가 설명
  const [overallHeadline, setOverallHeadline] = useState<string | null>(null); // 같은 응답의 핵심 한 줄 (예전 세션은 null)
  // 분석이 끝까지 안 된 세션인지 (분석 중에 새로고침·창 닫기를 했거나, 중간 단계가 실패하면 앞 단계 결과만 남는다).
  // 마지막 단계인 구간 피드백·종합 피드백이 하나라도 없으면 "분석을 다시 진행해주세요" 안내를 띄운다.
  const [analysisIncomplete, setAnalysisIncomplete] = useState(false);
  const [currentTime, setCurrentTime] = useState(0); // 영상의 현재 재생 위치(초)
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // 세션을 빠르게 바꿔 누를 때 이전 세션의 늦은 응답이 화면을 덮어쓰지 않게 한다.
    let cancelled = false;

    setCurrentTime(0);
    setActiveSegmentIndex(0);
    setAnalysisIncomplete(false); // 불러오는 동안은 안내를 숨긴다 (불러온 뒤에 판단)
    if (!activeSessionId) {
      setSessionVideoPath(null);
      setGestureTotals(null);
      setVoiceSummary(null);
      setVideoChunks([]);
      setScript(null);
      setSegments([]);
      setTrend([]);
      setOverallFeedback(null);
      setOverallHeadline(null);
      return;
    }

    (async () => {
      const base = `/sessions/${activeSessionId}`;
      // 서로 상관없는 요청이라 한꺼번에 보낸다. 실패한 것은 null 로 오고, 그 부분만 비어 보인다.
      const [detail, analysis, voice, scriptData, segmentData, trendData, overallData] = await Promise.all([
        getJson<ApiSession>(base),
        getJson<{ analyses: VideoChunk[] }>(`${base}/analysis`),
        getJson<VoiceSummary>(`${base}/voice-summary`),
        getJson<ScriptData>(`${base}/script`),
        getJson<{ segments: ApiSegment[] }>(`${base}/segment-feedback`),
        getJson<{ points: TrendPoint[] }>(`${base}/segments/trend`),
        getJson<{ headline: string | null; overall_summary: string | null }>(`${base}/overall-feedback`),
      ]);
      if (cancelled) return;

      setSessionVideoPath(detail ? detail.full_video_path : null);
      setVoiceSummary(voice);
      setScript(scriptData);
      setSegments(segmentData ? segmentData.segments : []);
      setTrend(trendData ? trendData.points : []);
      setOverallFeedback(overallData ? overallData.overall_summary : null);
      setOverallHeadline(overallData ? overallData.headline : null);

      // 구간이 없거나, 피드백이 없는 구간이 있거나, 종합 피드백이 없으면 = 분석이 중간에 멈춘 세션
      const segs = segmentData ? segmentData.segments : [];
      const hasOverall = !!overallData && (overallData.headline !== null || overallData.overall_summary !== null);
      setAnalysisIncomplete(segs.length === 0 || segs.some((s) => !s.feedback) || !hasOverall);

      // 동작 분석: 제스처 합계(상단 카드)와 조각 목록(스크립트에 표시)
      setVideoChunks(analysis ? analysis.analyses : []);
      if (analysis) {
        let general = 0;
        let negative = 0;
        for (const a of analysis.analyses) {
          const counts = a.gesture_counts || {};
          for (const key of GENERAL_GESTURE_KEYS) general += counts[key] || 0;
          for (const key of NEGATIVE_GESTURE_KEYS) negative += counts[key] || 0;
        }
        setGestureTotals({ general, negative });
      } else {
        setGestureTotals(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // 영상 재생 티켓 — <video src> 는 Authorization 헤더를 못 실어서, 이 세션 영상에만 30분간 통하는
  // 티켓을 받아 주소 뒤에 붙인다 (백엔드 POST /sessions/{id}/video/ticket).
  const [videoTicket, setVideoTicket] = useState<string | null>(null);
  const ticketIssuedAt = useRef(0);
  // 티켓을 새로 받아 영상을 다시 불러올 때, 보던 위치·재생 상태를 이어가기 위해 잠시 담아둔다.
  const resumeRef = useRef<{ time: number; play: boolean } | null>(null);

  const fetchVideoTicket = async (sessionId: string): Promise<string | null> => {
    try {
      const res = await apiFetch(`/sessions/${sessionId}/video/ticket`, { method: 'POST' });
      if (!res.ok) return null;
      const data: { ticket: string } = await res.json();
      ticketIssuedAt.current = Date.now();
      return data.ticket;
    } catch {
      return null;
    }
  };

  const hasVideo = !!sessionVideoPath;
  useEffect(() => {
    let cancelled = false;
    setVideoTicket(null);
    resumeRef.current = null;
    if (!activeSessionId || !hasVideo) return;
    fetchVideoTicket(activeSessionId).then((ticket) => {
      if (!cancelled) setVideoTicket(ticket);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, hasVideo]);

  const videoSrc =
    hasVideo && videoTicket
      ? `${API_BASE}/sessions/${activeSessionId}/video?ticket=${encodeURIComponent(videoTicket)}`
      : null;

  // 티켓은 30분이면 만료된다. 오래 보다가 다른 구간으로 이동하면 새 요청이 401 로 실패해 영상이 멈추므로,
  // 그때 티켓을 새로 받아 같은 위치에서 이어서 재생한다.
  const handleVideoError = async (v: HTMLVideoElement) => {
    if (!activeSessionId) return;
    // 방금 받은 티켓인데도 실패하면 만료 문제가 아니다 — 다시 받아도 같으니 멈춘다 (무한 반복 방지).
    if (Date.now() - ticketIssuedAt.current < 10_000) return;
    const sessionId = activeSessionId;
    resumeRef.current = { time: v.currentTime, play: isPlaying };
    const ticket = await fetchVideoTicket(sessionId);
    if (ticket && sessionId === activeSessionId) setVideoTicket(ticket);
  };

  // 영상을 sec 초로 옮긴다 (play=true 면 바로 재생).
  // 영상 정보(길이 등)가 아직 안 왔으면 오는 즉시 옮긴다 — 안 그러면 이동이 무시돼 0초부터 재생된다.
  const seekVideo = (sec: number, play = true) => {
    const v = videoRef.current;
    if (!v) return;
    const go = () => {
      v.currentTime = Math.max(0, sec);
      if (play) v.play().catch(() => {});
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  };

  // 브라우저 카메라로 찍은 webm 은 파일에 길이 정보가 없어 duration 이 Infinity 로 나오고 이동이 안 될 수 있다.
  // 맨 끝으로 한 번 이동시켜 브라우저가 길이를 계산하게 한 뒤 startAt(기본 처음)으로 되돌린다.
  const fixUnknownDuration = (v: HTMLVideoElement, startAt = 0) => {
    if (Number.isFinite(v.duration)) {
      if (startAt > 0) v.currentTime = startAt;
      return;
    }
    const back = () => {
      v.removeEventListener('timeupdate', back);
      v.currentTime = startAt;
    };
    v.addEventListener('timeupdate', back);
    v.currentTime = 1e7;
  };

  // 구간 버튼/카드를 누르면 영상이 그 구간 시작으로 이동해서 재생되고, 전체 스크립트도 그 지점을 따라간다.
  // (스크립트 자체는 구간별로 나누지 않고 항상 세션 전체를 보여준다 — InteractiveScript 참고.)
  const selectSegment = (idx: number) => {
    setActiveSegmentIndex(idx);
    const seg = segments[idx];
    if (seg) seekVideo(seg.t_start);
  };

  // 영상이 지금 재생되고 있는 위치가 속한 구간 번호 (없으면 -1)
  const playingSegmentIndex = segments.findIndex(
    (s, i) => currentTime >= s.t_start && (currentTime < s.t_end || i === segments.length - 1)
  );

  // 재생이 다음 구간으로 넘어가거나 영상 재생바를 직접 옮겨서 "재생 구간 번호가 바뀔 때만" 스크립트가 따라간다.
  // (currentTime 이 바뀔 때마다 하면, 재생 중에 다른 구간 버튼을 눌러도 곧바로 되돌아가 버린다.)
  useEffect(() => {
    if (playingSegmentIndex >= 0) setActiveSegmentIndex(playingSegmentIndex);
  }, [playingSegmentIndex]);

  const playingSegment = segments[playingSegmentIndex] ?? null;     // 영상이 재생 중인 구간

  // 단일 분석 그래프 데이터 — 구간마다 한 점. x축 이름이 겹치면(같은 라벨의 구간) 한 점으로 합쳐 보이므로 번호를 붙인다.
  const gesturesBySegment = countGesturesBySegment(segments, videoChunks);
  const trendData = trend.map((p, i) => {
    const gestures = gesturesBySegment[segments.findIndex(s => s.segment_id === p.segment_id)];
    return {
      segment: `${i + 1}. ${segmentName(p)}`,
      fillerTotal: p.filler_count ?? 0,
      wpm: Math.round(p.speaking_rate_spm ?? 0),
      silenceRatio: Math.round((p.silence_ratio ?? 0) * 1000) / 10, // 0~1 → % (소수 첫째 자리)
      habits: p.repetition_count ?? 0,
      generalGesture: gestures ? gestures.general : 0,
      negativeGesture: gestures ? gestures.negative : 0,
    };
  });

  // Single Analysis State
  const [activeSingleMetric, setActiveSingleMetric] = useState('fillerTotal');

  // Modals State
  const [isTopicModalOpen, setIsTopicModalOpen] = useState(false);
  // "내 기록" 사용 방법: 폴더가 없으면 펼치고, 있으면 접어 둔다. 사용자가 직접 열고 닫으면 그 상태를 따른다.
  const [guideOpen, setGuideOpen] = useState<boolean | null>(null);
  const [newTopicName, setNewTopicName] = useState('');

  // Topic Rename State
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [editingTopicName, setEditingTopicName] = useState('');
  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);

  // 삭제 확인창 (네/아니요). onConfirm 은 "네"를 눌렀을 때 실행할 삭제 함수.
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; detail: string; onConfirm: () => void } | null>(null);
  const [targetTopicId, setTargetTopicId] = useState<string | null>(null);

  // 영상은 /record 페이지에서 실시간 촬영으로 처리. 발표자료 PDF 도 촬영 페이지에서 고른다.


  // Helper to find currently selected topic and session names
  let activeTopicId = "";
  let activeTopicName = "";
  let activeSessionName = "";
  topics.forEach(t => {
    const s = t.sessions.find(s => s.id === activeSessionId);
    if (s) {
      activeTopicId = t.id;
      activeTopicName = t.name;
      activeSessionName = s.name;
    }
  });

  const addTopic = async () => {
    if (!newTopicName.trim()) return;
    try {
      const res = await apiFetch('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTopicName }),
      });
      if (!res.ok) throw new Error('failed to create project');
      const project: ApiProject = await res.json();
      setTopics([...topics, toTopic(project)]);
      setNewTopicName('');
      setIsTopicModalOpen(false);
    } catch (err) {
      console.error(err);
      alert('폴더 추가에 실패했습니다.');
    }
  };

  const startEditingTopic = (e: React.MouseEvent, topic: Topic) => {
    e.stopPropagation();
    setEditingTopicId(topic.id);
    setEditingTopicName(topic.name);
  };

  const cancelEditingTopic = () => {
    setEditingTopicId(null);
    setEditingTopicName('');
  };

  const saveTopicName = async (id: string) => {
    const trimmed = editingTopicName.trim();
    if (!trimmed) {
      cancelEditingTopic();
      return;
    }
    try {
      const res = await apiFetch(`/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) throw new Error('failed to rename project');
      setTopics(topics.map(t => (t.id === id ? { ...t, name: trimmed } : t)));
    } catch (err) {
      console.error(err);
      alert('폴더 이름 변경에 실패했습니다.');
    } finally {
      cancelEditingTopic();
    }
  };

  const deleteTopic = async (id: string) => {
    try {
      // 백엔드는 바로 지우지 않고 "휴지통"으로 옮긴다 (DELETE /projects/{id}/purge 가 영구 삭제)
      const res = await apiFetch(`/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed to delete project');
      // 열어 둔 폴더나 보던 세션이 이 폴더 것이면, 위의 "주소와 실제 데이터 맞추기"가 내 기록 화면으로 돌려놓는다.
      setTopics(topics.filter(t => t.id !== id));
    } catch (err) {
      console.error(err);
      alert('폴더 삭제에 실패했습니다.');
    }
  };

  // 휴지통에서 꺼내기 — 성공하면 휴지통 목록에서 빼고, 폴더 목록은 서버에서 다시 받아온다.
  const restoreTopic = async (id: number) => {
    try {
      const res = await apiFetch(`/projects/${id}/restore`, { method: 'POST' });
      if (!res.ok) throw new Error('failed to restore project');
      setTrashItems(trashItems.filter(p => p.project_id !== id));
      await fetchTopics();
    } catch (err) {
      console.error(err);
      alert('폴더 복원에 실패했습니다.');
    }
  };

  // 영구 삭제 — 폴더 안의 연습, 영상, 분석 결과까지 전부 지워지고 되돌릴 수 없다.
  const purgeTopic = async (id: number) => {
    try {
      const res = await apiFetch(`/projects/${id}/purge`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed to purge project');
      setTrashItems(trashItems.filter(p => p.project_id !== id));
    } catch (err) {
      console.error(err);
      alert('영구 삭제에 실패했습니다.');
      await fetchTrash(); // 실제 상태와 목록이 어긋나지 않게 다시 불러온다
    }
  };

  // Podium은 녹화 파일 업로드가 아니라 실시간 촬영 → 분석 흐름이라, 세션 생성/영상
  // 업로드/전처리/VLM 분석은 전부 /record 페이지가 담당한다. 여기서는 그 페이지로 이동만 시킨다.
  const goToRecordPage = () => {
    if (!targetTopicId) return;
    const projectId = targetTopicId;
    closeSessionModal();
    router.push(`/record?project=${projectId}`);
  };

  // 영상 업로드하기: 같은 /record 페이지를 업로드 모드로 연다 (카메라 자리에 파일 선택 칸이 나옴).
  const goToUploadPage = () => {
    if (!targetTopicId) return;
    const projectId = targetTopicId;
    closeSessionModal();
    router.push(`/record?project=${projectId}&mode=upload`);
  };

  const deleteSession = async (sessionId: string) => {
    try {
      // 지금 재생 중인 세션이면, 삭제 요청 전에 영상 재생을 먼저 끊어서
      // 브라우저가 파일을 붙잡고 있는 상태(Windows 삭제 실패 원인)를 없앤다.
      if (activeSessionId === sessionId && videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      }
      const res = await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed to delete session');
      // 보던 세션을 지웠으면, 목록을 다시 받아온 뒤 "주소와 실제 데이터 맞추기"가 내 기록 화면으로 돌려놓는다.
      await fetchTopics();
    } catch (err) {
      console.error(err);
      alert('세션 삭제에 실패했습니다.');
      await fetchTopics(); // 실제 상태와 목록이 어긋나지 않게 다시 불러온다
    }
  };

  // 삭제 버튼을 누르면 바로 지우지 않고 확인창부터 띄운다.
  const askDeleteTopic = (e: React.MouseEvent, topic: Topic) => {
    e.stopPropagation();
    setConfirmDialog({
      message: `'${topic.name}' 폴더를 휴지통으로 옮기시겠습니까?`,
      detail: '휴지통에서 다시 복원할 수 있습니다.',
      onConfirm: () => deleteTopic(topic.id),
    });
  };

  const askPurgeTopic = (project: ApiTrashProject) => {
    setConfirmDialog({
      message: `'${project.title}' 폴더를 영구 삭제하시겠습니까?`,
      detail: `폴더 안의 연습 ${project.sessions.length}개와 촬영 영상, 분석 결과가 모두 삭제되며 되돌릴 수 없습니다.`,
      onConfirm: () => purgeTopic(project.project_id),
    });
  };

  const askDeleteSession = (e: React.MouseEvent, session: TopicSession) => {
    e.stopPropagation();
    setConfirmDialog({
      message: `'${session.name}'을 삭제하시겠습니까?`,
      detail: '촬영 영상과 분석 결과가 함께 삭제되며 되돌릴 수 없습니다.',
      onConfirm: () => deleteSession(session.id),
    });
  };

  // 확인창이 떠 있을 때 Esc 를 누르면 "아니요"와 같다.
  useEffect(() => {
    if (!confirmDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDialog]);

  const openSessionModal = (e: React.MouseEvent, topicId: string) => {
    e.stopPropagation();
    setTargetTopicId(topicId);
    setIsSessionModalOpen(true);
  };

  const closeSessionModal = () => {
    setIsSessionModalOpen(false);
    setTargetTopicId(null);
  };

  const selectSession = (sessionId: string) => {
    goTo({ view: 'single', session: sessionId }); // 세션을 고르면 단일 분석 화면으로
  };

  // 메뉴 버튼 — 왼쪽 사이드바(세로)와 모바일 상단 메뉴바(가로)가 같이 쓴다.
  const visibleMenus = MENUS.filter((m) => m.id !== 'compare' || isAdmin);

  const renderMenuButton = (menu: typeof MENUS[number], horizontal: boolean) => {
    const Icon = menu.icon;
    const isActive = activeMenu === menu.id;
    const isDisabled = !activeSessionId && menu.id !== 'sessions' && menu.id !== 'compare';

    return (
      <button
        key={menu.id}
        // "내 기록"은 어느 화면에서 누르든 폴더 목록(아이콘)으로 간다 — 열어 둔 폴더는 닫는다.
        onClick={() => !isDisabled && goTo(menu.id === 'sessions' ? { view: 'sessions', folder: null } : { view: menu.id })}
        disabled={isDisabled}
        // 가로(상단 메뉴바): 글자 15px. 아이콘·여백은 넓은 화면(1700px 이상)에서만 크게(아이콘 24px),
        // 그보다 좁으면(브라우저 100% 등) 한 줄에 다 들어가도록 작게(아이콘 20px)
        className={`flex items-center rounded-xl transition-all text-left group
          ${horizontal ? 'gap-2 px-1.5 py-1.5 md:px-3 md:py-2 min-[1700px]:gap-3 min-[1700px]:px-5 min-[1700px]:py-3 shrink-0' : 'w-full gap-3.5 px-4 py-3.5'}
          ${isActive
            ? 'bg-stone-100/80 text-stone-900 shadow-sm border border-stone-200'
            : isDisabled
              ? 'opacity-50 cursor-not-allowed text-stone-400'
              : 'text-stone-600 hover:bg-stone-50 border border-transparent'}`}
      >
        <div className={`${horizontal ? 'p-1.5 min-[1700px]:p-2' : 'p-1.5'} rounded-lg transition-colors ${isActive ? 'bg-stone-200' : isDisabled ? 'bg-stone-50' : 'bg-stone-100 group-hover:bg-stone-200'}`}>
          <Icon className={`${horizontal ? 'w-5 h-5 min-[1700px]:w-6 min-[1700px]:h-6' : 'w-4 h-4'} ${isActive ? 'text-stone-900' : 'text-stone-500'}`} />
        </div>
        <span className={`${horizontal ? 'hidden md:inline text-sm whitespace-nowrap' : 'text-[16px]'} ${isActive ? 'font-bold' : 'font-semibold'}`}>
          {menu.label}
        </span>
      </button>
    );
  };

  // 아래 breadcrumb·logo 는 왼쪽 사이드바와 모바일 상단 메뉴바가 같이 쓴다.

  // 지금 보고 있는 폴더 > 세션 표시
  const breadcrumb = (
    <div className={`flex items-center gap-3 font-medium bg-stone-100 rounded-full text-stone-600 border border-stone-200 z-10 min-w-0
      text-sm px-4 py-2`}>
      {activeTopicName && activeSessionName ? (
        <>
          {/* 폴더 이름을 누르면 "내 기록"에서 그 폴더(세션 목록 + 종합추이)를 연다 — 뒤로가기와 같은 효과 */}
          <button
            onClick={() => goTo({ view: 'sessions', folder: activeTopicId })}
            className="flex items-center gap-3 hover:text-stone-900 transition-colors min-w-0"
            title={`${activeTopicName} 폴더로 이동`}
          >
            <FolderOpen className="w-4 h-4 text-stone-400 shrink-0" />
            <span className="hover:underline truncate">{activeTopicName}</span>
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-stone-300 shrink-0" />
          <span className={`text-stone-900 font-bold bg-stone-200 rounded-md whitespace-nowrap px-2.5 py-0.5`}>{activeSessionName}</span>
        </>
      ) : (
        <span className="text-stone-400">선택된 세션이 없습니다</span>
      )}
    </div>
  );

  // 로고 — 누르면 홈 화면으로
  const logo = (
    <button
      onClick={() => router.push('/home')}
      className="flex items-center shrink-0 hover:opacity-70 transition-opacity"
    >
      {/* 홈 화면과 같은 Podium 워드마크 (ServiceGuide.tsx 의 PodiumLogo) */}
      <PodiumLogo className="h-5 md:h-7 w-auto" />
    </button>
  );

  return (
    // 글꼴은 홈 화면과 같은 Pretendard (layout.tsx 에서 불러옴)
    <div className={`flex h-screen bg-stone-50 font-['Pretendard_Variable',Pretendard,sans-serif] overflow-hidden flex-col md:flex-row`}>

      {/* 상단 메뉴바 (로고 · 메뉴 · 휴지통 · 로그아웃) — 모바일(768px 미만)에서만 사이드바 대신 쓴다.
          메뉴·휴지통·로그아웃은 아이콘만 보인다. */}
      {(
        // 넓은 화면(1700px 이상): 높이 h-24, 로고와 메뉴 사이 gap-14 / 그보다 좁으면 h-20, gap-8 / 모바일 h-16, gap-3
        <header className={`flex md:hidden h-16 md:h-20 min-[1700px]:h-24 bg-white border-b border-stone-200 shadow-sm z-20 shrink-0 items-center gap-3 md:gap-8 min-[1700px]:gap-14 px-4 md:px-12 min-[1700px]:px-20`}>
          {logo}
          <nav className="flex items-center gap-0.5 md:gap-2 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleMenus.map(menu => renderMenuButton(menu, true))}
          </nav>
          <div className="ml-auto flex items-center gap-0.5 md:gap-2 min-[1700px]:gap-3 min-w-0">
            {/* 휴지통·로그아웃: 좁은 화면에서는 아이콘만 (마우스를 올리면 이름이 뜸) */}
            <button
              onClick={() => goTo({ view: 'trash' })}
              className="flex items-center gap-2 px-2 md:px-3 py-2 min-[1700px]:px-4 min-[1700px]:py-3 rounded-xl text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors text-sm font-semibold shrink-0"
              title="휴지통"
            >
              <Trash2 className="w-5 h-5 min-[1700px]:w-6 min-[1700px]:h-6" />
              <span className="hidden min-[1700px]:inline">휴지통</span>
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-2 px-2 md:px-3 py-2 min-[1700px]:px-4 min-[1700px]:py-3 rounded-xl text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors text-sm font-semibold shrink-0"
              title="로그아웃"
            >
              <LogOut className="w-5 h-5 min-[1700px]:w-6 min-[1700px]:h-6" />
              <span className="hidden min-[1700px]:inline">로그아웃</span>
            </button>
          </div>
        </header>
      )}

      {/* Sidebar Navigation — 모든 화면(내 기록·단일 분석·비교 분석·휴지통)에서 같이 쓴다. 가로 220px */}
      <aside className="hidden md:flex w-[220px] bg-white border-r border-stone-200 flex-col flex-shrink-0 z-20 shadow-sm">
        <div className="h-20 flex items-center px-6 border-b border-stone-100 shrink-0">
          {logo}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col pb-6">
          <nav className="p-4 space-y-1.5 shrink-0 mt-2">
            {visibleMenus.map(menu => renderMenuButton(menu, false))}
          </nav>
        </div>

        {/* 휴지통 + 로그아웃 — 사이드바 맨 아래 */}
        <div className="p-4 border-t border-stone-100 shrink-0 space-y-1">
          <button
            onClick={() => goTo({ view: 'trash' })}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors text-[15px] font-semibold
              ${activeMenu === 'trash' ? 'bg-stone-100/80 text-stone-900' : 'text-stone-500 hover:bg-stone-50 hover:text-stone-700'}`}
          >
            <Trash2 className="w-4 h-4" />
            휴지통
          </button>
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors text-[15px] font-semibold"
          >
            <LogOut className="w-4 h-4" />
            로그아웃
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-stone-50 relative">

        {/* Top Header bar */}
        <header className="hidden md:flex h-20 bg-white/80 backdrop-blur-md border-b border-stone-200 items-center justify-between px-8 flex-shrink-0 z-10 sticky top-0 relative">
          <div className="absolute left-1/2 -translate-x-1/2 flex justify-center w-full max-w-[50%] pointer-events-none">
            <h2 className="text-xl font-bold text-stone-800 text-center">
              {activeMenu === 'trash' ? '휴지통' : MENUS.find(m => m.id === activeMenu)?.label}
            </h2>
          </div>
          <div></div>{/* Spacer for left side to keep justify-between working */}
          {breadcrumb}
        </header>

        {/* Scrollable Container for Content */}
        {/* 본문 양옆 여백: 화면이 넓을수록 넉넉하게, 모바일은 좁게.
            본문은 최대 1200px 로 가운데 정렬돼서, 아주 넓은 화면에서는 여백이 저절로 커진다 */}
        <div className="flex-1 overflow-y-auto py-6 md:py-8 px-4 sm:px-8 lg:px-12 min-[1700px]:px-20 custom-scrollbar">
          
          {/* VIEW 0: Session Management — 폴더 목록(아이콘) ↔ 폴더 안(세션 목록 + 종합추이) */}
          {activeMenu === 'sessions' && (() => {
            const openFolder = topics.find(t => t.id === openFolderId);

            // 1) 폴더를 열었으면: 왼쪽 세션 목록 / 오른쪽 종합추이(Mock)
            if (openFolder) {
              return (
                <div className="max-w-[1200px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {/* 경로: ← 내 기록 > 폴더명 */}
                  <div className="flex items-center gap-2 mb-6 min-w-0">
                    <button
                      onClick={() => goTo({ folder: null })}
                      className="flex items-center gap-1.5 text-stone-500 hover:text-stone-800 font-semibold text-[16px] shrink-0"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      내 기록
                    </button>
                    <ChevronRight className="w-4 h-4 text-stone-300 shrink-0" />
                    <FolderOpen className="w-5 h-5 text-stone-700 shrink-0" />
                    <h3 className="text-xl font-extrabold text-stone-800 truncate">{openFolder.name}</h3>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 items-start">
                    {/* 왼쪽: 세션 목록 */}
                    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-5 flex flex-col gap-3">
                      <h4 className="font-bold text-stone-800 text-[17px]">
                        발표 세션 목록 <span className="text-stone-400 font-semibold">({openFolder.sessions.length})</span>
                      </h4>
                      <button
                        onClick={(e) => openSessionModal(e, openFolder.id)}
                        className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl border-2 border-dashed border-stone-200 text-stone-500 hover:text-stone-900 hover:border-stone-400 hover:bg-stone-100 transition-all font-semibold text-[15px]"
                      >
                        <Plus className="w-4 h-4" />
                        발표 추가
                      </button>

                      {openFolder.sessions.length > 0 ? (
                        // 오른쪽 그래프 카드와 높이를 맞추고, 넘치면 이 안에서 스크롤한다.
                        <div className="space-y-3 max-h-[440px] overflow-y-auto custom-scrollbar pr-1">
                          {openFolder.sessions.map(session => (
                            <div
                              key={session.id}
                              onClick={() => selectSession(session.id)}
                              className={`group flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer
                                ${activeSessionId === session.id
                                  ? 'border-stone-900 bg-stone-100 shadow-sm'
                                  : 'border-stone-100 hover:border-stone-300 hover:bg-stone-50'}`}
                            >
                              <div className="flex items-center gap-3.5">
                                <div className={`p-2 rounded-lg ${activeSessionId === session.id ? 'bg-stone-200' : 'bg-stone-100 group-hover:bg-white'}`}>
                                  <Video className={`w-4 h-4 ${activeSessionId === session.id ? 'text-stone-900' : 'text-stone-400 group-hover:text-stone-700'}`} />
                                </div>
                                <div>
                                  <p className={`font-bold text-[15px] ${activeSessionId === session.id ? 'text-stone-900' : 'text-stone-700'}`}>{session.name}</p>
                                  <p className="text-[13px] text-stone-500 mt-0.5 font-medium">{session.date}</p>
                                </div>
                              </div>
                              <button
                                onClick={(e) => askDeleteSession(e, session)}
                                className="opacity-0 group-hover:opacity-100 text-stone-400 hover:text-red-500 p-2 hover:bg-red-50 rounded-lg transition-all"
                                title="연습 삭제"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="py-10 flex flex-col items-center justify-center text-stone-400 border border-dashed border-stone-200 rounded-xl bg-stone-50/50">
                          <FolderOpen className="w-8 h-8 text-stone-300 mb-2" />
                          <p className="text-[14px] font-medium">등록된 세션이 없습니다</p>
                        </div>
                      )}
                    </div>

                    {/* 오른쪽: 이 폴더의 종합추이 (회차별 저장된 분석 결과) */}
                    <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6 h-[560px] flex flex-col">
                      <div className="flex items-center gap-2.5 mb-5">
                        <span className="bg-green-100 text-green-600 p-1.5 rounded-xl"><TrendingUp className="w-5 h-5" /></span>
                        <h4 className="font-extrabold text-stone-800 text-lg">종합추이</h4>
                      </div>
                      <div className="flex-1 min-h-0">
                        <GrowthTrendChart projectId={openFolder.id} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            // 2) 폴더 목록: 컴퓨터 폴더처럼 아이콘만. 누르면 그 폴더가 열린다.
            return (
              <div className="max-w-[1200px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-center mb-6">
                  <h3 className="text-2xl font-extrabold text-stone-800">프로젝트 &amp; 발표 관리</h3>
                  <button
                    onClick={() => setIsTopicModalOpen(true)}
                    className="flex items-center justify-center gap-2 bg-stone-900 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-stone-700 shadow-sm transition-colors whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    새 주제 폴더 추가
                  </button>
                </div>

                {/* 사용 방법 — 한 박스 안에 단계 3개(구분선) + 각 단계 아래 간단한 예시. 폴더가 있으면 접혀 있다. */}
                {(() => {
                  const open = guideOpen ?? topics.length === 0;
                  return (
                <div className="bg-white border border-stone-200 rounded-2xl shadow-sm mb-10 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setGuideOpen(!open)}
                    className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-stone-50 transition-colors"
                  >
                    <span className="font-bold text-stone-800">사용 방법</span>
                    <span className="flex items-center gap-1 text-sm font-semibold text-stone-500">
                      {open ? '접기' : '펼치기'}
                      <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </span>
                  </button>
                  {open && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 border-t border-stone-200 divide-y sm:divide-y-0 sm:divide-x divide-stone-200">
                  {[
                    {
                      title: '주제 폴더 만들기',
                      desc: '발표 주제마다 폴더를 하나씩 만들어요.',
                      example: (
                        <span className="flex items-center gap-2">
                          <FolderIcon className="w-6 h-5 shrink-0" />
                          <span className="font-semibold text-stone-700">캡스톤 중간발표</span>
                        </span>
                      ),
                    },
                    {
                      title: '발표 추가하기',
                      desc: '폴더를 열고 촬영하거나 영상을 올려요.',
                      example: (
                        <span className="flex items-center gap-1.5 flex-wrap">
                          {['1회차 연습', '2회차 연습'].map((t) => (
                            <span key={t} className="flex items-center gap-1 bg-white border border-stone-200 rounded-md px-2 py-0.5 font-semibold text-stone-700">
                              <Video className="w-3.5 h-3.5 text-stone-400" />
                              {t}
                            </span>
                          ))}
                        </span>
                      ),
                    },
                    {
                      title: '피드백 보고 다시 연습',
                      desc: '구간별 피드백을 확인하고 다시 촬영해요.',
                      example: (
                        <span className="flex items-center gap-2 font-semibold text-stone-700">
                          필러 <span className="text-stone-400 line-through">12회</span>
                          <ChevronRight className="w-4 h-4 text-stone-400" />
                          <span className="text-emerald-600">5회</span>
                        </span>
                      ),
                    },
                  ].map((step, i) => (
                    <div key={step.title} className="p-5">
                      <div className="flex items-center gap-2.5">
                        <span className="w-6 h-6 rounded-full bg-stone-900 text-white text-xs font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                        <span className="font-bold text-stone-800">{step.title}</span>
                      </div>
                      <p className="mt-2 text-sm text-stone-500">{step.desc}</p>
                      <div className="mt-3 text-sm bg-stone-50 border border-stone-100 rounded-xl px-3 py-2.5">{step.example}</div>
                    </div>
                  ))}
                  </div>
                  )}
                </div>
                  );
                })()}

                {topics.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
                    {topics.map(topic => (
                      <div
                        key={topic.id}
                        onClick={() => editingTopicId !== topic.id && goTo({ folder: topic.id })}
                        // 흰 카드 없이 폴더 그림 + 이름만 (윈도우 바탕화면 폴더처럼). 마우스를 올리면 옅은 파란 배경
                        className="group relative rounded-2xl p-3 pt-6 flex flex-col items-center text-center cursor-pointer transition-colors hover:bg-stone-100"
                      >
                        {/* 이름 변경 / 삭제 — 마우스를 올리면 보인다 */}
                        <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => startEditingTopic(e, topic)}
                            className="text-stone-400 hover:text-stone-700 p-1.5 hover:bg-white rounded-lg transition-colors"
                            title="폴더 이름 변경"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => askDeleteTopic(e, topic)}
                            className="text-stone-400 hover:text-red-500 p-1.5 hover:bg-white rounded-lg transition-colors"
                            title="폴더 삭제"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* 폴더 아이콘 — 윈도우 폴더 모양 (마우스를 올리면 살짝 커짐) */}
                        <FolderIcon className="w-28 h-auto mb-2 drop-shadow-sm group-hover:scale-105 transition-transform" />
                        {editingTopicId === topic.id ? (
                          <input
                            type="text"
                            value={editingTopicName}
                            onChange={(e) => setEditingTopicName(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => saveTopicName(topic.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveTopicName(topic.id);
                              if (e.key === 'Escape') cancelEditingTopic();
                            }}
                            autoFocus
                            className="w-full font-bold text-stone-800 text-[15px] text-center border border-stone-400 rounded-lg px-2 py-0.5 outline-none focus:ring-2 focus:ring-stone-900"
                          />
                        ) : (
                          <p className="w-full font-bold text-stone-800 text-[16px] truncate" title={topic.name}>{topic.name}</p>
                        )}
                        <p className="text-[13px] text-stone-500 mt-1 font-medium">연습 {topic.sessions.length}개</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-16 flex flex-col items-center justify-center text-stone-400 border border-dashed border-stone-200 rounded-2xl bg-white">
                    <Folder className="w-10 h-10 text-stone-300 mb-3" />
                    <p className="text-[15px] font-medium">아직 폴더가 없습니다. &quot;새 주제 폴더 추가&quot;로 시작해 보세요.</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* 휴지통 — 복원 / 영구 삭제 */}
          {activeMenu === 'trash' && (
            <div className="max-w-[1200px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="mb-8">
                <h3 className="text-2xl font-extrabold text-stone-800">휴지통</h3>
                <p className="text-[16px] text-stone-500 mt-2 font-medium">삭제한 폴더는 여기에 보관됩니다. 복원하거나 영구 삭제할 수 있습니다.</p>
              </div>

              {trashItems.length > 0 ? (
                <div className="bg-white rounded-2xl shadow-sm border border-stone-200 divide-y divide-stone-100">
                  {trashItems.map(project => (
                    <div key={project.project_id} className="flex items-center justify-between p-5">
                      <div className="flex items-center gap-3 min-w-0">
                        <Folder className="w-5 h-5 text-stone-400 shrink-0" />
                        <div className="min-w-0">
                          <p className="font-bold text-stone-800 text-[16px] truncate">{project.title}</p>
                          <p className="text-[13px] text-stone-500 mt-0.5 font-medium">
                            연습 {project.sessions.length}개 · {project.deleted_at.slice(0, 10).replace(/-/g, '.')} 삭제
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => restoreTopic(project.project_id)}
                          className="px-4 py-2 text-sm font-bold text-stone-900 hover:bg-stone-100 rounded-lg transition-colors"
                        >
                          복원
                        </button>
                        <button
                          onClick={() => askPurgeTopic(project)}
                          className="px-4 py-2 text-sm font-bold text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          영구 삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-16 flex flex-col items-center justify-center text-stone-400 border border-dashed border-stone-200 rounded-2xl bg-white">
                  <Trash2 className="w-10 h-10 text-stone-300 mb-3" />
                  <p className="text-[15px] font-medium">휴지통이 비어 있습니다</p>
                </div>
              )}
            </div>
          )}

          {/* Analysis Views — 회차를 골랐을 때만 */}
          {activeMenu !== 'sessions' && activeMenu !== 'trash' && (activeSessionId || activeMenu === 'compare') ? (
            // 단일 분석은 왼쪽·오른쪽 두 칸으로 놓으므로 더 넓게 쓴다
            <div className={`max-w-[1200px] mx-auto space-y-6 pb-12`}>

              {/* VIEW 3: Single Analysis */}
              {activeMenu === 'single' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
                  {/* 분석이 중간에 멈춘 세션 안내 */}
                  {analysisIncomplete && (
                    <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-5 py-4">
                      <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-extrabold text-[16px]">분석을 다시 진행해주세요</p>
                        <p className="text-sm font-medium mt-0.5">
                          분석이 끝까지 진행되지 않았어요. 아래에는 분석된 곳까지만 보여요.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* 첫째 줄: 왼쪽 구간별 지표 분석 그래프 / 오른쪽 종합 피드백 — 한 박스 안에서 구분선으로 나눈다.
                      화면 폭이 1200px 보다 좁으면(브라우저를 크게 확대했을 때 등) 두 칸이 비좁아져 글자가 잘리므로 위아래로 쌓는다.
                      (둘째 줄 영상/스크립트도 같은 기준) */}
                  <div className="bg-white rounded-xl shadow-sm border border-stone-200 grid grid-cols-1 min-[1200px]:grid-cols-2 divide-y min-[1200px]:divide-y-0 min-[1200px]:divide-x divide-stone-200 items-stretch">
                  {/* Top: Graphs by Segment */}
                  <div className="p-6 min-w-0">
                    <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2">
                      <span className="bg-purple-100 text-purple-600 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5"/></span>
                      구간별 지표 분석 그래프
                    </h3>

                    {/* 제목 아래: 왼쪽(지표 버튼 두 줄) / 오른쪽(고른 지표의 총량 카드).
                        예전엔 카드를 absolute 로 띄웠는데, 화면이 좁으면(브라우저 100% 등) 버튼 줄이 카드 밑으로
                        들어가 가려졌다. 지금은 카드가 실제로 자리를 차지해서, 버튼은 카드 앞까지만 가고 줄바꿈된다.
                        items-stretch: 카드 높이를 왼쪽 버튼 두 줄을 합친 높이에 맞춘다.
                        1700px 보다 좁은 화면에서는 버튼 글자(13px)·간격과 카드 폭(140px)·제목(13px)을 줄이고 카드 아이콘을 숨긴다.
                        → 브라우저 100%(폭 약 1280px)에서 두 칸으로 놓여도 버튼 글자가 잘리지 않게. */}
                    <div className="flex flex-row items-stretch gap-4 min-[1700px]:gap-6 mt-6 mb-8">
                      <div className="flex-1 min-w-0">
                        {/* Metric Selection Buttons — 6개를 3개씩 딱 두 줄로 (화면 폭과 상관없이).
                            그래야 오른쪽 카드의 위·아래 끝이 첫째 줄 위·둘째 줄 아래와 맞는다 */}
                        {trendData.length > 0 && (
                          <div className="grid grid-cols-3 gap-2 min-[1700px]:gap-3">
                            {SINGLE_METRICS_CONFIG.map(metric => (
                              <button
                                key={metric.id}
                                onClick={() => setActiveSingleMetric(metric.id)}
                                className={`px-2 py-2.5 text-[14px] min-[1700px]:px-3 min-[1700px]:text-[15px] rounded-xl font-bold transition-all border whitespace-nowrap truncate ${
                                  activeSingleMetric === metric.id
                                    ? 'bg-stone-800 text-white border-stone-800 shadow-md shadow-stone-300'
                                    : 'bg-white text-stone-500 border-stone-200 hover:bg-stone-50 hover:text-stone-800'
                                }`}
                              >
                                {metric.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 지금 고른 지표(activeSingleMetric)의 총량 카드. 카드 디자인은 예전 요약 카드 그대로. */}
                      {(() => {
                        const activeStat = buildSummaryStats(gestureTotals, voiceSummary).find(s => s.id === activeSingleMetric);
                        if (!activeStat) return null;
                        const Icon = activeStat.icon;
                        return (
                          <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-4 min-[1700px]:p-5 flex flex-col justify-between w-[140px] min-[1700px]:w-[200px] shrink-0">
                            <div className="flex justify-between items-start w-full gap-2">
                              <p className="text-[14px] min-[1700px]:text-sm font-bold text-stone-500 mb-1 truncate">{activeStat.title}</p>
                              <div className={`hidden min-[1700px]:block p-2 rounded-xl shrink-0 ${activeStat.bg}`}>
                                <Icon className={`w-5 h-5 ${activeStat.color}`} />
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mt-auto">
                              <h2 className="text-2xl font-extrabold text-stone-800 whitespace-nowrap">{activeStat.value}</h2>
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {trendData.length > 0 ? (
                      <>
                        <div className="h-[300px] w-full pr-4">
                          {(() => {
                             const activeMetricConfig = SINGLE_METRICS_CONFIG.find(m => m.id === activeSingleMetric)!;
                             return (
                               <ResponsiveContainer width="100%" height="100%">
                                 <ComposedChart data={trendData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                                   <CartesianGrid key="grid-single" strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
                                   {/* scale="band": 막대그래프처럼 구간마다 같은 폭의 칸을 주고 그 칸 가운데에 점을 찍는다.
                                       (기본값은 첫·끝 점이 양쪽 끝에 붙어서 꺾은선만 간격이 넓고 끝 글자가 잘렸다.) */}
                                   <XAxis key="xaxis-single" dataKey="segment" scale="band" interval={0} axisLine={false} tickLine={false} tick={{fill: 'var(--chart-axis)', fontSize: 14, fontWeight: 600}} dy={15} />
                                   <YAxis
                                     key={`yaxis-single-${activeMetricConfig.id}`}
                                     axisLine={false} tickLine={false}
                                     tick={{fill: activeMetricConfig.color, fontSize: 13, fontWeight: 700}}
                                     domain={[0, 'auto']} allowDecimals={false} dx={-10} unit={activeMetricConfig.unit} width={activeMetricConfig.unit.length > 2 ? 110 : 50}
                                   />
                                   <Tooltip
                                     key={`tooltip-single-${activeMetricConfig.id}`}
                                     cursor={{fill: 'var(--chart-cursor)', stroke: activeMetricConfig.type === 'line' ? 'var(--chart-cursor-line)' : 'none', strokeWidth: 1, strokeDasharray: '4 4'}}
                                     contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
                                     formatter={(value) => [`${value}${activeMetricConfig.unit}`, activeMetricConfig.label] as [string, string]}
                                   />
                                   {activeMetricConfig.type === 'line' ? (
                                     <Line
                                       key={`line-single-${activeMetricConfig.id}`}
                                       type="monotone" dataKey={activeMetricConfig.id} name={activeMetricConfig.label} stroke={activeMetricConfig.color} strokeWidth={4}
                                       dot={{r: 6, fill: activeMetricConfig.color, strokeWidth: 3, stroke: 'var(--chart-dot-ring)'}} activeDot={{r: 8}}
                                     />
                                   ) : (
                                     <Bar
                                       key={`bar-single-${activeMetricConfig.id}`}
                                       dataKey={activeMetricConfig.id} name={activeMetricConfig.label} fill={activeMetricConfig.color} radius={[6, 6, 0, 0]} barSize={40}
                                     />
                                   )}
                                 </ComposedChart>
                               </ResponsiveContainer>
                             );
                          })()}
                        </div>
                      </>
                    ) : (
                      <div className="rounded-xl bg-stone-50 border border-dashed border-stone-200 py-8 px-4 text-center text-sm text-stone-400 font-medium">
                        구간별 지표가 없습니다. 구간 분리까지 끝난 세션에서 그래프가 표시됩니다.
                      </div>
                    )}
                  </div>

                  {/* Overall AI Feedback — 핵심 한 줄(크게) + 부가 설명 짧은 문단.
                      예전 세션은 headline 이 없어서 부가 설명 문단만 보인다 */}
                  <div className="p-6 min-w-0">
                    <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-stone-200 text-stone-900 p-1.5 rounded-xl"><Award className="w-5 h-5"/></span>
                      종합 피드백
                    </h3>
                    {overallFeedback ? (
                      <div>
                        {overallHeadline && (
                          <p className="text-lg font-extrabold text-stone-800 mb-3">{overallHeadline}</p>
                        )}
                        {/* 부가 설명을 문장마다 한 줄씩 목록으로 보여준다 */}
                        <ul className="space-y-2.5">
                          {splitSentences(overallFeedback).map((sentence, i) => (
                            <li key={i} className="flex gap-2.5 text-stone-600 text-[17px] font-medium leading-[1.8]">
                              <span className="mt-[0.7em] w-1.5 h-1.5 rounded-full bg-stone-400 shrink-0" />
                              <span><TimestampText text={sentence} onSeek={(sec) => seekVideo(sec)} /></span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="rounded-xl bg-stone-50 border border-dashed border-stone-200 py-8 px-4 text-center text-sm text-stone-400 font-medium">
                        종합 피드백이 없습니다. 구간별 분석까지 끝난 세션에서 표시됩니다.
                      </div>
                    )}
                  </div>
                  </div>

                  {/* 둘째 줄: 왼쪽 영상(+ 구간 버튼) / 오른쪽 발표 스크립트 */}
                  <div className="bg-white rounded-xl shadow-sm border border-stone-200 grid grid-cols-1 min-[1200px]:grid-cols-2 divide-y min-[1200px]:divide-y-0 min-[1200px]:divide-x divide-stone-200 items-stretch">
                  {/* Middle: Timeline & Video */}
                  <div className="p-6 min-w-0">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2">
                        <span className="bg-stone-200 text-stone-900 p-1.5 rounded-xl"><Video className="w-5 h-5"/></span>
                        구간별 영상 타임라인
                      </h3>
                    </div>

                    <div className="relative bg-black rounded-xl overflow-hidden h-[360px] flex group mb-4">
                      {videoSrc ? (
                        <video
                          ref={videoRef}
                          src={videoSrc}
                          controls
                          onPlay={() => setIsPlaying(true)}
                          onPause={() => setIsPlaying(false)}
                          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                          onLoadedMetadata={(e) => {
                            // 티켓을 새로 받아 다시 불러온 경우면 보던 위치에서 이어간다.
                            const v = e.currentTarget;
                            const resume = resumeRef.current;
                            resumeRef.current = null;
                            fixUnknownDuration(v, resume?.time ?? 0);
                            if (resume?.play) v.play().catch(() => {});
                          }}
                          onError={(e) => handleVideoError(e.currentTarget)}
                          className="absolute inset-0 w-full h-full object-contain bg-black"
                        />
                      ) : (
                        <>
                          <img src={videoThumbnail} alt="Presentation" className="absolute inset-0 w-full h-full object-cover opacity-80" />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <button onClick={() => setIsPlaying(!isPlaying)} className="bg-white/20 p-4 rounded-full backdrop-blur-sm hover:bg-white/30 transition">
                              {isPlaying ? <Pause className="w-8 h-8 text-white" /> : <Play className="w-8 h-8 text-white ml-1" />}
                            </button>
                          </div>
                        </>
                      )}
                      {/* Current Segment indicator */}
                      {playingSegment && (
                        <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md text-white px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10 shadow-lg pointer-events-none">
                          현재 구간: <span className="text-stone-300">{segmentName(playingSegment)}</span>
                        </div>
                      )}
                    </div>

                    {segments.length > 0 ? (
                      <>
                        {/* Timeline Buttons */}
                        {/* 구간 버튼은 모두 같은 크기 (마지막 줄이 늘어나지 않게 칸 고정) */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {segments.map((seg, idx) => (
                            <button
                              key={seg.segment_id}
                              onClick={() => selectSegment(idx)}
                              title={`${seg.title} (${fmtTime(seg.t_start)}~${fmtTime(seg.t_end)})`}
                              className={`truncate py-3 px-4 rounded-xl text-[16px] font-extrabold border transition-all ${activeSegmentIndex === idx ? 'bg-stone-800 text-white border-stone-800 shadow-md shadow-stone-300' : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100 hover:text-stone-800'}`}
                            >
                              {segmentName(seg)}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="mt-2 rounded-xl bg-stone-50 border border-dashed border-stone-200 py-8 px-4 text-center text-sm text-stone-400 font-medium">
                        구간 분석 결과가 없습니다. 음성 분석과 구간 분리까지 끝난 세션에서 구간 타임라인이 표시됩니다.
                      </div>
                    )}
                  </div>

                  {/* 발표 스크립트 (인터랙티브: 문장/표시를 누르면 영상이 그 시점으로 이동, 구간 버튼을 누르면 그 구간 시작으로 이동) */}
                  <div className="p-6 min-w-0">
                    <h3 className="font-extrabold text-stone-800 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="bg-stone-200 text-stone-900 p-1.5 rounded-xl"><FileText className="w-5 h-5"/></span>
                      {/* 분석 스크립트(필러·반복·무음·동작 표시) ↔ 원본 스크립트(문장만) 전환 */}
                      <div className="flex bg-stone-200/70 rounded-lg p-0.5">
                        {[{ plain: false, label: '분석 스크립트' }, { plain: true, label: '원본 스크립트' }].map((opt) => (
                          <button
                            key={opt.label}
                            onClick={() => setScriptPlain(opt.plain)}
                            // 글자 크기·굵기는 옆 카드 제목("구간별 영상 타임라인")과 같게 (text-lg, font-extrabold)
                            className={`px-3 py-0.5 rounded-md text-lg font-extrabold transition-colors ${
                              scriptPlain === opt.plain ? 'bg-white text-stone-800 shadow-sm' : 'text-stone-500 hover:text-stone-700'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      <span className="ml-auto text-xs font-medium text-stone-400">
                        {scriptPlain ? '문장을 누르면 그 장면부터 재생됩니다' : '문장이나 표시를 누르면 그 장면부터 재생됩니다'}
                      </span>
                    </h3>
                    <InteractiveScript
                      script={script}
                      videoChunks={videoChunks}
                      currentTime={currentTime}
                      isPlaying={isPlaying}
                      onSeek={(sec) => seekVideo(sec)}
                      plain={scriptPlain}
                      segmentStarts={segments.map((s) => s.t_start)}
                    />
                  </div>
                  </div>

                  {/* Bottom: Segment AI Feedback */}
                  <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-6">
                    <h3 className="font-extrabold text-stone-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-green-100 text-green-600 p-1.5 rounded-xl"><CheckCircle className="w-5 h-5"/></span>
                      구간별 AI 피드백
                    </h3>
                    {segments.length > 0 ? (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {segments.map((seg, idx) => (
                          <div
                            key={seg.segment_id}
                            onClick={() => selectSegment(idx)}
                            className={`p-6 rounded-2xl border transition-all cursor-pointer ${activeSegmentIndex === idx ? 'bg-stone-100/50 border-stone-400 shadow-sm ring-2 ring-stone-900/10' : 'bg-stone-50 border-stone-200 hover:bg-stone-100 hover:border-stone-300'}`}
                          >
                            {/* 맨 윗줄: 등급 스티커.
                                높이를 고정해서 스티커가 없는 카드도 아래 내용 위치가 같게 한다 */}
                            <div className="flex items-center min-h-[28px] mb-2">
                              {seg.feedback?.rating && (
                                <span className={`text-xs font-extrabold px-3 py-1 rounded-full border ${RATING_STYLES[seg.feedback.rating]}`}>{seg.feedback.rating}</span>
                              )}
                            </div>
                            {/* 구간 이름과 시간·제목을 한 묶음으로 — 카드가 좁아서 줄이 바뀌어도 둘의 시작 위치가 맞는다 */}
                            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 mb-4">
                              <h4 className="font-extrabold text-stone-800 text-[20px]">{segmentName(seg)}</h4>
                              <span className="font-extrabold text-stone-800 text-[20px]">{fmtTime(seg.t_start)}~{fmtTime(seg.t_end)} · {seg.title}</span>
                            </div>

                            {seg.feedback ? (
                              <div className="space-y-4 text-[15px]">
                                <div>
                                  <h5 className="font-extrabold text-green-800 mb-2 text-[14px] flex items-center gap-1.5">
                                    <span className="bg-green-100 text-green-700 p-1 rounded-lg"><Award className="w-3.5 h-3.5"/></span>
                                    잘한 점
                                  </h5>
                                  <ul className="space-y-2">
                                    {seg.feedback.strengths.map((item, i) => (
                                      <li key={i} className="text-stone-700 font-medium leading-relaxed flex gap-2">
                                        <span className="text-green-500 shrink-0">•</span>
                                        <span><TimestampText text={item} onSeek={(sec) => seekVideo(sec)} /></span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                                <div className="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
                                  <h5 className="font-extrabold text-amber-800 mb-2 text-[14px] flex items-center gap-1.5">
                                    <span className="bg-amber-100 text-amber-700 p-1 rounded-lg"><Lightbulb className="w-3.5 h-3.5"/></span>
                                    개선점
                                  </h5>
                                  <ul className="space-y-2">
                                    {seg.feedback.improvements.map((item, i) => (
                                      <li key={i} className="text-stone-700 font-semibold leading-relaxed flex gap-2">
                                        <span className="text-amber-500 shrink-0">•</span>
                                        <span><TimestampText text={item} onSeek={(sec) => seekVideo(sec)} /></span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            ) : (
                              <p className="text-sm text-stone-400 font-medium">이 구간의 AI 피드백이 아직 없습니다.</p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl bg-stone-50 border border-dashed border-stone-200 py-8 px-4 text-center text-sm text-stone-400 font-medium">
                        구간별 피드백이 없습니다. 구간 분리와 구간별 분석이 끝난 세션에서 표시됩니다.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* VIEW: Compare Analysis — 같은 폴더의 두 회차 비교 (CompareView.tsx) */}
              {activeMenu === 'compare' && isAdmin && (
                <CompareView
                  projects={topics.map((t) => ({ id: t.id, name: t.name }))}
                  projectId={activeTopicId || openFolderId || ''}
                  onProjectChange={(id) => goTo({ folder: id, session: null })}
                  initialSessionId={activeSessionId}
                />
              )}

            </div>
          ) : activeMenu !== 'sessions' && activeMenu !== 'trash' ? (
            <div className="h-full flex flex-col items-center justify-center text-stone-400">
              <FolderOpen className="w-16 h-16 mb-4 text-stone-300" />
              <p className="text-lg font-bold text-stone-500">선택된 발표 세션이 없습니다.</p>
              <p className="text-sm mt-2">좌측 패널 ‘발표 세션 목록’에서 프로젝트 폴더를 열고 발표 연습을 선택해주세요.</p>
            </div>
          ) : null}
        </div>
      </main>

      {/* --- MODALS --- */}

      {/* 0. Delete Confirm Modal (폴더/세션 삭제 전 네·아니요 확인) */}
      {confirmDialog && (
        <div
          className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setConfirmDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            // w-fit: 안내 문장이 두 줄로 꺾이지 않도록 확인창 폭을 글 길이에 맞춘다 (화면보다 넓어지진 않게 max-w-full)
            className="bg-white rounded-2xl shadow-xl w-fit min-w-[24rem] max-w-full overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <h3 className="font-extrabold text-stone-800 text-lg mb-2">{confirmDialog.message}</h3>
              <p className="text-sm text-stone-500 font-medium leading-relaxed">{confirmDialog.detail}</p>
            </div>
            <div className="px-6 py-4 bg-stone-50 flex justify-end gap-3">
              <button
                onClick={() => {
                  const run = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  run();
                }}
                className="px-5 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
              >
                네
              </button>
              {/* 실수로 Enter 를 눌러도 지워지지 않게, 오른쪽에 있어도 "아니요"에 먼저 포커스 */}
              <button
                autoFocus
                onClick={() => setConfirmDialog(null)}
                className="px-5 py-2 text-sm font-bold text-stone-600 hover:bg-stone-200 rounded-lg transition-colors"
              >
                아니요
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 1. Add Topic Modal */}
      {isTopicModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-stone-100 flex items-center justify-between">
              <h3 className="font-extrabold text-stone-800 text-lg">새 주제 폴더 추가</h3>
              <button onClick={() => setIsTopicModalOpen(false)} className="text-stone-400 hover:text-stone-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <label className="block text-sm font-bold text-stone-700 mb-2">폴더명 (주제)</label>
              <input 
                type="text" 
                value={newTopicName}
                onChange={e => setNewTopicName(e.target.value)}
                placeholder="예: 2026 캡스톤디자인 발표"
                className="w-full px-4 py-3 rounded-xl border border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-stone-900 transition-shadow"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 bg-stone-50 flex justify-end gap-3 rounded-b-2xl">
              <button 
                onClick={() => setIsTopicModalOpen(false)}
                className="px-4 py-2 text-sm font-bold text-stone-600 hover:bg-stone-200 rounded-lg transition-colors"
              >
                취소
              </button>
              <button 
                onClick={addTopic}
                className="px-4 py-2 text-sm font-bold text-white bg-stone-900 hover:bg-stone-700 rounded-lg transition-colors"
              >
                추가하기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Add Session Modal */}
      {isSessionModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-stone-100 flex items-center justify-between">
              <h3 className="font-extrabold text-stone-800 text-lg">새 발표 연습 회차 추가</h3>
              <button onClick={closeSessionModal} className="text-stone-400 hover:text-stone-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              {/* Go to Recording Page */}
              <div>
                <label className="block text-[15px] font-bold text-stone-700 mb-2">발표 영상 <span className="text-red-500">*</span></label>
                <button
                  type="button"
                  onClick={goToRecordPage}
                  className="w-full border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors border-stone-300 bg-stone-50 hover:bg-stone-100 hover:border-stone-400"
                >
                  <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center mb-3">
                    <Video className="w-6 h-6 text-stone-700" />
                  </div>
                  <p className="font-bold text-stone-700 text-[16px]">영상촬영하기</p>
                  <p className="text-xs text-stone-400 mt-1">클릭하면 촬영 페이지로 이동합니다.</p>
                  <p className="text-xs text-stone-400 mt-0.5 whitespace-nowrap">(발표 자료 PDF는 촬영 페이지에서 올릴 수 있어요)</p>
                </button>

                {/* 영상 업로드하기 — 촬영 페이지를 업로드 모드(?mode=upload)로 연다 */}
                <button
                  type="button"
                  onClick={goToUploadPage}
                  className="w-full mt-3 border-2 border-dashed rounded-xl p-5 flex items-center justify-center gap-3 cursor-pointer transition-colors border-stone-300 bg-stone-50 hover:bg-stone-100 hover:border-stone-400"
                >
                  <div className="w-9 h-9 rounded-full bg-white shadow-sm flex items-center justify-center shrink-0">
                    <Upload className="w-4 h-4 text-stone-500" />
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-stone-700 text-[16px]">영상 업로드하기</p>
                    <p className="text-xs text-stone-400 mt-0.5">촬영된 영상 파일을 올려서 분석합니다</p>
                  </div>
                </button>
              </div>
            </div>
            <div className="px-6 py-4 bg-stone-50 flex justify-end gap-3 rounded-b-2xl">
              <button
                onClick={closeSessionModal}
                className="px-5 py-2.5 text-[15.5px] font-bold text-stone-600 hover:bg-stone-200 rounded-xl transition-colors"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Custom Styles */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 20px; }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}

// useSearchParams 를 쓰는 화면은 Suspense 로 감싸야 운영 빌드(next build)가 통과한다.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PresentationAnalysisDashboard />
    </Suspense>
  );
}
