"use client";

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Play, Pause, TrendingUp, BarChart2, Video,
  Folder, FolderOpen, ChevronRight, ChevronDown, ArrowLeft, Plus, Trash2, Upload, X, Columns, Pencil, LogOut, ShieldCheck, UserRound
} from 'lucide-react';
import {
  Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart
} from 'recharts';
import { ScriptData, VideoChunk } from './InteractiveScript';
import CompareView from './CompareView';
import SingleView, { ApiSegment, TrendPoint, VoiceSummary } from './SingleView';
import { PodiumLogo } from '@/components/ServiceGuide';

const videoThumbnail = "/dashboard-video-thumbnail.png";

// API 호출은 apiFetch (로그인 토큰 자동 첨부, 만료 시 자동 갱신) — frontend/src/utils/api.ts
import { API_BASE, apiFetch } from '@/utils/api';
import { clearTokens, getRefreshToken, isLoggedIn } from '@/utils/auth';
import { AnalysisStep, runSteps } from '@/utils/analysis';

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

const MENUS = [
  { id: 'sessions', label: '내 기록', icon: FolderOpen },
  { id: 'single', label: '단일 분석', icon: BarChart2 },
  { id: 'compare', label: '비교 분석', icon: Columns },
];

const ANALYSIS_STEP_NAMES: Record<AnalysisStep, string> = {
  preprocess: '영상 준비', voice: '음성 분석', segments: '구간 나누기',
  motion: '동작 분석', segmentFeedback: '구간별 피드백', overall: '종합 피드백',
};

// 오류 신고 — 신고 전용 API 가 없어서 약관·개인정보 처리방침의 문의 메일로 보낸다. 세션 번호와 빠진 단계를 미리 적어 둔다.
const CONTACT_EMAIL = 'ozmii333@gmail.com';
function reportMailto(topicName: string, sessionName: string, sessionId: string, missing: AnalysisStep[]) {
  const subject = `[Podium 오류 신고] ${topicName} ${sessionName}`;
  const body = [
    `세션 번호: ${sessionId}`,
    `빠진 단계: ${missing.length ? missing.map((s) => ANALYSIS_STEP_NAMES[s]).join(', ') : '없음'}`,
    '',
    '어떤 문제가 있었는지 적어 주세요:',
    '',
  ].join('\n');
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

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
  const [sessionDuration, setSessionDuration] = useState<number | null>(null); // 발표 길이(초). GET /projects/{id}/trend 의 duration_sec (비교 화면과 같은 값)
  const [voiceSummary, setVoiceSummary] = useState<VoiceSummary | null>(null);
  const [videoChunks, setVideoChunks] = useState<VideoChunk[]>([]);
  const [script, setScript] = useState<ScriptData | null>(null);
  const [segments, setSegments] = useState<ApiSegment[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [overallFeedback, setOverallFeedback] = useState<string | null>(null); // GET /sessions/{id}/overall-feedback — 부가 설명
  const [overallHeadline, setOverallHeadline] = useState<string | null>(null); // 같은 응답의 핵심 한 줄 (예전 세션은 null)
  // 분석이 끝까지 안 된 세션이면 빠진 단계 목록 (분석 중에 새로고침·창 닫기를 했거나, 중간 단계가 실패하면 앞 단계 결과만 남는다).
  // 있으면 단일 분석 화면 맨 위에 "다시 분석하기"·"오류 신고하기" 안내를 띄운다.
  const [missingSteps, setMissingSteps] = useState<AnalysisStep[]>([]);
  const [reloadKey, setReloadKey] = useState(0);                                      // 올리면 세션 데이터를 다시 받는다
  const [retryingSessionId, setRetryingSessionId] = useState<string | null>(null);    // 다시 분석 중인 세션
  const [retryLabel, setRetryLabel] = useState('');
  const [retryDone, setRetryDone] = useState<{ sessionId: string; error: string | null } | null>(null);
  const [currentTime, setCurrentTime] = useState(0); // 영상의 현재 재생 위치(초)
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // 세션을 빠르게 바꿔 누를 때 이전 세션의 늦은 응답이 화면을 덮어쓰지 않게 한다.
    let cancelled = false;

    setCurrentTime(0);
    setActiveSegmentIndex(0);
    setMissingSteps([]); // 불러오는 동안은 안내를 숨긴다 (불러온 뒤에 판단)
    if (!activeSessionId) {
      setSessionVideoPath(null);
      setSessionDuration(null);
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

      // 빠진 단계를 찾는다. 응답 자체를 못 받은(null) 항목은 네트워크 문제일 수 있어 빠졌다고 보지 않는다.
      // 구간을 새로 나누면 동작·피드백도 다시 만들어야 하므로(기존 피드백이 함께 지워진다) 뒤 단계까지 넣는다.
      const segs = segmentData ? segmentData.segments : [];
      const noVoice = !!voice && voice.filler_count === null;
      const noSegments = !!segmentData && segs.length === 0;
      const needed: AnalysisStep[] = [];
      if (detail?.status === 'processing') needed.push('preprocess');
      if (noVoice) needed.push('voice');
      if (noVoice || noSegments) needed.push('segments', 'motion', 'segmentFeedback', 'overall');
      else {
        if (analysis && analysis.analyses.length === 0) needed.push('motion');
        if (segs.some((s) => !s.feedback)) needed.push('segmentFeedback');
        if (overallData && overallData.headline === null && overallData.overall_summary === null) needed.push('overall');
      }
      setMissingSteps(needed);

      // 동작 분석 조각 (제스처 합계·구간별 그래프·스크립트 표시에 쓴다)
      setVideoChunks(analysis ? analysis.analyses : []);

      // 발표 길이 — 세션 응답에는 없어서 폴더의 회차별 지표에서 가져온다. 못 받으면 마지막 구간 끝 시각을 쓴다.
      setSessionDuration(null);
      if (detail) {
        const projectTrend = await getJson<{ points: ProjectTrendPoint[] }>(`/projects/${detail.project_id}/trend`);
        if (cancelled) return;
        setSessionDuration(projectTrend?.points.find((p) => p.session_id === detail.session_id)?.duration_sec ?? null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, reloadKey]);

  // 빠진 단계만 다시 분석한 뒤 결과를 새로 받는다. 끝난 뒤에도 빠진 단계가 남으면 안내가 그대로 남아 신고를 권한다.
  const retrying = !!retryingSessionId && retryingSessionId === activeSessionId;
  const retryAnalysis = async () => {
    const sessionId = activeSessionId;
    setRetryingSessionId(sessionId);
    setRetryLabel('');
    setRetryDone(null);
    let error: string | null = null;
    try {
      await runSteps(sessionId, missingSteps, { onStep: setRetryLabel });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    setRetryingSessionId(null);
    setRetryDone({ sessionId, error });
    setReloadKey((k) => k + 1);
  };

  // 다시 분석하는 동안 창을 닫으려 하면 한 번 묻는다 (닫으면 남은 단계가 실행되지 않는다).
  useEffect(() => {
    if (!retryingSessionId) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [retryingSessionId]);

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

  // 상단 바 메뉴 (비교 분석은 관리자만)
  const visibleMenus = MENUS.filter((m) => m.id !== 'compare' || isAdmin);

  const renderMenuButton = (menu: typeof MENUS[number]) => {
    const Icon = menu.icon;
    const isActive = activeMenu === menu.id;
    const isDisabled = !activeSessionId && menu.id !== 'sessions' && menu.id !== 'compare';

    return (
      <button
        key={menu.id}
        // "내 기록"은 어느 화면에서 누르든 폴더 목록(아이콘)으로 간다 — 열어 둔 폴더는 닫는다.
        onClick={() => !isDisabled && goTo(menu.id === 'sessions' ? { view: 'sessions', folder: null } : { view: menu.id })}
        disabled={isDisabled}
        title={menu.label}
        className={`h-10 flex items-center gap-1.5 px-3 sm:px-4 rounded-full whitespace-nowrap text-sm font-semibold transition-colors shrink-0
          ${isActive
            ? 'bg-stone-900 text-white'
            : isDisabled
              ? 'opacity-40 cursor-not-allowed text-stone-400'
              : 'text-stone-700 hover:bg-stone-100'}`}
      >
        <Icon className="w-4 h-4" />
        <span className="hidden sm:inline">{menu.label}</span>
      </button>
    );
  };

  // 상단 바 오른쪽 버튼 (홈 화면 상단 바와 같은 모양) — 좁은 화면에서는 아이콘만
  const headerButton = 'h-10 flex items-center gap-1.5 px-3 rounded-full whitespace-nowrap text-sm font-semibold text-stone-600 hover:bg-stone-100 hover:text-stone-900 transition-colors shrink-0';

  return (
    // 글꼴은 홈 화면과 같은 Pretendard (layout.tsx 에서 불러옴)
    <div className="flex flex-col h-screen dashboard-bg font-['Pretendard_Variable',Pretendard,sans-serif] overflow-hidden">

      {/* 상단 바 — 홈 화면처럼 가운데 떠 있는 알약 모양 (로고 · 메뉴 · 휴지통 · 내 정보 · 로그아웃). 왼쪽 사이드바는 없앴다. */}
      <div className="shrink-0 z-20 px-4 pt-4">
        <header className="max-w-5xl mx-auto h-14 rounded-full bg-white/80 backdrop-blur shadow-sm flex items-center gap-2 sm:gap-4 pl-5 sm:pl-6 pr-2">
          {/* 로고 — 누르면 홈 화면으로 */}
          <button onClick={() => router.push('/home')} className="flex items-center shrink-0 hover:opacity-70 transition-opacity">
            <PodiumLogo className="h-5 sm:h-6 w-auto" />
          </button>
          <nav className="flex items-center gap-1 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleMenus.map(menu => renderMenuButton(menu))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            {isAdmin && (
              <button onClick={() => router.push('/admin')} className={headerButton} title="관리자">
                <ShieldCheck className="w-4 h-4" />
                <span className="hidden lg:inline">관리자</span>
              </button>
            )}
            <button
              onClick={() => goTo({ view: 'trash' })}
              className={`${headerButton} ${activeMenu === 'trash' ? 'bg-stone-100 text-stone-900' : ''}`}
              title="휴지통"
            >
              <Trash2 className="w-4 h-4" />
              <span className="hidden lg:inline">휴지통</span>
            </button>
            <button onClick={() => router.push('/profile')} className={headerButton} title="내 정보">
              <UserRound className="w-4 h-4" />
              <span className="hidden lg:inline">내 정보</span>
            </button>
            <button onClick={logout} className={headerButton} title="로그아웃">
              <LogOut className="w-4 h-4" />
              <span className="hidden lg:inline">로그아웃</span>
            </button>
          </div>
        </header>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 relative">

        {/* Scrollable Container for Content */}
        {/* 본문 양옆 여백: 화면이 넓을수록 넉넉하게, 모바일은 좁게. 내용 폭은 최대 1100px */}
        <div className="flex-1 overflow-y-auto pt-10 pb-8 md:pt-14 px-5 sm:px-10 lg:px-32 xl:px-48 min-[1700px]:px-72 custom-scrollbar">
          {/* VIEW 0: Session Management — 폴더 목록(아이콘) ↔ 폴더 안(세션 목록 + 종합추이) */}
          {activeMenu === 'sessions' && (() => {
            const openFolder = topics.find(t => t.id === openFolderId);

            // 1) 폴더를 열었으면: 왼쪽 세션 목록 / 오른쪽 종합추이(Mock)
            if (openFolder) {
              return (
                <div className="max-w-[1100px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
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
              <div className="max-w-[1100px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
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
            <div className="max-w-[1100px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
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
            <div className={`max-w-[1100px] mx-auto space-y-6 pb-12`}>

              {/* VIEW 3: Single Analysis (SingleView.tsx) */}
              {activeMenu === 'single' && (
                <SingleView
                  topicName={activeTopicName}
                  sessionName={activeSessionName}
                  onOpenFolder={() => goTo({ view: 'sessions', folder: activeTopicId })}
                  missingSteps={missingSteps.map((step) => ANALYSIS_STEP_NAMES[step])}
                  retrying={retrying}
                  retryLabel={retryLabel}
                  retryFailed={retryDone?.sessionId === activeSessionId}
                  retryError={retryDone?.sessionId === activeSessionId ? retryDone.error : null}
                  onRetry={retryAnalysis}
                  reportHref={reportMailto(activeTopicName, activeSessionName, activeSessionId, missingSteps)}
                  headline={overallHeadline}
                  summary={overallFeedback}
                  durationSec={sessionDuration ?? (segments.length ? segments[segments.length - 1].t_end : null)}
                  voice={voiceSummary}
                  chunks={videoChunks}
                  script={script}
                  segments={segments}
                  trend={trend}
                  activeSegmentIndex={activeSegmentIndex}
                  playingSegment={playingSegment}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  onSeek={(sec) => seekVideo(sec)}
                  onSelectSegment={selectSegment}
                  videoNode={videoSrc ? (
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
                />
              )}

              {/* VIEW: Compare Analysis — 같은 폴더의 두 회차 비교 (CompareView.tsx) */}
              {activeMenu === 'compare' && isAdmin && (
                <CompareView
                  projects={topics.map((t) => ({ id: t.id, name: t.name }))}
                  projectId={activeTopicId || openFolderId || ''}
                  onProjectChange={(id) => goTo({ folder: id, session: null })}
                  initialSessionId={activeSessionId}
                  onOpenFolder={(id) => goTo({ view: 'sessions', folder: id })}
                />
              )}

            </div>
          ) : activeMenu !== 'sessions' && activeMenu !== 'trash' ? (
            <div className="h-full flex flex-col items-center justify-center text-stone-400">
              <FolderOpen className="w-16 h-16 mb-4 text-stone-300" />
              <p className="text-lg font-bold text-stone-500">선택된 발표 세션이 없습니다.</p>
              <p className="text-sm mt-2">상단의 ‘내 기록’에서 프로젝트 폴더를 열고 발표 연습을 선택해주세요.</p>
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
