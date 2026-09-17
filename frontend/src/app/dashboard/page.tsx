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

const videoThumbnail = "/dashboard-video-thumbnail.png";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// 백엔드 응답 형태 (app/schemas/project.py, app/schemas/session.py)
interface ApiSession {
  session_id: number;
  project_id: number;
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
    sessions: sortedSessions.map((s, idx) => ({
      id: String(s.session_id),
      name: `${idx + 1}회차 연습`,
      date: s.created_at.slice(0, 10).replace(/-/g, '.'),
    })),
  };
}

// --- Mock Data ---
// (단일/비교/성장 분석 화면은 STEP 3~5 백엔드가 아직 없어 당분간 Mock 유지)

// gesture_counts 7종(app/pipeline/step2_video_analysis.py) 중 일반/부정적 제스처로 묶는 기준.
const GENERAL_GESTURE_KEYS = ["explanatory_gesture", "pointing", "body_movement"] as const;
const NEGATIVE_GESTURE_KEYS = ["distracting_gesture", "touching_face_or_hair", "fidgeting_with_objects", "closed_posture"] as const;

interface GestureTotals {
  general: number;
  negative: number;
}

// 필러/WPM/무음/발화습관은 STEP3(STT)가 아직 DB에 연결 안 돼 Mock 유지, 제스처만 실제 데이터.
function buildSummaryStats(gestureTotals: GestureTotals | null) {
  return [
    { title: "필러 단어 빈도", value: "15회", badge: "주의", badgeColor: "text-rose-600 bg-rose-50 border-rose-100", icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { title: "평균 말하기 속도", value: "126 WPM", badge: "적정", badgeColor: "text-green-600 bg-green-50 border-green-100", icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { title: "전체 무음 비율", value: "8%", badge: "양호", badgeColor: "text-purple-600 bg-purple-50 border-purple-100", icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { title: "발견된 발화 습관", value: "16건", badge: "개선 필요", badgeColor: "text-orange-600 bg-orange-50 border-orange-100", icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { title: "일반 제스처", value: gestureTotals ? `${gestureTotals.general}회` : "-", badge: "양호", badgeColor: "text-blue-600 bg-blue-50 border-blue-100", icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { title: "부정적 제스처", value: gestureTotals ? `${gestureTotals.negative}회` : "-", badge: "주의", badgeColor: "text-rose-600 bg-rose-50 border-rose-100", icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
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

const ANALYSIS_METRICS = [
  { id: 'am-1', segment: '도입', wpm: 120, fillerTotal: 5, silenceRatio: 12, habits: 2 },
  { id: 'am-2', segment: '문제 제기', wpm: 145, fillerTotal: 2, silenceRatio: 5, habits: 1 },
  { id: 'am-3', segment: '해결 방안', wpm: 135, fillerTotal: 8, silenceRatio: 15, habits: 4 },
  { id: 'am-4', segment: '결론', wpm: 110, fillerTotal: 1, silenceRatio: 4, habits: 0 },
];

const FEEDBACK_DATA = [
  {
    id: "fb-1",
    segment: "도입",
    delivery: "명확한 목소리로 시작하여 청중의 이목을 끄는 데 성공했습니다. 말하기 속도(120 WPM)도 듣기 편안한 수준이었습니다.",
    habits: "'어...', '그...' 와 같은 필러 단어가 5회 발생했으며, 다음 문장을 생각할 때 발생하는 3초 이상의 긴 무음이 감지되었습니다.",
    gesture: "안정적인 자세를 유지했으나, 스크립트를 상기하느라 시선이 다소 아래를 향하는 경향이 있었습니다.",
    improvements: "시선을 스크린이나 허공이 아닌 청중에게 향하도록 의식적인 노력이 필요합니다. 다음 내용을 넘어가기 전에 가볍게 심호흡을 하면 필러 단어를 줄일 수 있습니다."
  },
  {
    id: "fb-2",
    segment: "문제 제기",
    delivery: "데이터를 설명할 때 말하기 속도가 145 WPM으로 다소 빨라졌습니다. 핵심 수치(30%)를 강조할 때 잠시 쉬어가는 것이 좋습니다.",
    habits: "필러 단어 사용이 2회로 줄어들어 이전 구간 대비 개선된 모습을 보였습니다.",
    gesture: "손짓을 활용하여 문제의 심각성을 잘 어필했습니다. 표정도 상황에 맞게 진지했습니다.",
    improvements: "빠른 템포로 정보를 쏟아내기보다는, 중요 포인트 직후에 1~2초간 멈춤(Pause) 기법을 활용해보세요."
  },
  {
    id: "fb-3",
    segment: "해결 방안",
    delivery: "솔루션을 제시할 때 자신감 있는 어조가 돋보였습니다.",
    habits: "설명이 복잡해지면서 필러 단어(8회)와 무음 구간이 다시 증가했습니다.",
    gesture: "화면을 가리키는 동작이 자연스러웠으나, 때때로 등을 보이는 자세가 연출되었습니다.",
    improvements: "스크린을 가리킬 때는 청중을 향해 열린 자세(45도 각도)를 유지하는 것이 좋습니다."
  },
  {
    id: "fb-4",
    segment: "결론",
    delivery: "핵심 요약을 천천히(110 WPM) 전달하여 마무리 효과가 좋았습니다.",
    habits: "발화 습관이 가장 안정적인 구간입니다. 필러 단어와 무음이 거의 없습니다.",
    gesture: "청중과 부드럽게 시선을 맞추며 마무리 인사를 한 점이 훌륭합니다.",
    improvements: "현재의 안정감 있는 결론 전달 방식을 계속 유지하세요."
  }
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
  { id: 'habits', title: '발견된 발화 습관', s1: '24건', s2: '16건', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
  { id: 'pos_gesture', title: '긍정적 제스처', s1: '8회', s2: '12회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
  { id: 'neg_gesture', title: '부정적 제스처', s1: '15회', s2: '5회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
];

const COMPARE_SEGMENT_METRICS = [
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '8회', s2: '5회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '110 WPM', s2: '120 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '15%', s2: '12%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '발견된 발화 습관', s1: '6건', s2: '2건', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '1회', s2: '3회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '5회', s2: '1회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ],
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '5회', s2: '2회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '130 WPM', s2: '145 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '8%', s2: '5%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '발견된 발화 습관', s1: '4건', s2: '1건', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '2회', s2: '4회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '4회', s2: '2회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ],
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '10회', s2: '8회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '120 WPM', s2: '135 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '18%', s2: '15%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '발견된 발화 습관', s1: '10건', s2: '4건', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '3회', s2: '2회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '4회', s2: '1회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ],
  [
    { id: 'filler', title: '필러 단어 빈도', s1: '2회', s2: '0회', icon: MessageSquare, color: "text-rose-600", bg: "bg-rose-50" },
    { id: 'wpm', title: '평균 말하기 속도', s1: '100 WPM', s2: '110 WPM', icon: Activity, color: "text-green-600", bg: "bg-green-50" },
    { id: 'silence', title: '전체 무음 비율', s1: '6%', s2: '4%', icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
    { id: 'habits', title: '발견된 발화 습관', s1: '4건', s2: '0건', icon: BarChart2, color: "text-orange-600", bg: "bg-orange-50" },
    { id: 'pos_gesture', title: '긍정적 제스처', s1: '2회', s2: '3회', icon: ThumbsUp, color: "text-blue-600", bg: "bg-blue-50" },
    { id: 'neg_gesture', title: '부정적 제스처', s1: '2회', s2: '1회', icon: AlertCircle, color: "text-rose-600", bg: "bg-rose-50" },
  ]
];

const GROWTH_METRICS_CONFIG = [
  { id: 'fillerTotal', label: '필러 단어 빈도', unit: '회', color: '#f43f5e', type: 'line' },
  { id: 'wpm', label: '평균 말하기 속도', unit: 'WPM', color: '#3b82f6', type: 'line' },
  { id: 'silenceRatio', label: '전체 무음 비율', unit: '%', color: '#c084fc', type: 'bar' },
  { id: 'habits', label: '발견된 발화 습관', unit: '건', color: '#fb923c', type: 'bar' }
];

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

  // 선택된 세션의 실제 영상 경로 + VLM 제스처 집계 (STEP2 결과, /sessions/{id}/analysis)
  const [sessionVideoPath, setSessionVideoPath] = useState<string | null>(null);
  const [gestureTotals, setGestureTotals] = useState<GestureTotals | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!activeSessionId) {
      setSessionVideoPath(null);
      setGestureTotals(null);
      return;
    }
    (async () => {
      try {
        const sessionRes = await fetch(`${API_BASE}/sessions/${activeSessionId}`);
        if (sessionRes.ok) {
          const detail: ApiSession = await sessionRes.json();
          setSessionVideoPath(detail.full_video_path);
        } else {
          setSessionVideoPath(null);
        }
      } catch (err) {
        console.error(err);
        setSessionVideoPath(null);
      }

      try {
        const analysisRes = await fetch(`${API_BASE}/sessions/${activeSessionId}/analysis`);
        if (!analysisRes.ok) throw new Error('failed to load analysis');
        const data: { analyses: { gesture_counts: Record<string, number> | null }[] } = await analysisRes.json();
        let general = 0;
        let negative = 0;
        for (const a of data.analyses) {
          const counts = a.gesture_counts || {};
          for (const key of GENERAL_GESTURE_KEYS) general += counts[key] || 0;
          for (const key of NEGATIVE_GESTURE_KEYS) negative += counts[key] || 0;
        }
        setGestureTotals({ general, negative });
      } catch (err) {
        console.error(err);
        setGestureTotals(null);
      }
    })();
  }, [activeSessionId]);

  const videoSrc = sessionVideoPath ? `${API_BASE}/media/${activeSessionId}/full_video.webm` : null;

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
  const [targetTopicId, setTargetTopicId] = useState<string | null>(null);

  // PDF는 아직 대응 API가 없어 Mock 유지. 영상은 /record 페이지에서 실시간 촬영으로 처리.
  const [uploadedPdf, setUploadedPdf] = useState<string | null>(null);

  const activeFeedback = FEEDBACK_DATA[activeSegmentIndex];

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

  const deleteTopic = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
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
    closeSessionModal();
    router.push(`/record?project=${projectId}`);
  };

  const deleteSession = async (e: React.MouseEvent, topicId: string, sessionId: string) => {
    e.stopPropagation();
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
    }
  };

  const openSessionModal = (e: React.MouseEvent, topicId: string) => {
    e.stopPropagation();
    setTargetTopicId(topicId);
    setIsSessionModalOpen(true);
  };

  const closeSessionModal = () => {
    setIsSessionModalOpen(false);
    setTargetTopicId(null);
    setUploadedPdf(null);
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
          <div className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-2 rounded-xl shadow-sm shadow-blue-200">
              <BarChart2 className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">발표 영상 분석</h1>
          </div>
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
                  <p className="text-[15px] text-slate-500 mt-2 font-medium">주제별 폴더를 생성하고 발표 연습 영상을 업로드하여 분석을 시작하세요.</p>
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
                          onClick={(e) => deleteTopic(e, topic.id)}
                          className="text-slate-400 hover:text-red-500 p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                          title="폴더 삭제"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Sessions List */}
                    <div className="p-5 flex-1 flex flex-col gap-3">
                      {topic.sessions.length > 0 ? (
                        <div className="space-y-3">
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
                                onClick={(e) => deleteSession(e, topic.id, session.id)} 
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
                      
                      {/* Add Session Button inside folder */}
                      <button 
                        onClick={(e) => openSessionModal(e, topic.id)} 
                        className="mt-auto w-full flex items-center justify-center gap-2 p-3.5 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all font-semibold text-[14px]"
                      >
                        <Plus className="w-4 h-4" />
                        발표 추가
                      </button>
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
                  {/* Top: Summary Cards */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {buildSummaryStats(gestureTotals).map((stat, idx) => {
                      const Icon = stat.icon;
                      return (
                        <div key={idx} className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex flex-col justify-between h-[110px]">
                          <div className="flex justify-between items-start w-full gap-2">
                            <p className="text-sm font-bold text-slate-500 mb-1 truncate">{stat.title}</p>
                            <div className={`p-2 rounded-xl shrink-0 ${stat.bg}`}>
                              <Icon className={`w-5 h-5 ${stat.color}`} />
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mt-auto">
                            <h2 className="text-2xl font-extrabold text-slate-800 whitespace-nowrap">{stat.value}</h2>
                            {stat.badge && <span className={`text-xs font-bold whitespace-nowrap px-1.5 py-0.5 rounded-md border ${stat.badgeColor}`}>{stat.badge}</span>}
                          </div>
                        </div>
                      );
                    })}
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
                      <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md text-white px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10 shadow-lg">
                        현재 구간: <span className="text-blue-300">{SEGMENTS[activeSegmentIndex].name}</span>
                      </div>
                    </div>

                    {/* Timeline Buttons */}
                    <div className="flex items-center gap-2">
                      {SEGMENTS.map((seg, idx) => (
                        <button 
                          key={seg.id}
                          onClick={() => setActiveSegmentIndex(idx)}
                          className={`flex-1 py-3 px-4 rounded-xl text-[15px] font-extrabold border transition-all ${activeSegmentIndex === idx ? 'bg-slate-800 text-white border-slate-800 shadow-md shadow-slate-300' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800'}`}
                        >
                          <div className="flex items-center justify-center gap-2.5">
                            <div className={`w-3 h-3 rounded-full shadow-sm ${seg.color}`}></div>
                            {seg.name}
                          </div>
                        </button>
                      ))}
                    </div>

                    {/* Segment Script */}
                    <div className="mt-5 bg-slate-50 rounded-xl p-5 border border-slate-100">
                      <h4 className="font-extrabold text-slate-800 mb-3 flex items-center gap-2 text-[15px]">
                        <FileText className="w-4 h-4 text-blue-500" />
                        {SEGMENTS[activeSegmentIndex].name} 구간 스크립트
                      </h4>
                      <div className="space-y-3 max-h-[160px] overflow-y-auto custom-scrollbar pr-2">
                        {STT_DATA.filter(item => item.segment === SEGMENTS[activeSegmentIndex].name).map((item, i) => (
                          <div key={`script-part-${i}`} className="flex gap-3 text-[14px]">
                            <span className="text-slate-400 font-bold shrink-0 w-12 pt-1">{item.time}</span>
                            <div className="text-slate-700 leading-relaxed font-medium flex-1">
                              {item.type === 'normal' && item.text}
                              
                              {item.type === 'gesture' && (
                                <button className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border shadow-sm transition-all hover:-translate-y-0.5 ${item.gestureType === 'normal' ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100' : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'}`}>
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
                                        <button className="bg-orange-100 text-orange-700 px-2.5 py-1 rounded-lg text-xs font-bold border border-orange-200 mx-1 shadow-sm transition-all hover:-translate-y-0.5 inline-flex items-center gap-1">
                                          <MessageSquare className="w-3.5 h-3.5" />
                                          발화습관: {item.highlight}
                                        </button>
                                      )}
                                    </React.Fragment>
                                  ))}
                                </>
                              )}
                              
                              {item.type === 'silence' && (
                                <button className="bg-slate-200 text-slate-600 px-2.5 py-1 rounded-lg text-xs font-bold border border-slate-300 inline-flex items-center gap-1.5 shadow-sm transition-all hover:-translate-y-0.5">
                                  <Clock className="w-3.5 h-3.5" />
                                  발화습관: {item.highlight}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Middle-Bottom: Graphs by Segment */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                        <span className="bg-purple-100 text-purple-600 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5"/></span>
                        구간별 지표 분석 그래프
                      </h3>
                    </div>

                    {/* Metric Selection Buttons */}
                    <div className="flex flex-wrap gap-3 mb-8">
                      {GROWTH_METRICS_CONFIG.map(metric => (
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
                         const activeMetricConfig = GROWTH_METRICS_CONFIG.find(m => m.id === activeSingleMetric)!;
                         return (
                           <ResponsiveContainer width="100%" height="100%">
                             <ComposedChart data={ANALYSIS_METRICS} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                               <CartesianGrid key="grid-single" strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                               <XAxis key="xaxis-single" dataKey="segment" axisLine={false} tickLine={false} tick={{fill: '#64748B', fontSize: 14, fontWeight: 600}} dy={15} />
                               <YAxis 
                                 key={`yaxis-single-${activeMetricConfig.id}`}
                                 axisLine={false} tickLine={false} 
                                 tick={{fill: activeMetricConfig.color, fontSize: 13, fontWeight: 700}} 
                                 domain={['auto', 'auto']} dx={-10} unit={activeMetricConfig.unit} 
                               />
                               <Tooltip 
                                 key={`tooltip-single-${activeMetricConfig.id}`}
                                 cursor={{fill: '#f8fafc', stroke: activeMetricConfig.type === 'line' ? '#e2e8f0' : 'none', strokeWidth: 1, strokeDasharray: '4 4'}}
                                 contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
                                 formatter={(value: number) => [`${value}${activeMetricConfig.unit}`, activeMetricConfig.label]}
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
                  </div>

                  {/* Bottom: Segment AI Feedback */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-green-100 text-green-600 p-1.5 rounded-xl"><CheckCircle className="w-5 h-5"/></span>
                      구간별 AI 종합 피드백
                    </h3>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {FEEDBACK_DATA.map((fb, idx) => (
                        <div 
                          key={fb.id} 
                          onClick={() => setActiveSegmentIndex(idx)}
                          className={`p-6 rounded-2xl border transition-all cursor-pointer ${activeSegmentIndex === idx ? 'bg-blue-50/50 border-blue-300 shadow-sm ring-2 ring-blue-500/20' : 'bg-slate-50 border-slate-200 hover:bg-slate-100 hover:border-slate-300'}`}
                        >
                          <div className="flex items-center gap-2 mb-4">
                            <div className={`w-3.5 h-3.5 rounded-full shadow-sm ${SEGMENTS[idx].color}`}></div>
                            <h4 className="font-extrabold text-slate-800 text-[16px]">{fb.segment}</h4>
                            {activeSegmentIndex === idx && <span className="ml-auto text-xs font-bold text-blue-600 bg-blue-100 px-2.5 py-1 rounded-md">현재 선택됨</span>}
                          </div>
                          
                          <div className="space-y-3.5 text-[14px]">
                            <div className="flex gap-2.5 items-start">
                              <span className="font-extrabold text-slate-500 whitespace-nowrap pt-0.5">전달력:</span>
                              <span className="text-slate-700 font-medium leading-relaxed">{fb.delivery}</span>
                            </div>
                            <div className="flex gap-2.5 items-start">
                              <span className="font-extrabold text-slate-500 whitespace-nowrap pt-0.5">발화습관:</span>
                              <span className="text-slate-700 font-medium leading-relaxed">{fb.habits}</span>
                            </div>
                            <div className="flex gap-2.5 items-start">
                              <span className="font-extrabold text-slate-500 whitespace-nowrap pt-0.5">자세/시선:</span>
                              <span className="text-slate-700 font-medium leading-relaxed">{fb.gesture}</span>
                            </div>
                            
                            <div className="bg-white p-4 rounded-xl border border-slate-200 mt-4 flex gap-2.5 items-start shadow-sm">
                              <span className="bg-green-100 text-green-700 p-1.5 rounded-lg shrink-0 mt-0.5"><Award className="w-4 h-4"/></span>
                              <div>
                                <h5 className="font-extrabold text-green-800 mb-1 text-[13px]">개선 제안</h5>
                                <p className="text-slate-700 font-semibold leading-relaxed">{fb.improvements}</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
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
                            habits: 4 + maxImprovementFactor * 3,        // 발견된 발화 습관 (건수)
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
              <h3 className="font-extrabold text-slate-800 text-lg">새 발표 연습(세션) 추가</h3>
              <button onClick={closeSessionModal} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-[14px] text-slate-500 font-medium">
                Podium은 녹화 파일이 아니라 실시간으로 촬영하며 분석하는 방식입니다. 아래 버튼을 누르면 촬영 페이지로 이동합니다.
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
              </div>

              {/* PDF Upload Box */}
              <div>
                <label className="block text-[14px] font-bold text-slate-700 mb-2">발표 자료(선택)</label>
                <div 
                  className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-colors
                    ${uploadedPdf ? 'border-purple-500 bg-purple-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'}`}
                  onClick={() => setUploadedPdf('slide_deck_final.pdf')}
                >
                  {uploadedPdf ? (
                    <>
                      <FileText className="w-7 h-7 text-purple-500 mb-2" />
                      <p className="font-bold text-purple-700">{uploadedPdf}</p>
                    </>
                  ) : (
                    <div className="flex items-center gap-3 text-slate-500">
                      <FileText className="w-5 h-5 text-slate-400" />
                      <span className="font-semibold text-[14px]">클릭하여 PDF 자료 첨부 (슬라이드 동기화 용도)</span>
                    </div>
                  )}
                </div>
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
