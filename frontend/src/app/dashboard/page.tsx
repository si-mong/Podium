"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Play, Pause, Volume2, Maximize,
  CheckCircle, AlertCircle, TrendingUp,
  BarChart2, Mic, Activity, Award, Check, Clock, Video,
  Folder, FolderOpen, ChevronRight, Plus, Trash2, Upload, X, FileText, MessageSquare, Columns, ThumbsUp, Lightbulb, Pencil
} from 'lucide-react';
import {
  LineChart, Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ComposedChart
} from 'recharts';
import InteractiveScript, { TimestampText, fmtTime, ScriptData, VideoChunk } from './InteractiveScript';
import { setPendingSlide } from '../slideStore';

const videoThumbnail = "/dashboard-video-thumbnail.png";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
  const sortedSessions = [...p.sessions].sort((a, b) => a.session_id - b.session_id);
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
  feedback: { strengths: string[]; improvements: string[] } | null; // 아직 없으면 null
}

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

// 구간 색 (구간 개수가 세션마다 달라서 순서대로 돌려 쓴다)
const SEGMENT_COLORS = [
  "bg-blue-500", "bg-indigo-500", "bg-purple-500", "bg-pink-500", "bg-orange-500",
  "bg-teal-500", "bg-lime-500", "bg-rose-500", "bg-cyan-500",
];

// 구간 이름으로 보여줄 글자 — 분류 라벨(도입 등)이 있으면 그걸, 없으면 한 줄 요약 제목.
const segmentName = (seg: { label: string | null; title: string }) => seg.label || seg.title;

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
    { id: "generalGesture", title: "일반 제스처", value: gestureTotals ? `${gestureTotals.general}회` : "-", icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: "negativeGesture", title: "부정적 제스처", value: gestureTotals ? `${gestureTotals.negative}회` : "-", icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ];
}

const SEGMENTS = [
  { id: "s1", name: "도입", percent: 20, color: "bg-blue-500" },
  { id: "s2", name: "문제 제기", percent: 30, color: "bg-indigo-500" },
  { id: "s3", name: "해결 방안", percent: 35, color: "bg-purple-500" },
  { id: "s4", name: "결론", percent: 15, color: "bg-pink-500" },
];

const STT_DATA = [
  { time: "00:00", text: "우선 저희팀은 조원이 3명에서 2명으로 바뀌는 과정에서 주제를 다시 정하게 되었습니다.", segment: "도입", type: "normal" },
  { time: "00:03", gesture: "설명하는 제스처", type: "gesture", gestureType: "normal", segment: "도입" },
  { time: "00:05", text: "어... 큰 틀에서 바꾸기 보다는", segment: "도입", type: "filler", highlight: "어..." },
  { time: "00:08", gesture: "몸 움직임", type: "gesture", gestureType: "normal", segment: "도입" },
  { time: "00:10", text: "기존에 ‘발표 연습’이라는 큰 틀에서 세부적인 주제를 변경하기로 하였고,", segment: "도입", type: "normal" },
  { time: "00:15", text: "(2초 무음)", segment: "도입", type: "silence", highlight: "(2초 무음)" },
  { time: "00:17", text: "지금 현재 주제 두개를 생각중에 있습니다. 그리고 오늘 발표에서는 생각중인 두개의 주제를 발표할 예정입니다.", segment: "도입", type: "normal" },
  { time: "00:20", gesture: "산만한 제스처", type: "gesture", gestureType: "negative", segment: "도입" },
  { time: "00:25", text: "먼저, 첫 번째 주제는 ‘발표 연습 분석 시스템’입니다.", segment: "문제 제기", type: "normal" },
  { time: "00:28", gesture: "가리키기", type: "gesture", gestureType: "normal", segment: "문제 제기" },
  { time: "00:30", text: "사용자가 영상을 업로드하면 촬영영상의 싱크를 맞춰주고 슬라이드를 구분하는 과정을 거치게 됩니다.", segment: "문제 제기", type: "normal" },
  { time: "00:36", gesture: "얼굴이나 머리 만지기", type: "gesture", gestureType: "negative", segment: "문제 제기" },
  { time: "00:40", text: "음... 그리고 저희가 원래는 영상을 분석을 스피치전문가에게 맡긴다는 가정을 했었는데,", segment: "문제 제기", type: "filler", highlight: "음..." },
  { time: "00:45", gesture: "닫힌 자세 (팔짱 등)", type: "gesture", gestureType: "normal", segment: "문제 제기" },
  { time: "00:48", text: "이번주제에서는 발표연습분석을 VLM모델을 이용해서 분석하기로 생각을 하고 있습니다.", segment: "문제 제기", type: "normal" },
  { time: "00:55", text: "따라서 크게 저희팀은 [데이터 전처리]→[데이터 분석]→[데이터 후처리]중 데이터분석을 VLM모델에 맡기고 전처리와 후처리 모듈을 개발하기로 하였습니다.", segment: "문제 제기", type: "normal" },
  { time: "01:05", gesture: "물건 만지작거리기", type: "gesture", gestureType: "negative", segment: "문제 제기" },
  { time: "01:10", text: "저희 시스템의 프로세스에 대해 설명드리겠습니다.", segment: "해결 방안", type: "normal" },
  { time: "01:13", text: "(3초 무음)", segment: "해결 방안", type: "silence", highlight: "(3초 무음)" },
  { time: "01:15", gesture: "설명하는 제스처", type: "gesture", gestureType: "normal", segment: "해결 방안" },
  { time: "01:16", text: "먼저, 핸드폰이나 노트북으로 촬영된 영상을 시스템에 업로드를 하면 STT기술을 이용해 텍스트 대본을 뽑아냅니다.", segment: "해결 방안", type: "normal" },
  { time: "01:25", text: "그리고 [데이터분석]부분인데 저희는 적합한 VLM모델은 무엇인지에 대해 테스트해보았습니다. 크게 QWEN, GEMINI를 이용하였습니다.", segment: "해결 방안", type: "normal" },
  { time: "01:34", gesture: "산만한 제스처", type: "gesture", gestureType: "negative", segment: "해결 방안" },
  { time: "01:38", text: "그... 다양한 영상길이와 다양한 명령프롬포트로 테스트해봤고,", segment: "해결 방안", type: "filler", highlight: "그..." },
  { time: "01:45", text: "이밖에도 같은 명령어를 여러번 명령프롬포트에 입력했을 때 같은 결과가 나오는지와 VLM모델에서 계산한 제스쳐횟수와 저희가 실제로 영상을 보면서 세본 제스쳐 횟수를 비교하는 등 여러가지로 VLM모델을 테스트하였습니다.", segment: "해결 방안", type: "normal" },
  { time: "02:00", gesture: "몸 움직임", type: "gesture", gestureType: "normal", segment: "결론" },
  { time: "02:05", text: "찾아본바에 따르면 VLM에 영상을 통째로 넣어 분석을 하게 되면 2초~3초 샘플링 프레임으로 분석을 하는 VLM특성상 제스쳐인식이 잘 안될 수도 있다고 해서", segment: "결론", type: "normal" },
  { time: "02:18", gesture: "얼굴이나 머리 만지기", type: "gesture", gestureType: "negative", segment: "결론" },
  { time: "02:20", text: "저희가 실제 발표연습 예시 영상들을 찍어서 VLM모델에 넣어본 결과 30초 이하 영상을 넣었을 때 제스처 인식이 안되는거 없이 정확도가 제일 높았습니다.", segment: "결론", type: "normal" },
  { time: "02:35", text: "그리하여 예를 들어 5분짜리 영상이라고 하면 30초 단위로 영상을 나누어 VLM 모델에 전송할 계획입니다.", segment: "결론", type: "normal" },
  { time: "02:42", gesture: "가리키기", type: "gesture", gestureType: "normal", segment: "결론" },
  { time: "02:45", text: "그래서 ‘발표자의 시선과 제스쳐를 횟수를 세주고 .JSON형식으로 출력해줘’라는 명령과 함께 VLM명령프롬포트에 전달하게 됩니다.", segment: "결론", type: "normal" },
  { time: "03:00", text: "VLM 결과 후처리 하기 위해 JSON 형태로 결과값을 받을 생각입니다.", segment: "결론", type: "normal" }
];

const COMPARE_FEEDBACK = {
  strengths: [
    "1회차에 비해 2회차에서 무음 비율이 12%에서 8%로 감소하여 훨씬 매끄러운 진행을 보여주었습니다.",
    "발화 습관(어..., 음... 등)이 전반적으로 감소하여 전달력이 크게 향상되었습니다."
  ],
  improvements: [
    "2회차에서 말하기 속도가 145 WPM으로 다소 빨라진 구간이 있습니다. 중요한 부분에서는 여유를 가지고 강조하는 연습이 필요합니다.",
    "여전히 스크립트를 참고할 때 시선이 아래로 향하는 경향이 있으니, 스크린이나 청중을 더 자주 보는 연습을 추천합니다."
  ]
};

const MENUS = [
  { id: 'sessions', label: '내 기록(발표 세션 목록)', icon: FolderOpen },
  { id: 'single', label: '단일 분석', icon: BarChart2 },
  { id: 'compare', label: '비교 분석', icon: Columns },
  { id: 'growth', label: '종합추이', icon: TrendingUp },
];

const COMPARE_METRICS = [
  { id: 'filler', title: '필러 단어 빈도', s1: '25회', s2: '15회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
  { id: 'wpm', title: '평균 말하기 속도', s1: '115 WPM', s2: '126 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
  { id: 'silence', title: '전체 무음 비율', s1: '12%', s2: '8%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
  { id: 'habits', title: '말 더듬 횟수', s1: '24회', s2: '16회', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
  { id: 'pos_gesture', title: '긍정적 제스처', s1: '8회', s2: '12회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
  { id: 'neg_gesture', title: '부정적 제스처', s1: '15회', s2: '5회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
];

const COMPARE_SEGMENT_METRICS = [
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '8회', s2: '5회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '110 WPM', s2: '120 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '15%', s2: '12%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '말 더듬 횟수', s1: '6회', s2: '2회', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '1회', s2: '3회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '5회', s2: '1회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ],
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '5회', s2: '2회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '130 WPM', s2: '145 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '8%', s2: '5%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '말 더듬 횟수', s1: '4회', s2: '1회', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '2회', s2: '4회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '4회', s2: '2회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ],
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '10회', s2: '8회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '120 WPM', s2: '135 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '18%', s2: '15%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '말 더듬 횟수', s1: '10회', s2: '4회', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '3회', s2: '2회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '4회', s2: '1회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ],
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '2회', s2: '0회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '100 WPM', s2: '110 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '6%', s2: '4%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '말 더듬 횟수', s1: '4회', s2: '0회', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '2회', s2: '3회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '2회', s2: '1회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ]
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
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    console.error(err);
    return null;
  }
}

export default function PresentationAnalysisDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeMenu, setActiveMenu] = useState('sessions');
  const [activeSttIndex, setActiveSttIndex] = useState(1);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Topics & Sessions State — 실제 데이터는 Podium 백엔드(/projects)에서 불러온다.
  const [topics, setTopics] = useState<Topic[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');

  const fetchTopics = async () => {
    try {
      const res = await fetch(`${API_BASE}/projects`);
      if (!res.ok) throw new Error('failed to load projects');
      const data: ApiProject[] = await res.json();
      setTopics(data.map(toTopic));
    } catch (err) {
      console.error(err);
      alert('프로젝트 목록을 불러오지 못했습니다. 백엔드 서버(localhost:8000)가 켜져 있는지 확인하세요.');
    }
  };

  useEffect(() => {
    fetchTopics();
  }, []);

  // /record 페이지에서 촬영+분석 끝내고 돌아올 때 ?session=<id>로 넘어옴 -> 바로 단일 분석 화면 표시.
  useEffect(() => {
    const sessionParam = searchParams.get('session');
    if (sessionParam) {
      setActiveSessionId(sessionParam);
      setActiveMenu('single');
    }
  }, [searchParams]);

  // 선택된 세션의 실제 데이터 — 영상 경로, 동작 분석(STEP2), 음성 요약·스크립트(STEP3), 구간·피드백(STEP4·5)
  const [sessionVideoPath, setSessionVideoPath] = useState<string | null>(null);
  const [gestureTotals, setGestureTotals] = useState<GestureTotals | null>(null);
  const [voiceSummary, setVoiceSummary] = useState<VoiceSummary | null>(null);
  const [videoChunks, setVideoChunks] = useState<VideoChunk[]>([]);
  const [script, setScript] = useState<ScriptData | null>(null);
  const [segments, setSegments] = useState<ApiSegment[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [overallFeedback, setOverallFeedback] = useState<string | null>(null); // GET /sessions/{id}/overall-feedback
  const [currentTime, setCurrentTime] = useState(0); // 영상의 현재 재생 위치(초)
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // 세션을 빠르게 바꿔 누를 때 이전 세션의 늦은 응답이 화면을 덮어쓰지 않게 한다.
    let cancelled = false;

    setCurrentTime(0);
    setActiveSegmentIndex(0);
    if (!activeSessionId) {
      setSessionVideoPath(null);
      setGestureTotals(null);
      setVoiceSummary(null);
      setVideoChunks([]);
      setScript(null);
      setSegments([]);
      setTrend([]);
      setOverallFeedback(null);
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
        getJson<{ overall_summary: string | null }>(`${base}/overall-feedback`),
      ]);
      if (cancelled) return;

      setSessionVideoPath(detail ? detail.full_video_path : null);
      setVoiceSummary(voice);
      setScript(scriptData);
      setSegments(segmentData ? segmentData.segments : []);
      setTrend(trendData ? trendData.points : []);
      setOverallFeedback(overallData ? overallData.overall_summary : null);

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

  // 파일 이름은 DB 경로의 마지막 부분을 쓴다 (촬영본은 full_video.webm, 업로드본은 full_video.mp4 등).
  // Windows 에서 저장된 경로는 "12\full_video.webm" 처럼 역슬래시라서 / 와 \ 둘 다로 자른다.
  const videoFileName = sessionVideoPath ? sessionVideoPath.split(/[\\/]/).pop() : null;
  const videoSrc = videoFileName ? `${API_BASE}/media/${activeSessionId}/${videoFileName}` : null;

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
  // 맨 끝으로 한 번 이동시켜 브라우저가 길이를 계산하게 한 뒤 처음으로 되돌린다.
  const fixUnknownDuration = (v: HTMLVideoElement) => {
    if (Number.isFinite(v.duration)) return;
    const back = () => {
      v.removeEventListener('timeupdate', back);
      v.currentTime = 0;
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

  // Growth Chart State
  const [selectedGrowthTopicId, setSelectedGrowthTopicId] = useState('t1');
  const [activeGrowthMetric, setActiveGrowthMetric] = useState('fillerTotal');

  // Single Analysis State
  const [activeSingleMetric, setActiveSingleMetric] = useState('fillerTotal');

  // Compare Analysis State
  const [isPlayingCompare1, setIsPlayingCompare1] = useState(false);
  const [isPlayingCompare2, setIsPlayingCompare2] = useState(false);
  const [activeCompareStt1, setActiveCompareStt1] = useState(0);
  const [activeCompareStt2, setActiveCompareStt2] = useState(0);
  const [activeCompareSegmentIndex, setActiveCompareSegmentIndex] = useState(0);

  // Modals State
  const [isTopicModalOpen, setIsTopicModalOpen] = useState(false);
  const [newTopicName, setNewTopicName] = useState('');

  // Topic Rename State
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [editingTopicName, setEditingTopicName] = useState('');
  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);

  // 삭제 확인창 (네/아니요). onConfirm 은 "네"를 눌렀을 때 실행할 삭제 함수.
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; detail: string; onConfirm: () => void } | null>(null);
  const [targetTopicId, setTargetTopicId] = useState<string | null>(null);

  // PDF는 아직 대응 API가 없어 Mock 유지. 영상은 /record 페이지에서 실시간 촬영으로 처리.
  // 발표자료 PDF. "영상촬영하기"를 누르면 slideStore 에 담아 촬영 페이지로 넘긴다 (서버엔 저장 안 함).
  const [uploadedPdf, setUploadedPdf] = useState<File | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);


  // Helper to find currently selected topic and session names
  let activeTopicName = "";
  let activeSessionName = "";
  topics.forEach(t => {
    const s = t.sessions.find(s => s.id === activeSessionId);
    if (s) {
      activeTopicName = t.name;
      activeSessionName = s.name;
    }
  });

  const addTopic = async () => {
    if (!newTopicName.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/projects`, {
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
      const res = await fetch(`${API_BASE}/projects/${id}`, {
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
      const res = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed to delete project');
      setTopics(topics.filter(t => t.id !== id));
      if (activeTopicName === topics.find(t => t.id === id)?.name) {
        setActiveSessionId(''); // Reset active session if its topic is deleted
      }
    } catch (err) {
      console.error(err);
      alert('폴더 삭제에 실패했습니다.');
    }
  };

  // Podium은 녹화 파일 업로드가 아니라 실시간 촬영 → 분석 흐름이라, 세션 생성/영상
  // 업로드/전처리/VLM 분석은 전부 /record 페이지가 담당한다. 여기서는 그 페이지로 이동만 시킨다.
  const goToRecordPage = () => {
    if (!targetTopicId) return;
    const projectId = targetTopicId;
    setPendingSlide(uploadedPdf); // PDF 를 골랐으면 촬영 화면에 슬라이드로 띄운다 (closeSessionModal 이 지우기 전에 담기)
    closeSessionModal();
    router.push(`/record?project=${projectId}`);
  };

  // 영상 업로드하기: 같은 /record 페이지를 업로드 모드로 연다 (카메라 자리에 파일 선택 칸이 나옴).
  const goToUploadPage = () => {
    if (!targetTopicId) return;
    const projectId = targetTopicId;
    setPendingSlide(null); // 업로드 모드는 슬라이드를 안 띄운다
    closeSessionModal();
    router.push(`/record?project=${projectId}&mode=upload`);
  };

  const deleteSession = async (sessionId: string) => {
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('failed to delete session');
      await fetchTopics();
      if (activeSessionId === sessionId) {
        setActiveSessionId('');
        if (activeMenu !== 'sessions') setActiveMenu('sessions');
      }
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
      message: `'${topic.name}' 폴더를 삭제하시겠습니까?`,
      detail: `폴더 안의 연습 ${topic.sessions.length}개와 촬영 영상, 분석 결과가 모두 삭제되며 되돌릴 수 없습니다.`,
      onConfirm: () => deleteTopic(topic.id),
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
    setUploadedPdf(null);
    setPdfError(null);
  };

  const selectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setActiveMenu('single'); // Switch to single view when a session is selected
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans overflow-hidden">
      
      {/* Sidebar Navigation */}
      <aside className="w-[280px] bg-white border-r border-slate-200 flex flex-col flex-shrink-0 z-20 shadow-sm">
        <div className="h-20 flex items-center px-6 border-b border-slate-100 shrink-0">
          {/* 로그인/회원가입 미구현 상태라 임시로 여기서 /login 으로 보낸다. 인증 붙이면 보호 라우트로 교체 예정. */}
          <button
            onClick={() => router.push('/login')}
            className="flex items-center gap-2.5 group"
          >
            <div className="bg-blue-600 p-2 rounded-xl shadow-sm shadow-blue-200 group-hover:bg-blue-700 transition-colors">
              <BarChart2 className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-800 tracking-tight group-hover:text-blue-700 transition-colors">발표 영상 분석</h1>
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col pb-6">
          <nav className="p-4 space-y-1.5 shrink-0 mt-2">
            {MENUS.map(menu => {
              const Icon = menu.icon;
              const isActive = activeMenu === menu.id;
              const isDisabled = !activeSessionId && menu.id !== 'sessions';

              return (
                <button
                  key={menu.id}
                  onClick={() => !isDisabled && setActiveMenu(menu.id)}
                  disabled={isDisabled}
                  className={`w-full flex items-center gap-3.5 px-4 py-3.5 rounded-xl transition-all text-left group
                    ${isActive 
                      ? 'bg-blue-50/80 text-blue-700 shadow-sm border border-blue-100' 
                      : isDisabled 
                        ? 'opacity-50 cursor-not-allowed text-slate-400' 
                        : 'text-slate-600 hover:bg-slate-50 border border-transparent'}`}
                >
                  <div className={`p-1.5 rounded-lg transition-colors ${isActive ? 'bg-blue-100' : isDisabled ? 'bg-slate-50' : 'bg-slate-100 group-hover:bg-slate-200'}`}>
                    <Icon className={`w-4 h-4 ${isActive ? 'text-blue-600' : 'text-slate-500'}`} />
                  </div>
                  <span className={`text-[15px] ${isActive ? 'font-bold' : 'font-semibold'}`}>
                    {menu.label}
                  </span>
                </button>
              )
            })}
          </nav>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50 relative">
        
        {/* Top Header bar */}
        <header className="h-20 bg-white/80 backdrop-blur-md border-b border-slate-200 flex items-center justify-between px-8 flex-shrink-0 z-10 sticky top-0 relative">
          <div className="absolute left-1/2 -translate-x-1/2 flex justify-center w-full max-w-[50%] pointer-events-none">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              {MENUS.find(m => m.id === activeMenu)?.label}
            </h2>
          </div>
          <div></div>{/* Spacer for left side to keep justify-between working */}
          <div className="flex items-center gap-3 text-sm font-medium bg-slate-100 px-4 py-2 rounded-full text-slate-600 border border-slate-200 z-10">
            {activeTopicName && activeSessionName ? (
              <>
                <FolderOpen className="w-4 h-4 text-slate-400" />
                <span>{activeTopicName}</span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                <span className="text-blue-600 font-bold bg-blue-100 px-2.5 py-0.5 rounded-md">{activeSessionName}</span>
              </>
            ) : (
              <span className="text-slate-400">선택된 세션이 없습니다</span>
            )}
          </div>
        </header>

        {/* Scrollable Container for Content */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          
          {/* VIEW 0: Session Management */}
          {activeMenu === 'sessions' && (
            <div className="max-w-[1200px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex justify-between items-end mb-8">
                <div>
                  <h3 className="text-2xl font-extrabold text-slate-800">프로젝트 및 세션 관리</h3>
                  <p className="text-[15px] text-slate-500 mt-2 font-medium">주제별 폴더를 생성하고 발표 연습을 촬영하세요.</p>
                  <p className="text-[15px] text-slate-500 mt-1 font-medium">1. 새 주제 폴더 추가하기 · 2. 발표 추가하기</p>
                </div>
                <button 
                  onClick={() => setIsTopicModalOpen(true)}
                  className="flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  새 주제 폴더 추가
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {topics.map(topic => (
                  <div key={topic.id} className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full">
                    {/* Folder Header */}
                    <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 rounded-t-2xl shrink-0">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <Folder className="w-5 h-5 text-blue-500 shrink-0" />
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
                            className="font-bold text-slate-800 text-[16px] border border-blue-300 rounded-lg px-2 py-0.5 min-w-0 flex-1 outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        ) : (
                          <h3 className="font-bold text-slate-800 text-[16px] truncate">{topic.name}</h3>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(e) => startEditingTopic(e, topic)}
                          className="text-slate-400 hover:text-blue-500 p-1.5 hover:bg-blue-50 rounded-lg transition-colors"
                          title="폴더 이름 변경"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => askDeleteTopic(e, topic)}
                          className="text-slate-400 hover:text-red-500 p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                          title="폴더 삭제"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Sessions List */}
                    <div className="p-5 flex-1 flex flex-col gap-3">
                      {/* Add Session Button inside folder */}
                      <button
                        onClick={(e) => openSessionModal(e, topic.id)}
                        className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all font-semibold text-[14px]"
                      >
                        <Plus className="w-4 h-4" />
                        발표 추가
                      </button>

                      {topic.sessions.length > 0 ? (
                        // 세션이 5개(한 줄 75px + 간격 12px)까지만 보이고, 그 이상은 이 안에서 스크롤한다.
                        <div className={`space-y-3 max-h-[423px] overflow-y-auto custom-scrollbar ${topic.sessions.length > 5 ? 'pr-2' : ''}`}>
                          {topic.sessions.map(session => (
                            <div 
                              key={session.id}
                              onClick={() => selectSession(session.id)}
                              className={`group flex items-center justify-between p-4 rounded-xl border transition-all cursor-pointer
                                ${activeSessionId === session.id 
                                  ? 'border-blue-500 bg-blue-50 shadow-sm' 
                                  : 'border-slate-100 hover:border-blue-200 hover:bg-slate-50'}`}
                            >
                              <div className="flex items-center gap-3.5">
                                <div className={`p-2 rounded-lg ${activeSessionId === session.id ? 'bg-blue-100' : 'bg-slate-100 group-hover:bg-white'}`}>
                                  <Video className={`w-4 h-4 ${activeSessionId === session.id ? 'text-blue-600' : 'text-slate-400 group-hover:text-blue-500'}`} />
                                </div>
                                <div>
                                  <p className={`font-bold text-[14px] ${activeSessionId === session.id ? 'text-blue-700' : 'text-slate-700'}`}>{session.name}</p>
                                  <p className="text-[12px] text-slate-500 mt-0.5 font-medium">{session.date}</p>
                                </div>
                              </div>
                              <button 
                                onClick={(e) => askDeleteSession(e, session)} 
                                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 p-2 hover:bg-red-50 rounded-lg transition-all"
                                title="연습 삭제"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="py-6 flex flex-col items-center justify-center text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 mb-auto">
                          <FolderOpen className="w-8 h-8 text-slate-300 mb-2" />
                          <p className="text-[13px] font-medium">등록된 세션이 없습니다</p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Analysis Views (Only show if a session is selected and we are not in 'sessions' tab) */}
          {activeMenu !== 'sessions' && activeSessionId ? (
            <div className="max-w-[1200px] mx-auto space-y-6 pb-12">
              
              {/* VIEW 3: Single Analysis */}
              {activeMenu === 'single' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
                  {/* Top: Graphs by Segment */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 relative">
                    <div className="mb-6">
                      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                        <span className="bg-purple-100 text-purple-600 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5"/></span>
                        구간별 지표 분석 그래프
                      </h3>
                    </div>

                    {/* 예전엔 이 위에 요약 카드 6개가 항상 다 보였는데, 지금 고른 지표(activeSingleMetric)의
                        총량 하나만 그래프 우상단에 보여주는 걸로 바꿨다. 카드 자체 디자인은 통합 전 것 그대로 재사용.
                        lg 이상에서는 absolute로 띄워서 제목-버튼 간격(원래 간격)이 벌어지지 않게 했다. */}
                    {(() => {
                      const activeStat = buildSummaryStats(gestureTotals, voiceSummary).find(s => s.id === activeSingleMetric);
                      if (!activeStat) return null;
                      const Icon = activeStat.icon;
                      return (
                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between h-[110px] w-full lg:w-[260px] mb-6 lg:mb-0 lg:absolute lg:top-6 lg:right-6">
                          <div className="flex justify-between items-start w-full gap-2">
                            <p className="text-sm font-bold text-slate-500 mb-1 truncate">{activeStat.title}</p>
                            <div className={`p-2 rounded-xl shrink-0 ${activeStat.bg}`}>
                              <Icon className={`w-5 h-5 ${activeStat.color}`} />
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mt-auto">
                            <h2 className="text-2xl font-extrabold text-slate-800 whitespace-nowrap">{activeStat.value}</h2>
                          </div>
                        </div>
                      );
                    })()}

                    {trendData.length > 0 ? (
                      <>
                        {/* Metric Selection Buttons */}
                        <div className="flex flex-wrap gap-3 mb-8">
                          {SINGLE_METRICS_CONFIG.map(metric => (
                            <button
                              key={metric.id}
                              onClick={() => setActiveSingleMetric(metric.id)}
                              className={`px-5 py-2.5 rounded-xl text-[14px] font-bold transition-all border ${
                                activeSingleMetric === metric.id
                                  ? 'bg-slate-800 text-white border-slate-800 shadow-md shadow-slate-300'
                                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-800'
                              }`}
                            >
                              {metric.label}
                            </button>
                          ))}
                        </div>

                        <div className="h-[300px] w-full pr-4">
                          {(() => {
                             const activeMetricConfig = SINGLE_METRICS_CONFIG.find(m => m.id === activeSingleMetric)!;
                             return (
                               <ResponsiveContainer width="100%" height="100%">
                                 <ComposedChart data={trendData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                                   <CartesianGrid key="grid-single" strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                                   {/* scale="band": 막대그래프처럼 구간마다 같은 폭의 칸을 주고 그 칸 가운데에 점을 찍는다.
                                       (기본값은 첫·끝 점이 양쪽 끝에 붙어서 꺾은선만 간격이 넓고 끝 글자가 잘렸다.) */}
                                   <XAxis key="xaxis-single" dataKey="segment" scale="band" interval={0} axisLine={false} tickLine={false} tick={{fill: '#64748B', fontSize: 14, fontWeight: 600}} dy={15} />
                                   <YAxis
                                     key={`yaxis-single-${activeMetricConfig.id}`}
                                     axisLine={false} tickLine={false}
                                     tick={{fill: activeMetricConfig.color, fontSize: 13, fontWeight: 700}}
                                     domain={[0, 'auto']} allowDecimals={false} dx={-10} unit={activeMetricConfig.unit} width={activeMetricConfig.unit.length > 2 ? 110 : 50}
                                   />
                                   <Tooltip
                                     key={`tooltip-single-${activeMetricConfig.id}`}
                                     cursor={{fill: '#f8fafc', stroke: activeMetricConfig.type === 'line' ? '#e2e8f0' : 'none', strokeWidth: 1, strokeDasharray: '4 4'}}
                                     contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
                                     formatter={(value) => [`${value}${activeMetricConfig.unit}`, activeMetricConfig.label] as [string, string]}
                                   />
                                   {activeMetricConfig.type === 'line' ? (
                                     <Line
                                       key={`line-single-${activeMetricConfig.id}`}
                                       type="monotone" dataKey={activeMetricConfig.id} name={activeMetricConfig.label} stroke={activeMetricConfig.color} strokeWidth={4}
                                       dot={{r: 6, fill: activeMetricConfig.color, strokeWidth: 3, stroke: '#fff'}} activeDot={{r: 8}}
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
                      <div className="rounded-xl bg-slate-50 border border-dashed border-slate-200 py-8 px-4 text-center text-sm text-slate-400 font-medium">
                        구간별 지표가 없습니다. 구간 분리까지 끝난 세션에서 그래프가 표시됩니다.
                      </div>
                    )}
                  </div>

                  {/* Middle: Timeline & Video */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                        <span className="bg-blue-100 text-blue-600 p-1.5 rounded-xl"><Video className="w-5 h-5"/></span>
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
                          onLoadedMetadata={(e) => fixUnknownDuration(e.currentTarget)}
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
                          현재 구간: <span className="text-blue-300">{segmentName(playingSegment)}</span>
                        </div>
                      )}
                    </div>

                    {segments.length > 0 ? (
                      <>
                        {/* Timeline Buttons */}
                        <div className="flex flex-wrap items-center gap-2">
                          {segments.map((seg, idx) => (
                            <button
                              key={seg.segment_id}
                              onClick={() => selectSegment(idx)}
                              title={`${seg.title} (${fmtTime(seg.t_start)}~${fmtTime(seg.t_end)})`}
                              className={`flex-1 min-w-[110px] py-3 px-4 rounded-xl text-[15px] font-extrabold border transition-all ${activeSegmentIndex === idx ? 'bg-slate-800 text-white border-slate-800 shadow-md shadow-slate-300' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800'}`}
                            >
                              <div className="flex items-center justify-center gap-2.5">
                                <div className={`w-3 h-3 rounded-full shadow-sm shrink-0 ${SEGMENT_COLORS[idx % SEGMENT_COLORS.length]}`}></div>
                                {segmentName(seg)}
                              </div>
                            </button>
                          ))}
                        </div>

                        {/* 총 스크립트 (인터랙티브: 문장/표시를 누르면 영상이 그 시점으로 이동, 구간 버튼을 누르면 그 구간 시작으로 이동) */}
                        <div className="mt-5 bg-slate-50 rounded-xl p-5 border border-slate-100">
                          <h4 className="font-extrabold text-slate-800 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
                            <FileText className="w-4 h-4 text-blue-500" />
                            총 스크립트
                            <span className="ml-auto text-xs font-medium text-slate-400">문장이나 표시를 누르면 그 장면부터 재생됩니다</span>
                          </h4>
                          <InteractiveScript
                            script={script}
                            videoChunks={videoChunks}
                            currentTime={currentTime}
                            isPlaying={isPlaying}
                            onSeek={(sec) => seekVideo(sec)}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="mt-2 rounded-xl bg-slate-50 border border-dashed border-slate-200 py-8 px-4 text-center text-sm text-slate-400 font-medium">
                        구간 분석 결과가 없습니다. 음성 분석과 구간 분리까지 끝난 세션에서 구간 타임라인과 스크립트가 표시됩니다.
                      </div>
                    )}
                  </div>

                  {/* Bottom: Segment AI Feedback */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-green-100 text-green-600 p-1.5 rounded-xl"><CheckCircle className="w-5 h-5"/></span>
                      구간별 AI 피드백
                    </h3>
                    {segments.length > 0 ? (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {segments.map((seg, idx) => (
                          <div
                            key={seg.segment_id}
                            onClick={() => selectSegment(idx)}
                            className={`p-6 rounded-2xl border transition-all cursor-pointer ${activeSegmentIndex === idx ? 'bg-blue-50/50 border-blue-300 shadow-sm ring-2 ring-blue-500/20' : 'bg-slate-50 border-slate-200 hover:bg-slate-100 hover:border-slate-300'}`}
                          >
                            <div className="flex items-start gap-2 mb-4">
                              <div className={`w-3.5 h-3.5 mt-1.5 rounded-full shadow-sm shrink-0 ${SEGMENT_COLORS[idx % SEGMENT_COLORS.length]}`}></div>
                              {/* 구간 이름과 시간·제목을 한 묶음으로 — 카드가 좁아서 줄이 바뀌어도 둘의 시작 위치가 맞는다 */}
                              <div className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                                <h4 className="font-extrabold text-slate-800 text-[16px]">{segmentName(seg)}</h4>
                                <span className="font-extrabold text-slate-800 text-[16px]">{fmtTime(seg.t_start)}~{fmtTime(seg.t_end)} · {seg.title}</span>
                              </div>
                              {activeSegmentIndex === idx && <span className="shrink-0 text-xs font-bold text-blue-600 bg-blue-100 px-2.5 py-1 rounded-md">현재 선택됨</span>}
                            </div>

                            {seg.feedback ? (
                              <div className="space-y-4 text-[14px]">
                                <div>
                                  <h5 className="font-extrabold text-green-800 mb-2 text-[13px] flex items-center gap-1.5">
                                    <span className="bg-green-100 text-green-700 p-1 rounded-lg"><Award className="w-3.5 h-3.5"/></span>
                                    잘한 점
                                  </h5>
                                  <ul className="space-y-2">
                                    {seg.feedback.strengths.map((item, i) => (
                                      <li key={i} className="text-slate-700 font-medium leading-relaxed flex gap-2">
                                        <span className="text-green-500 shrink-0">•</span>
                                        <span><TimestampText text={item} onSeek={(sec) => seekVideo(sec)} /></span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                                  <h5 className="font-extrabold text-amber-800 mb-2 text-[13px] flex items-center gap-1.5">
                                    <span className="bg-amber-100 text-amber-700 p-1 rounded-lg"><Lightbulb className="w-3.5 h-3.5"/></span>
                                    개선점
                                  </h5>
                                  <ul className="space-y-2">
                                    {seg.feedback.improvements.map((item, i) => (
                                      <li key={i} className="text-slate-700 font-semibold leading-relaxed flex gap-2">
                                        <span className="text-amber-500 shrink-0">•</span>
                                        <span><TimestampText text={item} onSeek={(sec) => seekVideo(sec)} /></span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            ) : (
                              <p className="text-sm text-slate-400 font-medium">이 구간의 AI 피드백이 아직 없습니다.</p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl bg-slate-50 border border-dashed border-slate-200 py-8 px-4 text-center text-sm text-slate-400 font-medium">
                        구간별 피드백이 없습니다. 구간 분리와 구간별 분석이 끝난 세션에서 표시됩니다.
                      </div>
                    )}
                  </div>

                  {/* Bottom: Overall AI Feedback — 구간별 피드백 아래, 발표 전체를 한 문단(4~5줄)으로 요약 */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-blue-100 text-blue-600 p-1.5 rounded-xl"><Award className="w-5 h-5"/></span>
                      종합 피드백
                    </h3>
                    {overallFeedback ? (
                      <p className="text-slate-700 font-medium leading-relaxed">
                        <TimestampText text={overallFeedback} onSeek={(sec) => seekVideo(sec)} />
                      </p>
                    ) : (
                      <div className="rounded-xl bg-slate-50 border border-dashed border-slate-200 py-8 px-4 text-center text-sm text-slate-400 font-medium">
                        종합 피드백이 없습니다. 구간별 분석까지 끝난 세션에서 표시됩니다.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* VIEW: Compare Analysis */}
              {activeMenu === 'compare' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">
                  
                  {/* Top: Videos side by side */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Session 1 Video */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs">기준</span>
                          1회차 연습
                        </h3>
                      </div>
                      <div className="relative bg-black h-[260px] flex group">
                        <img src={videoThumbnail} alt="Session 1" className="absolute inset-0 w-full h-full object-cover opacity-60 grayscale" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <button onClick={() => setIsPlayingCompare1(!isPlayingCompare1)} className="bg-white/20 p-4 rounded-full backdrop-blur-sm hover:bg-white/30 transition">
                            {isPlayingCompare1 ? <Pause className="w-8 h-8 text-white" /> : <Play className="w-8 h-8 text-white ml-1" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Session 2 Video */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <span className="bg-blue-100 text-blue-600 px-2 py-0.5 rounded text-xs">비교</span>
                          2회차 연습
                        </h3>
                      </div>
                      <div className="relative bg-black h-[260px] flex group">
                        <img src={videoThumbnail} alt="Session 2" className="absolute inset-0 w-full h-full object-cover opacity-90" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <button onClick={() => setIsPlayingCompare2(!isPlayingCompare2)} className="bg-white/20 p-4 rounded-full backdrop-blur-sm hover:bg-white/30 transition">
                            {isPlayingCompare2 ? <Pause className="w-8 h-8 text-white" /> : <Play className="w-8 h-8 text-white ml-1" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Segment Buttons between Video and Script */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                    <h3 className="font-extrabold text-slate-800 text-sm mb-3 flex items-center gap-2">
                      <Video className="w-4 h-4 text-blue-500"/>
                      비교할 구간을 선택하세요
                    </h3>
                    <div className="flex items-center gap-2">
                      {SEGMENTS.map((seg, idx) => (
                        <button 
                          key={`compare-seg-${seg.id}`}
                          onClick={() => setActiveCompareSegmentIndex(idx)}
                          className={`flex-1 py-3 px-4 rounded-xl text-[15px] font-extrabold border transition-all ${activeCompareSegmentIndex === idx ? 'bg-slate-800 text-white border-slate-800 shadow-md shadow-slate-300' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800'}`}
                        >
                          <div className="flex items-center justify-center gap-2.5">
                            <div className={`w-3 h-3 rounded-full shadow-sm ${seg.color}`}></div>
                            {seg.name}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Scripts side by side */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Session 1 Column */}
                    <div className="flex flex-col gap-4">
                      <div className="bg-slate-50 rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col p-4 h-[280px]">
                        <h4 className="font-extrabold text-slate-800 mb-3 flex items-center gap-2 text-[14px]">
                          <FileText className="w-4 h-4 text-slate-500" />
                          1회차 스크립트 ({SEGMENTS[activeCompareSegmentIndex].name})
                        </h4>
                        <div className="space-y-3 overflow-y-auto custom-scrollbar pr-2">
                          {STT_DATA.filter(item => item.segment === SEGMENTS[activeCompareSegmentIndex].name).map((item, i) => (
                            <div key={`s1-stt-${i}`} className="flex gap-3 text-[13px]">
                              <span className="text-slate-400 font-bold shrink-0 w-10 mt-1">{item.time}</span>
                              <div className="text-slate-700 leading-relaxed font-medium flex-1">
                                {item.type === 'normal' && item.text}
                                
                                {item.type === 'gesture' && (
                                  <button className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-bold border shadow-sm transition-all hover:-translate-y-0.5 ${item.gestureType === 'normal' ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100' : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'}`}>
                                    {item.gestureType === 'normal' ? <ThumbsUp className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                                    {item.gestureType === 'negative' ? '부정적 제스처' : '제스처'}: {item.gesture}
                                  </button>
                                )}
  
                                {item.type === 'filler' && (
                                  <>
                                    {item.text.split(item.highlight!).map((part, idx, arr) => (
                                      <React.Fragment key={`filler-${idx}`}>
                                        {part}
                                        {idx < arr.length - 1 && (
                                          <button className="bg-orange-100 text-orange-700 px-2 py-1 rounded-lg text-xs font-bold border border-orange-200 mx-1 shadow-sm transition-all hover:-translate-y-0.5 inline-flex items-center gap-1">
                                            <MessageSquare className="w-3 h-3" />
                                            발화습관: {item.highlight}
                                          </button>
                                        )}
                                      </React.Fragment>
                                    ))}
                                  </>
                                )}
                                
                                {item.type === 'silence' && (
                                  <button className="bg-slate-200 text-slate-600 px-2 py-1 rounded-lg text-xs font-bold border border-slate-300 inline-flex items-center gap-1.5 shadow-sm transition-all hover:-translate-y-0.5">
                                    <Clock className="w-3 h-3" />
                                    발화습관: {item.highlight}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Session 1 Segment Metrics */}
                      <div className="grid grid-cols-3 gap-3">
                        {COMPARE_SEGMENT_METRICS[activeCompareSegmentIndex].map(m => {
                          const Icon = m.icon;
                          return (
                            <div key={`s1-m-${m.id}`} className="bg-white rounded-xl border border-slate-200 p-3 flex flex-col items-center text-center shadow-sm">
                              <Icon className={`w-4 h-4 mb-1.5 text-slate-500`} />
                              <span className="text-[11px] font-bold text-slate-500 mb-1">{m.title}</span>
                              <span className="text-[15px] font-extrabold text-slate-800">{m.s1}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Session 2 Column */}
                    <div className="flex flex-col gap-4">
                      <div className="bg-blue-50/30 rounded-xl shadow-sm border border-blue-100 overflow-hidden flex flex-col p-4 h-[280px]">
                        <h4 className="font-extrabold text-blue-800 mb-3 flex items-center gap-2 text-[14px]">
                          <FileText className="w-4 h-4 text-blue-500" />
                          2회차 스크립트 ({SEGMENTS[activeCompareSegmentIndex].name})
                        </h4>
                        <div className="space-y-3 overflow-y-auto custom-scrollbar pr-2">
                          {STT_DATA.filter(item => item.segment === SEGMENTS[activeCompareSegmentIndex].name).map((item, i) => (
                            <div key={`s2-stt-${i}`} className="flex gap-3 text-[13px]">
                              <span className="text-slate-400 font-bold shrink-0 w-10 mt-1">{item.time}</span>
                              <div className="text-slate-700 leading-relaxed font-medium flex-1">
                                {item.type === 'normal' && item.text}
                                
                                {item.type === 'gesture' && (
                                  <button className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-bold border shadow-sm transition-all hover:-translate-y-0.5 ${item.gestureType === 'normal' ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100' : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'}`}>
                                    {item.gestureType === 'normal' ? <ThumbsUp className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                                    {item.gestureType === 'negative' ? '부정적 제스처' : '제스처'}: {item.gesture}
                                  </button>
                                )}
  
                                {item.type === 'filler' && (
                                  <>
                                    {item.text.split(item.highlight!).map((part, idx, arr) => (
                                      <React.Fragment key={`filler-${idx}`}>
                                        {part}
                                        {idx < arr.length - 1 && (
                                          <button className="bg-orange-100 text-orange-700 px-2 py-1 rounded-lg text-xs font-bold border border-orange-200 mx-1 shadow-sm transition-all hover:-translate-y-0.5 inline-flex items-center gap-1">
                                            <MessageSquare className="w-3 h-3" />
                                            발화습관: {item.highlight}
                                          </button>
                                        )}
                                      </React.Fragment>
                                    ))}
                                  </>
                                )}
                                
                                {item.type === 'silence' && (
                                  <button className="bg-slate-200 text-slate-600 px-2 py-1 rounded-lg text-xs font-bold border border-slate-300 inline-flex items-center gap-1.5 shadow-sm transition-all hover:-translate-y-0.5">
                                    <Clock className="w-3 h-3" />
                                    발화습관: {item.highlight}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Session 2 Segment Metrics */}
                      <div className="grid grid-cols-3 gap-3">
                        {COMPARE_SEGMENT_METRICS[activeCompareSegmentIndex].map(m => {
                          const Icon = m.icon;
                          return (
                            <div key={`s2-m-${m.id}`} className="bg-white rounded-xl border border-blue-100 p-3 flex flex-col items-center text-center shadow-sm">
                              <Icon className={`w-4 h-4 mb-1.5 text-blue-500`} />
                              <span className="text-[11px] font-bold text-blue-600 mb-1">{m.title}</span>
                              <span className="text-[15px] font-extrabold text-blue-900">{m.s2}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Middle: Metrics Comparison */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                        <span className="bg-indigo-100 text-indigo-600 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5"/></span>
                        총 지표 비교
                      </h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {COMPARE_METRICS.map(m => {
                        const Icon = m.icon;
                        return (
                          <div key={m.id} className="bg-slate-50 rounded-xl border border-slate-200 p-4">
                            <div className="flex items-center gap-2 mb-4">
                              <div className={`p-1.5 rounded-lg ${m.bg}`}>
                                <Icon className={`w-4 h-4 ${m.color}`} />
                              </div>
                              <span className="font-bold text-slate-600 text-sm">{m.title}</span>
                            </div>
                            <div className="flex justify-between items-end">
                              <div className="flex flex-col">
                                <span className="text-xs font-bold text-slate-500 mb-1">1회차</span>
                                <span className="text-lg font-extrabold text-slate-500">{m.s1}</span>
                              </div>
                              <ChevronRight className="w-5 h-5 text-slate-300 mb-1" />
                              <div className="flex flex-col items-end">
                                <span className="text-xs font-bold text-blue-600 mb-1">2회차</span>
                                <span className="text-2xl font-extrabold text-slate-800">{m.s2}</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Bottom: AI Feedback Comparison */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-teal-100 text-teal-600 p-1.5 rounded-xl"><Lightbulb className="w-5 h-5"/></span>
                      AI 비교 피드백
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-blue-50/50 rounded-xl p-5 border border-blue-100">
                        <h4 className="font-bold text-blue-800 flex items-center gap-2 mb-4">
                          <ThumbsUp className="w-5 h-5 text-blue-600" />
                          잘한 점
                        </h4>
                        <ul className="space-y-3">
                          {COMPARE_FEEDBACK.strengths.map((text, idx) => (
                            <li key={idx} className="flex items-start gap-2.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 shrink-0"></div>
                              <p className="text-slate-700 text-sm leading-relaxed font-medium">{text}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="bg-orange-50/50 rounded-xl p-5 border border-orange-100">
                        <h4 className="font-bold text-orange-800 flex items-center gap-2 mb-4">
                          <AlertCircle className="w-5 h-5 text-orange-600" />
                          개선할 점
                        </h4>
                        <ul className="space-y-3">
                          {COMPARE_FEEDBACK.improvements.map((text, idx) => (
                            <li key={idx} className="flex items-start gap-2.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-2 shrink-0"></div>
                              <p className="text-slate-700 text-sm leading-relaxed font-medium">{text}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {/* VIEW 4: Growth Trend */}
              {activeMenu === 'growth' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 h-[650px] flex flex-col">
                    <div className="mb-6 border-b border-slate-100 pb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <h3 className="font-extrabold text-slate-800 text-xl flex items-center gap-2.5">
                          <span className="bg-green-100 text-green-600 p-1.5 rounded-xl shadow-sm"><TrendingUp className="w-5 h-5"/></span>
                          회차별 성장 추이
                        </h3>
                        <p className="text-[15px] text-slate-500 mt-2 font-medium">선택된 주제 내 발표 연습 회차들의 주요 4가지 지표 변화를 확인합니다.</p>
                      </div>
                      
                      <div className="flex items-center gap-3 shrink-0">
                        <label className="text-sm font-bold text-slate-600">주제 선택:</label>
                        <select 
                          value={selectedGrowthTopicId}
                          onChange={(e) => setSelectedGrowthTopicId(e.target.value)}
                          className="bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-2.5 font-bold outline-none cursor-pointer"
                        >
                          {topics.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Metric Selection Buttons */}
                    <div className="flex flex-wrap gap-3 mb-8">
                       {GROWTH_METRICS_CONFIG.map(metric => (
                         <button
                           key={metric.id}
                           onClick={() => setActiveGrowthMetric(metric.id)}
                           className={`px-5 py-2.5 rounded-xl text-[14px] font-bold transition-all border ${
                             activeGrowthMetric === metric.id
                               ? 'bg-slate-800 text-white border-slate-800 shadow-md shadow-slate-300'
                               : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-800'
                           }`}
                         >
                           {metric.label}
                         </button>
                       ))}
                    </div>
                    
                    <div className="flex-1 min-h-[300px] w-full pr-4">
                      {(() => {
                        const activeTopicForGrowth = topics.find(t => t.id === selectedGrowthTopicId) || topics[0];
                        if (!activeTopicForGrowth || activeTopicForGrowth.sessions.length === 0) {
                          return (
                            <div className="h-full flex flex-col items-center justify-center text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                              <TrendingUp className="w-12 h-12 mb-3 text-slate-300" />
                              <p className="font-bold text-[15px]">해당 주제에 발표 연습 기록이 없습니다.</p>
                            </div>
                          );
                        }
                        
                        // Generate mock metrics dynamically based on actual sessions in the topic
                        const growthChartData = activeTopicForGrowth.sessions.map((s, index) => {
                          const maxImprovementFactor = Math.max(1, 4 - index);
                          return {
                            session: s.name.replace(' 연습', ''), // Simplify name
                            fillerTotal: 10 + maxImprovementFactor * 5, // 필러 단어 빈도
                            wpm: 120 + maxImprovementFactor * 10,        // 평균 말하기 속도
                            silenceRatio: 5 + maxImprovementFactor * 2,  // 전체 무음 비율 (%)
                            habits: 4 + maxImprovementFactor * 3,        // 말 더듬 횟수
                          };
                        });

                        const activeMetricConfig = GROWTH_METRICS_CONFIG.find(m => m.id === activeGrowthMetric)!;

                        return (
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={growthChartData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                              <CartesianGrid key="grid" strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                              <XAxis key="xaxis" dataKey="session" axisLine={false} tickLine={false} tick={{fill: '#64748B', fontSize: 14, fontWeight: 600}} dy={15} />
                              
                              <YAxis 
                                key={`yaxis-${activeMetricConfig.id}`}
                                axisLine={false} 
                                tickLine={false} 
                                tick={{fill: activeMetricConfig.color, fontSize: 13, fontWeight: 700}} 
                                domain={['auto', 'auto']} 
                                dx={-10}
                                unit={activeMetricConfig.unit}
                              />
                              
                              <Tooltip 
                                key={`tooltip-${activeMetricConfig.id}`}
                                cursor={{fill: '#f8fafc', stroke: activeMetricConfig.type === 'line' ? '#e2e8f0' : 'none', strokeWidth: 1, strokeDasharray: '4 4'}}
                                contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
                                formatter={(value: number) => [`${value}${activeMetricConfig.unit}`, activeMetricConfig.label]}
                              />
                              
                              {activeMetricConfig.type === 'line' ? (
                                <Line 
                                  key={`line-${activeMetricConfig.id}`}
                                  type="monotone" 
                                  dataKey={activeMetricConfig.id} 
                                  name={activeMetricConfig.label} 
                                  stroke={activeMetricConfig.color} 
                                  strokeWidth={4} 
                                  dot={{r: 6, fill: activeMetricConfig.color, strokeWidth: 3, stroke: '#fff'}} 
                                  activeDot={{r: 8}} 
                                />
                              ) : (
                                <Bar 
                                  key={`bar-${activeMetricConfig.id}`}
                                  dataKey={activeMetricConfig.id} 
                                  name={activeMetricConfig.label} 
                                  fill={activeMetricConfig.color} 
                                  radius={[6, 6, 0, 0]} 
                                  barSize={40} 
                                />
                              )}
                            </ComposedChart>
                          </ResponsiveContainer>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}

            </div>
          ) : activeMenu !== 'sessions' ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400">
              <FolderOpen className="w-16 h-16 mb-4 text-slate-300" />
              <p className="text-lg font-bold text-slate-500">선택된 발표 세션이 없습니다.</p>
              <p className="text-sm mt-2">좌측 패널 '발표 세션 목록'에서 프로젝트 폴더를 열고 발표 연습을 선택해주세요.</p>
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
              <h3 className="font-extrabold text-slate-800 text-lg mb-2">{confirmDialog.message}</h3>
              <p className="text-sm text-slate-500 font-medium leading-relaxed">{confirmDialog.detail}</p>
            </div>
            <div className="px-6 py-4 bg-slate-50 flex justify-end gap-3">
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
                className="px-5 py-2 text-sm font-bold text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
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
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-extrabold text-slate-800 text-lg">새 주제 폴더 추가</h3>
              <button onClick={() => setIsTopicModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6">
              <label className="block text-sm font-bold text-slate-700 mb-2">폴더명 (주제)</label>
              <input 
                type="text" 
                value={newTopicName}
                onChange={e => setNewTopicName(e.target.value)}
                placeholder="예: 2026 캡스톤디자인 발표"
                className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-shadow"
                autoFocus
              />
            </div>
            <div className="px-6 py-4 bg-slate-50 flex justify-end gap-3 rounded-b-2xl">
              <button 
                onClick={() => setIsTopicModalOpen(false)}
                className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
              >
                취소
              </button>
              <button 
                onClick={addTopic}
                className="px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
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
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-extrabold text-slate-800 text-lg">새 발표 연습 회차 추가</h3>
              <button onClick={closeSessionModal} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-[14px] text-slate-500 font-medium">
                영상촬영 시작 전에 발표자료 PDF 파일을 올려주세요. (PPT는 PDF로 저장해서 올려주세요)
              </p>

              {/* Go to Recording Page */}
              <div>
                <label className="block text-[14px] font-bold text-slate-700 mb-2">발표 영상 <span className="text-red-500">*</span></label>
                <button
                  type="button"
                  onClick={goToRecordPage}
                  className="w-full border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors border-slate-300 bg-slate-50 hover:bg-blue-50 hover:border-blue-300"
                >
                  <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center mb-3">
                    <Video className="w-6 h-6 text-blue-500" />
                  </div>
                  <p className="font-bold text-slate-700 text-[15px]">영상촬영하기</p>
                  <p className="text-xs text-slate-400 mt-1">클릭하면 촬영 페이지로 이동합니다</p>
                </button>

                {/* 영상 업로드하기 — 촬영 페이지를 업로드 모드(?mode=upload)로 연다 */}
                <button
                  type="button"
                  onClick={goToUploadPage}
                  className="w-full mt-3 border-2 border-dashed rounded-xl p-5 flex items-center justify-center gap-3 cursor-pointer transition-colors border-slate-300 bg-slate-50 hover:bg-blue-50 hover:border-blue-300"
                >
                  <div className="w-9 h-9 rounded-full bg-white shadow-sm flex items-center justify-center shrink-0">
                    <Upload className="w-4 h-4 text-slate-500" />
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-slate-700 text-[15px]">영상 업로드하기</p>
                    <p className="text-xs text-slate-400 mt-0.5">촬영된 영상 파일을 올려서 분석합니다</p>
                  </div>
                </button>
              </div>

              {/* 발표자료 PDF — 고르면 "영상촬영하기" 때 촬영 화면에 슬라이드로 크게 띄운다 */}
              <div>
                <label className="block text-[14px] font-bold text-slate-700 mb-2">발표 자료(선택)</label>
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    e.target.value = ''; // 같은 파일을 다시 골라도 onChange 가 불리게
                    if (!file) return;
                    if (!file.name.toLowerCase().endsWith('.pdf')) {
                      setPdfError('PDF 파일만 올릴 수 있어요. PPT는 PDF로 저장해서 올려주세요.');
                      return;
                    }
                    setPdfError(null);
                    setUploadedPdf(file);
                  }}
                />
                <div
                  className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-colors
                    ${uploadedPdf ? 'border-purple-500 bg-purple-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'}`}
                  onClick={() => pdfInputRef.current?.click()}
                >
                  {uploadedPdf ? (
                    <>
                      <FileText className="w-7 h-7 text-purple-500 mb-2" />
                      <p className="font-bold text-purple-700">{uploadedPdf.name}</p>
                      <p className="text-xs text-purple-400 mt-1">다른 파일로 바꾸려면 다시 클릭하세요</p>
                    </>
                  ) : (
                    <div className="flex items-center gap-3 text-slate-500">
                      <FileText className="w-5 h-5 text-slate-400" />
                      <span className="font-semibold text-[14px]">클릭하여 PDF 자료 첨부 (촬영 화면에 슬라이드로 표시)</span>
                    </div>
                  )}
                </div>
                {pdfError && <p className="text-xs text-rose-600 font-semibold mt-2">{pdfError}</p>}
              </div>

            </div>
            <div className="px-6 py-4 bg-slate-50 flex justify-end gap-3 rounded-b-2xl">
              <button
                onClick={closeSessionModal}
                className="px-5 py-2.5 text-[14.5px] font-bold text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
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

// Subcomponent for feedback items
function FeedbackItem({ icon, title, content }: { icon: React.ReactNode, title: string, content: string }) {
  return (
    <div className="flex gap-4 p-5 rounded-2xl bg-white shadow-sm border border-slate-100 hover:border-blue-100 hover:shadow-md transition-all duration-200">
      <div className="mt-0.5 shrink-0 bg-slate-50 p-2 rounded-xl border border-slate-100">
        {icon}
      </div>
      <div>
        <h4 className="text-[16px] font-extrabold text-slate-800 mb-1.5">{title}</h4>
        <p className="text-[15px] text-slate-600 font-medium leading-relaxed">{content}</p>
      </div>
    </div>
  );
}
