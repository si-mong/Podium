'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Play, Pause,
  CheckCircle, AlertCircle, TrendingUp,
  BarChart2, Mic, Activity, Award, Clock, Video,
  Folder, FolderOpen, ChevronRight, Plus, Trash2, Upload, X, FileText, MessageSquare, Columns, ThumbsUp, Lightbulb
} from 'lucide-react';
import {
  Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart
} from 'recharts';

// --- 타입 정의 ---

interface Session {
  id: string;
  name: string;
  date: string;
}

interface Topic {
  id: string;
  name: string;
  sessions: Session[];
}

// --- 목업 데이터 ---

const SUMMARY_STATS = [
  {
    title: "필러 단어 빈도",
    value: "15회",
    badge: "주의",
    badgeColor: "text-rose-600 bg-rose-50 border-rose-100",
    icon: MessageSquare,
    color: "text-rose-600",
    bg: "bg-rose-50"
  },
  {
    title: "평균 말하기 속도",
    value: "126 WPM",
    badge: "적정",
    badgeColor: "text-green-600 bg-green-50 border-green-100",
    icon: Activity,
    color: "text-green-600",
    bg: "bg-green-50"
  },
  {
    title: "전체 무음 비율",
    value: "8%",
    badge: "양호",
    badgeColor: "text-purple-600 bg-purple-50 border-purple-100",
    icon: Mic,
    color: "text-purple-600",
    bg: "bg-purple-50"
  },
  {
    title: "발견된 발화 습관",
    value: "16건",
    badge: "개선 필요",
    badgeColor: "text-orange-600 bg-orange-50 border-orange-100",
    icon: BarChart2,
    color: "text-orange-600",
    bg: "bg-orange-50"
  },
];

const SEGMENTS = [
  { id: "s1", name: "도입", percent: 20, color: "bg-blue-500" },
  { id: "s2", name: "문제 제기", percent: 30, color: "bg-indigo-500" },
  { id: "s3", name: "해결 방안", percent: 35, color: "bg-purple-500" },
  { id: "s4", name: "결론", percent: 15, color: "bg-pink-500" },
];

const STT_DATA = [
  { time: "00:00", text: "우선 저희팀의 조원이 3명에서 2명으로 바뀌는 과정에서 주제를 다시 선택하게 되었습니다.", segment: "도입", type: "normal", highlight: undefined },
  { time: "00:05", text: "이... 큰 과제를 바꾸기 보다는", segment: "도입", type: "filler", highlight: "이..." },
  { time: "00:10", text: "기존의 '발화 연습'이라는 큰 과제의 세부적인 주제를 변경하기로 하였고,", segment: "도입", type: "normal", highlight: undefined },
  { time: "00:15", text: "(2초 무음)", segment: "도입", type: "silence", highlight: "(2초 무음)" },
  { time: "00:17", text: "지금 현재 주제 두 가지를 생각중에 있습니다. 그리고 오늘 발표에서는 생각중인 두 가지의 주제를 발표할 예정입니다.", segment: "도입", type: "normal", highlight: undefined },
  { time: "00:25", text: "먼저, 첫 번째 주제는 '발화 연습 분석 시스템'입니다.", segment: "문제 제기", type: "normal", highlight: undefined },
  { time: "00:30", text: "사용자가 영상을 업로드하면 촬영상에서 싱크를 맞춰주고 슬라이드를 구분하는 과정을 거치게 됩니다.", segment: "문제 제기", type: "normal", highlight: undefined },
  { time: "00:40", text: "음... 그리고 저희가 생각하는 영상의 분석을 스피치 전문가에게 맡긴다는 가정이 하였는데,", segment: "문제 제기", type: "filler", highlight: "음..." },
  { time: "00:48", text: "이번주에 영상을 분석부분에 VLM 모델을 이용해서 분석하기로 생각을 하고 있습니다.", segment: "문제 제기", type: "normal", highlight: undefined },
  { time: "00:55", text: "따라서 크게 저희팀은 [데이터 전처리]→[데이터 분석]→[데이터 후처리] 중 데이터분석에 VLM 모델을 맡기고 전처리와 후처리 모두 개발하기로 하였습니다.", segment: "문제 제기", type: "normal", highlight: undefined },
  { time: "01:10", text: "저희 시스템의 프로세스에 대해 설명드리겠습니다.", segment: "해결 방안", type: "normal", highlight: undefined },
  { time: "01:13", text: "(3초 무음)", segment: "해결 방안", type: "silence", highlight: "(3초 무음)" },
  { time: "01:16", text: "먼저, 핸드폰이나 노트북으로 촬영된 영상을 시스템에 업로드를 하면 STT 기술을 이용해 텍스트 대본을 뽑아냅니다.", segment: "해결 방안", type: "normal", highlight: undefined },
  { time: "01:25", text: "그리고 [데이터분석]부분인데 저희는 적합한 VLM 모델이 무엇인지에 대해 테스트해보았습니다. 크게 QWEN, GEMINI를 이용하였습니다.", segment: "해결 방안", type: "normal", highlight: undefined },
  { time: "01:38", text: "그... 다양한 영상 길이와 다양한 명령 프롬프트로 테스트해봤고,", segment: "해결 방안", type: "filler", highlight: "그..." },
  { time: "01:45", text: "같은 명령어를 여러번 프롬프트에 입력했을 때 같은 결과가 나오는지와, VLM 모델에서 계산한 점수와 저희가 실제 영상을 보면서 인본 점수화 결과를 비교하는 등 여러 가지로 VLM 모델을 테스트하였습니다.", segment: "해결 방안", type: "normal", highlight: undefined },
  { time: "02:05", text: "찾아본바에 따르면 VLM을 영상을 통째로 넣어 분석하게 되면 2초~3초 샘플링 프레임으로 분석하는 VLM 특성이 점수산정에서 누락될 수 있다고 해서", segment: "결론", type: "normal", highlight: undefined },
  { time: "02:20", text: "저희가 실제 발화연습 영상들을 이어서 VLM 모델을 넣어본 결과 30초 이하 영상을 넣었을 때 점수 산정 인식이 잘 되어 정확도가 제일 높았습니다.", segment: "결론", type: "normal", highlight: undefined },
  { time: "02:35", text: "그리하여 예를 들어 5분짜리 영상이라고 하면 30초 단위로 영상을 나눠서 VLM 모델에 전달할 계획입니다.", segment: "결론", type: "normal", highlight: undefined },
  { time: "02:45", text: "그래서 '발화에서 영상의 자세와 점수화를 수치를 세주고 .JSON 형식으로 출력해줘'라는 명령과 함께 VLM 명령 프롬프트에 전달하게 됩니다.", segment: "결론", type: "normal", highlight: undefined },
  { time: "03:00", text: "VLM 결과 후처리 하기 위해 JSON 형태로 결과값을 받아 시각화됩니다.", segment: "결론", type: "normal", highlight: undefined },
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
    delivery: "명확한 목소리로 시작하여 청중의 이목을 끄는 데 성공하였습니다. 말하기 속도(120 WPM)는 듣기 편안한 수준이었습니다.",
    habits: "'이...', '그...' 와 같은 필러 단어가 5회 발생하였으며, 다음 문장을 생각할 때 발생하는 3초 이상의 긴 무음이 감지되었습니다.",
    gesture: "안정적인 자세를 유지하였으나, 스크립트를 읽느라 시선이 다소 아래를 향하는 경향이 있었습니다.",
    improvements: "시선을 스크린이나 청중에게 향하도록 의식적인 노력이 필요합니다. 다음 내용을 넘어가기 전에 가볍게 숨 고르기를 하면 필러 단어를 줄일 수 있습니다."
  },
  {
    id: "fb-2",
    segment: "문제 제기",
    delivery: "데이터를 설명할 때 말하기 속도가 145 WPM으로 다시 빨라졌습니다. 핵심 수치(30%)를 강조할 때 잠시 사이를 갖는 것이 좋습니다.",
    habits: "필러 단어 사용이 2회로 줄어들어 이전 구간 대비 개선된 모습을 보였습니다.",
    gesture: "움직임을 활용하여 문제의 심각성을 잘 전달하였습니다. 화면 방향에 맞게 자세를 유지하였습니다.",
    improvements: "빠른 템포로 정보를 쏟아내기보다는, 중요 포인트 직전에 1~2초 멈춤(Pause) 기법을 활용해보세요."
  },
  {
    id: "fb-3",
    segment: "해결 방안",
    delivery: "솔루션을 제시할 때 자신감 있는 어조가 돋보였습니다.",
    habits: "설명이 복잡해지면서 필러 단어(8회)와 무음 구간이 다시 증가하였습니다.",
    gesture: "화면을 가리키는 동작이 자연스러웠으나, 가끔 등을 보이는 자세가 연출되었습니다.",
    improvements: "스크린을 가리킬 때는 청중을 향해 열린 자세(45도 각도)를 유지하는 것이 좋습니다."
  },
  {
    id: "fb-4",
    segment: "결론",
    delivery: "핵심 요약을 천천히(110 WPM) 전달하여 마무리 효과가 좋았습니다.",
    habits: "발화 습관이 가장 안정적인 구간입니다. 필러 단어와 무음이 거의 없었습니다.",
    gesture: "청중과 부드럽게 시선을 맞추며 마무리 인사를 한 점이 훌륭합니다.",
    improvements: "현재의 자신감 있는 결론 전달 방식을 계속 유지하세요."
  }
];

const COMPARE_FEEDBACK = {
  strengths: [
    "1회차에 비해 2회차에서 무음 비율이 12%에서 8%로 감소하여 훨씬 매끄러운 진행을 보여주었습니다.",
    "발화 습관(이..., 음... 등)이 전반적으로 감소하여 전달력이 크게 향상되었습니다."
  ],
  improvements: [
    "2회차에서 말하기 속도가 145 WPM으로 다시 빨라진 구간이 있습니다. 중요한 부분에서는 여유를 가지고 강조하는 연습이 필요합니다.",
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
  { id: 'wpm', title: '평균 말하기 속도', s1: '115 WPM', s2: '126 WPM', icon: Activity, color: "text-blue-600", bg: "bg-blue-50" },
  { id: 'silence', title: '전체 무음 비율', s1: '12%', s2: '8%', icon: Clock, color: "text-purple-600", bg: "bg-purple-50" },
  { id: 'habits', title: '발견된 발화 습관', s1: '24건', s2: '16건', icon: AlertCircle, color: "text-orange-600", bg: "bg-orange-50" },
];

const INITIAL_TOPICS: Topic[] = [
  {
    id: 't1',
    name: '1. 캡스톤디자인 발표',
    sessions: [
      { id: 's1', name: '1회차 연습', date: '2026.05.01' },
      { id: 's2', name: '2회차 연습', date: '2026.05.03' },
      { id: 's3', name: '3회차 연습', date: '2026.05.05' },
      { id: 't1-s4', name: '4회차 연습 (최종)', date: '2026.05.07' }
    ]
  },
  {
    id: 't2',
    name: '2. 교직이수 발표',
    sessions: [
      { id: 't2-s1', name: '1회차 연습', date: '2026.05.08' }
    ]
  },
  {
    id: 't3',
    name: '3. 동아리 발표',
    sessions: []
  }
];

const GROWTH_METRICS_CONFIG = [
  { id: 'fillerTotal', label: '필러 단어 빈도', unit: '회', color: '#f43f5e', type: 'line' as const },
  { id: 'wpm', label: '평균 말하기 속도', unit: 'WPM', color: '#3b82f6', type: 'line' as const },
  { id: 'silenceRatio', label: '전체 무음 비율', unit: '%', color: '#c084fc', type: 'bar' as const },
  { id: 'habits', label: '발견된 발화 습관', unit: '건', color: '#fb923c', type: 'bar' as const }
];

// --- 메인 컴포넌트 ---

export default function PresentationDashboard({ initialVideoRecordedTopicId }: { initialVideoRecordedTopicId?: string }) {
  const router = useRouter();
  const [activeMenu, setActiveMenu] = useState('sessions');
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [topics, setTopics] = useState<Topic[]>(INITIAL_TOPICS);
  const [activeSessionId, setActiveSessionId] = useState('t1-s4');

  const [selectedGrowthTopicId, setSelectedGrowthTopicId] = useState('t1');
  const [activeGrowthMetric, setActiveGrowthMetric] = useState('fillerTotal');
  const [activeSingleMetric, setActiveSingleMetric] = useState('fillerTotal');

  const [isPlayingCompare1, setIsPlayingCompare1] = useState(false);
  const [isPlayingCompare2, setIsPlayingCompare2] = useState(false);
  const [activeCompareStt1, setActiveCompareStt1] = useState(0);
  const [activeCompareStt2, setActiveCompareStt2] = useState(0);

  const [isTopicModalOpen, setIsTopicModalOpen] = useState(false);
  const [newTopicName, setNewTopicName] = useState('');
  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
  const [targetTopicId, setTargetTopicId] = useState<string | null>(null);
  const [uploadedVideo, setUploadedVideo] = useState<string | null>(null);
  const [uploadedPdf, setUploadedPdf] = useState<string | null>(null);

  // 촬영 페이지에서 돌아왔을 때 모달을 영상 선택 완료 상태로 열기
  useEffect(() => {
    if (!initialVideoRecordedTopicId) return;
    setTargetTopicId(initialVideoRecordedTopicId);
    setUploadedVideo('녹화된 영상.webm');
    setIsSessionModalOpen(true);
    router.replace('/');
  }, [initialVideoRecordedTopicId, router]);

  let activeTopicName = "";
  let activeSessionName = "";
  topics.forEach(t => {
    const s = t.sessions.find(s => s.id === activeSessionId);
    if (s) {
      activeTopicName = t.name;
      activeSessionName = s.name;
    }
  });

  const addTopic = () => {
    if (!newTopicName.trim()) return;
    const newId = `t${Date.now()}`;
    setTopics([...topics, { id: newId, name: newTopicName, sessions: [] }]);
    setNewTopicName('');
    setIsTopicModalOpen(false);
  };

  const deleteTopic = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setTopics(topics.filter(t => t.id !== id));
  };

  const openSessionModal = (e: React.MouseEvent, topicId: string) => {
    e.stopPropagation();
    setTargetTopicId(topicId);
    setIsSessionModalOpen(true);
  };

  const closeSessionModal = () => {
    setIsSessionModalOpen(false);
    setTargetTopicId(null);
    setUploadedVideo(null);
    setUploadedPdf(null);
  };

  const addSession = () => {
    if (!uploadedVideo || !targetTopicId) return;
    const newSessionId = `s${Date.now()}`;
    setTopics(topics.map(t => {
      if (t.id === targetTopicId) {
        return {
          ...t,
          sessions: [...t.sessions, {
            id: newSessionId,
            name: `${t.sessions.length + 1}회차 연습`,
            date: new Date().toISOString().split('T')[0].replace(/-/g, '.'),
          }]
        };
      }
      return t;
    }));
    setActiveSessionId(newSessionId);
    setActiveMenu('single');
    closeSessionModal();
  };

  const deleteSession = (e: React.MouseEvent, topicId: string, sessionId: string) => {
    e.stopPropagation();
    setTopics(topics.map(t => {
      if (t.id === topicId) {
        return { ...t, sessions: t.sessions.filter(s => s.id !== sessionId) };
      }
      return t;
    }));
    if (activeSessionId === sessionId) {
      setActiveSessionId('');
      if (activeMenu !== 'sessions') setActiveMenu('sessions');
    }
  };

  const selectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setActiveMenu('single');
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans overflow-hidden">

      {/* 사이드바 */}
      <aside className="w-[280px] bg-white border-r border-slate-200 flex flex-col flex-shrink-0 z-20 shadow-sm">
        <div className="h-20 flex items-center px-6 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="bg-blue-600 p-2 rounded-xl shadow-sm shadow-blue-200">
              <BarChart2 className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">발표 연습 분석</h1>
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
              );
            })}
          </nav>
        </div>
      </aside>

      {/* 메인 콘텐츠 */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50 relative">

        {/* 상단 헤더 */}
        <header className="h-20 bg-white/80 backdrop-blur-md border-b border-slate-200 flex items-center justify-between px-8 flex-shrink-0 z-10 sticky top-0 relative">
          <div className="absolute left-1/2 -translate-x-1/2 flex justify-center w-full max-w-[50%] pointer-events-none">
            <h2 className="text-xl font-bold text-slate-800 text-center">
              {MENUS.find(m => m.id === activeMenu)?.label}
            </h2>
          </div>
          <div></div>
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

        {/* 스크롤 가능한 콘텐츠 */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">

          {/* VIEW 0: 세션 관리 */}
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
                    <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 rounded-t-2xl shrink-0">
                      <div className="flex items-center gap-3">
                        <Folder className="w-5 h-5 text-blue-500" />
                        <h3 className="font-bold text-slate-800 text-[16px] truncate">{topic.name}</h3>
                      </div>
                      <button
                        onClick={(e) => deleteTopic(e, topic.id)}
                        className="text-slate-400 hover:text-red-500 p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                        title="폴더 삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

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

                      <button
                        onClick={(e) => openSessionModal(e, topic.id)}
                        className="mt-auto w-full flex items-center justify-center gap-2 p-3.5 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all font-semibold text-[14px]"
                      >
                        <Plus className="w-4 h-4" />
                        발표 영상 추가
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 분석 뷰 (세션 선택 시) */}
          {activeMenu !== 'sessions' && activeSessionId ? (
            <div className="max-w-[1200px] mx-auto space-y-6 pb-12">

              {/* VIEW 1: 단일 분석 */}
              {activeMenu === 'single' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">

                  {/* 요약 카드 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {SUMMARY_STATS.map((stat, idx) => {
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

                  {/* 영상 타임라인 */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                        <span className="bg-blue-100 text-blue-600 p-1.5 rounded-xl"><Video className="w-5 h-5" /></span>
                        구간별 영상 타임라인
                      </h3>
                    </div>

                    {/* 영상 플레이어 영역 */}
                    <div className="relative bg-slate-800 rounded-xl overflow-hidden h-[360px] flex group mb-4">
                      <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-900" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <button
                          onClick={() => setIsPlaying(!isPlaying)}
                          className="bg-white/20 p-4 rounded-full backdrop-blur-sm hover:bg-white/30 transition"
                        >
                          {isPlaying ? <Pause className="w-8 h-8 text-white" /> : <Play className="w-8 h-8 text-white ml-1" />}
                        </button>
                      </div>
                      <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md text-white px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10 shadow-lg">
                        현재 구간: <span className="text-blue-300">{SEGMENTS[activeSegmentIndex].name}</span>
                      </div>
                      <div className="absolute bottom-4 left-4 right-4 flex items-center gap-3">
                        <div className="flex-1 h-1 bg-white/20 rounded-full">
                          <div className="h-full bg-blue-400 rounded-full w-1/3" />
                        </div>
                        <span className="text-white/60 text-xs font-medium">03:20</span>
                      </div>
                    </div>

                    {/* 타임라인 버튼 */}
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

                    {/* 구간 스크립트 */}
                    <div className="mt-5 bg-slate-50 rounded-xl p-5 border border-slate-100">
                      <h4 className="font-extrabold text-slate-800 mb-3 flex items-center gap-2 text-[15px]">
                        <FileText className="w-4 h-4 text-blue-500" />
                        {SEGMENTS[activeSegmentIndex].name} 구간 스크립트
                      </h4>
                      <div className="space-y-3 max-h-[160px] overflow-y-auto custom-scrollbar pr-2">
                        {STT_DATA.filter(item => item.segment === SEGMENTS[activeSegmentIndex].name).map((item, i) => (
                          <div key={`script-part-${i}`} className="flex gap-3 text-[14px]">
                            <span className="text-slate-400 font-bold shrink-0 w-12">{item.time}</span>
                            <p className="text-slate-700 leading-relaxed font-medium">
                              {item.type === 'normal' && item.text}
                              {item.type === 'filler' && item.highlight && (
                                <>
                                  {item.text.split(item.highlight).map((part, idx, arr) => (
                                    <React.Fragment key={`filler-${idx}`}>
                                      {part}
                                      {idx < arr.length - 1 && (
                                        <span className="bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-md text-xs font-bold border border-orange-200 mx-0.5 shadow-sm">
                                          {item.highlight}
                                        </span>
                                      )}
                                    </React.Fragment>
                                  ))}
                                </>
                              )}
                              {item.type === 'silence' && (
                                <span className="bg-slate-100 text-slate-500 px-2 py-0.5 rounded-md text-xs font-bold border border-slate-200 inline-flex items-center gap-1 mx-0.5 shadow-sm">
                                  <Clock className="w-3.5 h-3.5" />
                                  {item.highlight}
                                </span>
                              )}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 구간별 지표 그래프 */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2">
                        <span className="bg-purple-100 text-purple-600 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5" /></span>
                        구간별 지표 분석 그래프
                      </h3>
                    </div>

                    <div className="flex flex-wrap gap-3 mb-8">
                      {GROWTH_METRICS_CONFIG.map(metric => (
                        <button
                          key={metric.id}
                          onClick={() => setActiveSingleMetric(metric.id)}
                          className={`px-5 py-2.5 rounded-xl text-[14px] font-bold transition-all border ${activeSingleMetric === metric.id
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
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                              <XAxis dataKey="segment" axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 14, fontWeight: 600 }} dy={15} />
                              <YAxis
                                axisLine={false} tickLine={false}
                                tick={{ fill: activeMetricConfig.color, fontSize: 13, fontWeight: 700 }}
                                domain={['auto', 'auto']} dx={-10} unit={activeMetricConfig.unit}
                              />
                              <Tooltip
                                cursor={{ fill: '#f8fafc', stroke: activeMetricConfig.type === 'line' ? '#e2e8f0' : 'none', strokeWidth: 1, strokeDasharray: '4 4' }}
                                contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
                                formatter={(value: number) => [`${value}${activeMetricConfig.unit}`, activeMetricConfig.label]}
                              />
                              {activeMetricConfig.type === 'line' ? (
                                <Line
                                  type="monotone" dataKey={activeMetricConfig.id} name={activeMetricConfig.label}
                                  stroke={activeMetricConfig.color} strokeWidth={4}
                                  dot={{ r: 6, fill: activeMetricConfig.color, strokeWidth: 3, stroke: '#fff' }} activeDot={{ r: 8 }}
                                />
                              ) : (
                                <Bar
                                  dataKey={activeMetricConfig.id} name={activeMetricConfig.label}
                                  fill={activeMetricConfig.color} radius={[6, 6, 0, 0]} barSize={40}
                                />
                              )}
                            </ComposedChart>
                          </ResponsiveContainer>
                        );
                      })()}
                    </div>
                  </div>

                  {/* 구간별 AI 피드백 */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-green-100 text-green-600 p-1.5 rounded-xl"><CheckCircle className="w-5 h-5" /></span>
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
                              <span className="bg-green-100 text-green-700 p-1.5 rounded-lg shrink-0 mt-0.5"><Award className="w-4 h-4" /></span>
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

              {/* VIEW 2: 비교 분석 */}
              {activeMenu === 'compare' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-6">

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* 세션 1 */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs">기준</span>
                          1회차 연습
                        </h3>
                      </div>
                      <div className="relative bg-slate-800 h-[260px] flex">
                        <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-900 opacity-70" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <button onClick={() => setIsPlayingCompare1(!isPlayingCompare1)} className="bg-white/20 p-4 rounded-full backdrop-blur-sm hover:bg-white/30 transition">
                            {isPlayingCompare1 ? <Pause className="w-8 h-8 text-white" /> : <Play className="w-8 h-8 text-white ml-1" />}
                          </button>
                        </div>
                      </div>
                      <div className="p-4 bg-slate-50 border-t border-slate-100 h-[240px] overflow-y-auto custom-scrollbar">
                        <h4 className="font-extrabold text-slate-800 mb-3 flex items-center gap-2 text-[14px]">
                          <FileText className="w-4 h-4 text-blue-500" />
                          스크립트 (클릭 시 재생 위치 이동)
                        </h4>
                        <div className="space-y-2">
                          {STT_DATA.map((item, i) => (
                            <div
                              key={`s1-stt-${i}`}
                              onClick={() => setActiveCompareStt1(i)}
                              className={`flex gap-3 text-[13px] p-2.5 rounded-lg cursor-pointer transition-colors ${activeCompareStt1 === i ? 'bg-blue-100/50 text-blue-900 font-bold' : 'hover:bg-slate-200/50 text-slate-600'}`}
                            >
                              <span className="text-slate-400 font-bold shrink-0 w-10 mt-0.5">{item.time}</span>
                              <p className="leading-relaxed">{item.text}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* 세션 2 */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
                      <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 shrink-0">
                        <h3 className="font-bold text-slate-800 flex items-center gap-2">
                          <span className="bg-blue-100 text-blue-600 px-2 py-0.5 rounded text-xs">비교</span>
                          2회차 연습
                        </h3>
                      </div>
                      <div className="relative bg-slate-800 h-[260px] flex">
                        <div className="absolute inset-0 bg-gradient-to-br from-blue-900 to-slate-900 opacity-80" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <button onClick={() => setIsPlayingCompare2(!isPlayingCompare2)} className="bg-white/20 p-4 rounded-full backdrop-blur-sm hover:bg-white/30 transition">
                            {isPlayingCompare2 ? <Pause className="w-8 h-8 text-white" /> : <Play className="w-8 h-8 text-white ml-1" />}
                          </button>
                        </div>
                      </div>
                      <div className="p-4 bg-slate-50 border-t border-slate-100 h-[240px] overflow-y-auto custom-scrollbar">
                        <h4 className="font-extrabold text-slate-800 mb-3 flex items-center gap-2 text-[14px]">
                          <FileText className="w-4 h-4 text-blue-500" />
                          스크립트 (클릭 시 재생 위치 이동)
                        </h4>
                        <div className="space-y-2">
                          {STT_DATA.map((item, i) => (
                            <div
                              key={`s2-stt-${i}`}
                              onClick={() => setActiveCompareStt2(i)}
                              className={`flex gap-3 text-[13px] p-2.5 rounded-lg cursor-pointer transition-colors ${activeCompareStt2 === i ? 'bg-blue-100/50 text-blue-900 font-bold' : 'hover:bg-slate-200/50 text-slate-600'}`}
                            >
                              <span className="text-slate-400 font-bold shrink-0 w-10 mt-0.5">{item.time}</span>
                              <p className="leading-relaxed">{item.text}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 지표 비교 */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-indigo-100 text-indigo-600 p-1.5 rounded-xl"><BarChart2 className="w-5 h-5" /></span>
                      지표 비교
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                        );
                      })}
                    </div>
                  </div>

                  {/* AI 비교 피드백 */}
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                    <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2 mb-6">
                      <span className="bg-teal-100 text-teal-600 p-1.5 rounded-xl"><Lightbulb className="w-5 h-5" /></span>
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

              {/* VIEW 3: 종합추이 */}
              {activeMenu === 'growth' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 h-[650px] flex flex-col">
                    <div className="mb-6 border-b border-slate-100 pb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <h3 className="font-extrabold text-slate-800 text-xl flex items-center gap-2.5">
                          <span className="bg-green-100 text-green-600 p-1.5 rounded-xl shadow-sm"><TrendingUp className="w-5 h-5" /></span>
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

                    <div className="flex flex-wrap gap-3 mb-8">
                      {GROWTH_METRICS_CONFIG.map(metric => (
                        <button
                          key={metric.id}
                          onClick={() => setActiveGrowthMetric(metric.id)}
                          className={`px-5 py-2.5 rounded-xl text-[14px] font-bold transition-all border ${activeGrowthMetric === metric.id
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
                              <p className="font-bold text-[15px]">해당 주제의 발표 연습 기록이 없습니다.</p>
                            </div>
                          );
                        }

                        const growthChartData = activeTopicForGrowth.sessions.map((s, index) => {
                          const maxImprovementFactor = Math.max(1, 4 - index);
                          return {
                            session: s.name.replace(' 연습', ''),
                            fillerTotal: 10 + maxImprovementFactor * 5,
                            wpm: 120 + maxImprovementFactor * 10,
                            silenceRatio: 5 + maxImprovementFactor * 2,
                            habits: 4 + maxImprovementFactor * 3,
                          };
                        });

                        const activeMetricConfig = GROWTH_METRICS_CONFIG.find(m => m.id === activeGrowthMetric)!;

                        return (
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={growthChartData} margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                              <XAxis dataKey="session" axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 14, fontWeight: 600 }} dy={15} />
                              <YAxis
                                axisLine={false} tickLine={false}
                                tick={{ fill: activeMetricConfig.color, fontSize: 13, fontWeight: 700 }}
                                domain={['auto', 'auto']} dx={-10} unit={activeMetricConfig.unit}
                              />
                              <Tooltip
                                cursor={{ fill: '#f8fafc', stroke: activeMetricConfig.type === 'line' ? '#e2e8f0' : 'none', strokeWidth: 1, strokeDasharray: '4 4' }}
                                contentStyle={{ borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)', padding: '16px 20px', fontWeight: 600 }}
                                formatter={(value: number) => [`${value}${activeMetricConfig.unit}`, activeMetricConfig.label]}
                              />
                              {activeMetricConfig.type === 'line' ? (
                                <Line
                                  type="monotone" dataKey={activeMetricConfig.id} name={activeMetricConfig.label}
                                  stroke={activeMetricConfig.color} strokeWidth={4}
                                  dot={{ r: 6, fill: activeMetricConfig.color, strokeWidth: 3, stroke: '#fff' }} activeDot={{ r: 8 }}
                                />
                              ) : (
                                <Bar
                                  dataKey={activeMetricConfig.id} name={activeMetricConfig.label}
                                  fill={activeMetricConfig.color} radius={[6, 6, 0, 0]} barSize={40}
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
              <p className="text-sm mt-2">좌측 패널 &apos;내 기록&apos;에서 프로젝트 폴더를 열고 발표 연습을 선택해주세요.</p>
            </div>
          ) : null}
        </div>
      </main>

      {/* --- 모달 --- */}

      {/* 주제 추가 모달 */}
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
                onKeyDown={e => e.key === 'Enter' && addTopic()}
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

      {/* 세션 추가 모달 */}
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
                분석할 발표 영상과 대조할 슬라이드(PDF)를 업로드해주세요. 영상은 필수 항목입니다.
              </p>

              {/* 영상 — 클릭 시 촬영 페이지로 이동 */}
              <div>
                <label className="block text-[14px] font-bold text-slate-700 mb-2">
                  발표 영상 <span className="text-red-500">*</span>
                </label>
                <div
                  className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors
                    ${uploadedVideo ? 'border-blue-500 bg-blue-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'}`}
                  onClick={() => {
                    if (!uploadedVideo) {
                      router.push(`/record?topicId=${targetTopicId}`);
                    }
                  }}
                >
                  {uploadedVideo ? (
                    <>
                      <Video className="w-8 h-8 text-blue-500 mb-3" />
                      <p className="font-bold text-blue-700">{uploadedVideo}</p>
                      <button
                        onClick={(e) => { e.stopPropagation(); setUploadedVideo(null); }}
                        className="text-sm text-blue-400 hover:text-red-500 mt-1 transition-colors"
                      >
                        다시 촬영
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center mb-3">
                        <Upload className="w-6 h-6 text-slate-400" />
                      </div>
                      <p className="font-bold text-slate-600 text-[15px]">클릭하여 영상 촬영 시작</p>
                      <p className="text-sm text-slate-400 mt-1">카메라로 바로 촬영합니다</p>
                    </>
                  )}
                </div>
              </div>

              {/* PDF 업로드 */}
              <div>
                <label className="block text-[14px] font-bold text-slate-700 mb-2">발표 자료 (선택)</label>
                <div
                  className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-colors
                    ${uploadedPdf ? 'border-purple-500 bg-purple-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'}`}
                  onClick={() => setUploadedPdf(uploadedPdf ? null : 'slide_deck_final.pdf')}
                >
                  {uploadedPdf ? (
                    <>
                      <FileText className="w-7 h-7 text-purple-500 mb-2" />
                      <p className="font-bold text-purple-700">{uploadedPdf}</p>
                      <p className="text-sm text-purple-400 mt-1">클릭하여 제거</p>
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
              <button
                onClick={addSession}
                disabled={!uploadedVideo}
                className={`px-6 py-2.5 text-[14.5px] font-bold text-white rounded-xl transition-colors
                  ${uploadedVideo ? 'bg-blue-600 hover:bg-blue-700 shadow-sm' : 'bg-slate-300 cursor-not-allowed'}`}
              >
                분석 시작
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
