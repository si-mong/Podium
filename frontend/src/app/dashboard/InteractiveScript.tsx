"use client";

// 인터랙티브 스크립트 — 구간 하나의 발화 스크립트를 영상과 연결해서 보여준다.
//   - 문장을 누르면 영상이 그 시각으로 이동해서 재생된다.
//   - 영상이 재생되는 동안 지금 말하는 문장이 강조되고, 스크롤도 따라간다.
//   - 필러/반복/무음/동작 표시를 누르면 그 장면 1초 전부터 재생된다.
// 데이터: GET /sessions/{id}/script (문장·무음·필러·반복) + GET /sessions/{id}/analysis (동작 분석)

import React, { useEffect, useRef } from 'react';
import { AlertCircle, Clock, MessageSquare, Repeat, ThumbsUp, Video } from 'lucide-react';

// --- 백엔드 응답 형태 (app/schemas/session.py) ---
export interface ScriptData {
  sentences: { t_start: number; t_end: number; text: string }[];
  silences: { t_start: number; t_end: number; duration: number }[];
  fillers: { t_start: number; t_end: number; text?: string | null; source?: string | null }[];
  repetitions: { t_start: number; t_end: number; text?: string | null; count?: number | null }[];
}

export interface VideoChunk {
  t_start: number;
  t_end: number;
  posture: string | null;
  eye_contact: string | null;
  gesture_counts: Record<string, number> | null;
}

// 동작 분석 gesture_counts 7종의 화면 표시 이름. positive 는 잘한 동작(파랑), 아니면 주의 동작(빨강).
const GESTURE_LABELS: Record<string, { label: string; positive: boolean }> = {
  explanatory_gesture: { label: '설명 제스처', positive: true },
  pointing: { label: '가리키기', positive: true },
  body_movement: { label: '몸 움직임', positive: true },
  distracting_gesture: { label: '산만한 제스처', positive: false },
  touching_face_or_hair: { label: '얼굴·머리 만지기', positive: false },
  fidgeting_with_objects: { label: '물건 만지작거리기', positive: false },
  closed_posture: { label: '닫힌 자세', positive: false },
};

// 이 길이(초)보다 짧은 무음은 스크립트에 표시하지 않는다 (호흡 정도의 짧은 쉼까지 다 보이면 어수선함).
const MIN_SILENCE_SEC = 1.0;

// 필러/반복/무음/동작을 눌렀을 때 그 장면보다 앞서 시작할 초 — 직전 말부터 들려야 맥락이 보인다.
const LEAD_SEC = 1.0;

/** 초 → "M:SS" */
export function fmtTime(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 글 속의 "0:19" 또는 "0:19~0:35" 같은 시각. 첫 번째 시각을 이동 위치로 쓴다.
const TIME_PATTERN = /(\d{1,2}:\d{2}(?:~\d{1,2}:\d{2})?)/;

function parseTime(text: string) {
  const [m, s] = text.split('~')[0].split(':').map(Number);
  return m * 60 + s;
}

/** 글 속의 시각(예: "0:19~0:35")을 누를 수 있는 버튼으로 바꿔서 보여준다. 누르면 그 시각으로 이동. */
export function TimestampText({ text, onSeek }: { text: string; onSeek: (sec: number) => void }) {
  // split 에 괄호를 쓰면 시각 부분도 결과에 남는다 → 홀수 번째가 시각.
  const parts = text.split(TIME_PATTERN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation(); // 바깥 카드의 클릭(구간 선택)까지 같이 실행되지 않게
              onSeek(parseTime(part));
            }}
            className="inline-block mx-0.5 px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 text-[12px] font-bold hover:bg-blue-100 transition-colors"
          >
            {part}
          </button>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
}

// 문장 아래에 붙는 작은 표시(필러/반복). label 은 화면 글자, at 은 그 일이 일어난 시각(초).
interface Chip {
  label: string;
  at: number;
}

// 스크립트 한 줄. 종류에 따라 필요한 값만 가진다.
type Row =
  | { kind: 'sentence'; t: number; end: number; text: string; fillers: Chip[]; repetitions: Chip[] }
  | { kind: 'silence'; t: number; duration: number }
  | { kind: 'motion'; t: number; chunk: VideoChunk };

interface Props {
  segment: { t_start: number; t_end: number; isLast: boolean } | null; // 보여줄 구간 (없으면 안내 문구)
  script: ScriptData | null;   // null = 아직 못 불러옴
  videoChunks: VideoChunk[];
  currentTime: number;         // 영상의 현재 재생 위치(초)
  isPlaying: boolean;
  onSeek: (sec: number) => void;
}

/** 필러 한 개를 표시할 글. 모델 태그("<um>")나 음향 검출이면 어휘를 모르니 "필러"만. */
function fillerLabel(f: { text?: string | null }) {
  const word = f.text && !f.text.startsWith('<') ? f.text : '';
  return word ? `필러: ${word}` : '필러';
}

function buildRows(segment: NonNullable<Props['segment']>, script: ScriptData, chunks: VideoChunk[]): Row[] {
  // 구간에 속하는지는 "시작 시각" 기준으로 판단한다 (STEP 4 집계와 같은 규칙). 마지막 구간은 끝 시각도 포함.
  const inSegment = (t: number) => t >= segment.t_start && (t < segment.t_end || segment.isLast);

  const sentences = script.sentences.filter((s) => inSegment(s.t_start));
  const rows: Row[] = sentences.map((s) => ({
    kind: 'sentence',
    t: s.t_start,
    end: s.t_end,
    text: s.text,
    fillers: [],
    repetitions: [],
  }));

  // 필러·반복은 그것이 나온 시각에 말하던 문장(= 그 시각 이전에 시작한 마지막 문장) 아래에 붙인다.
  const owner = (t: number) => {
    let found = rows.find((r) => r.kind === 'sentence');
    for (const r of rows) {
      if (r.kind === 'sentence' && r.t <= t) found = r;
    }
    return found && found.kind === 'sentence' ? found : null;
  };
  for (const f of script.fillers.filter((f) => inSegment(f.t_start))) {
    owner(f.t_start)?.fillers.push({ label: fillerLabel(f), at: f.t_start });
  }
  for (const r of script.repetitions.filter((r) => inSegment(r.t_start))) {
    owner(r.t_start)?.repetitions.push({ label: r.text ? `반복: ${r.text}` : '반복', at: r.t_start });
  }

  for (const s of script.silences.filter((s) => inSegment(s.t_start) && s.duration >= MIN_SILENCE_SEC)) {
    rows.push({ kind: 'silence', t: s.t_start, duration: s.duration });
  }
  for (const c of chunks.filter((c) => inSegment(c.t_start))) {
    rows.push({ kind: 'motion', t: c.t_start, chunk: c });
  }

  return rows.sort((a, b) => a.t - b.t);
}

export default function InteractiveScript({ segment, script, videoChunks, currentTime, isPlaying, onSeek }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const rows = segment && script ? buildRows(segment, script, videoChunks) : [];

  // 지금 재생 중인 문장 = 시작 ≤ 현재 위치 < 끝
  const activeIndex = rows.findIndex((r) => r.kind === 'sentence' && r.t <= currentTime && currentTime < r.end);

  // 재생 중에는 지금 문장이 보이도록 스크립트 영역 안에서만 스크롤한다 (페이지 전체가 움직이지 않게).
  useEffect(() => {
    const box = containerRef.current;
    const el = activeRef.current;
    if (!isPlaying || !box || !el) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }, [activeIndex, isPlaying]);

  if (!segment) {
    return <p className="text-sm text-slate-400 font-medium py-6 text-center">구간 분석이 끝나면 스크립트가 표시됩니다.</p>;
  }
  if (!script || script.sentences.length === 0) {
    return <p className="text-sm text-slate-400 font-medium py-6 text-center">이 세션에는 음성 분석(스크립트) 결과가 없습니다.</p>;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400 font-medium py-6 text-center">이 구간에는 표시할 스크립트가 없습니다.</p>;
  }

  return (
    // relative: 안쪽 줄의 offsetTop 이 이 박스 기준이 되도록 (자동 스크롤 계산용)
    <div ref={containerRef} className="relative space-y-2 max-h-[320px] overflow-y-auto custom-scrollbar pr-2">
      {rows.map((row, i) => {
        const time = <span className="text-slate-400 font-bold shrink-0 w-12 pt-1 text-[13px]">{fmtTime(row.t)}</span>;

        if (row.kind === 'sentence') {
          const isActive = i === activeIndex;
          return (
            <div key={`s-${i}`} ref={isActive ? activeRef : null} className="flex gap-3 text-[14px]">
              {time}
              <div className="flex-1">
                <button
                  onClick={() => onSeek(row.t)}
                  title="이 문장부터 재생"
                  className={`text-left leading-relaxed font-medium rounded-lg px-2 py-1 -mx-2 transition-colors ${
                    isActive ? 'bg-yellow-100 text-slate-900' : 'text-slate-700 hover:bg-blue-50'
                  }`}
                >
                  {row.text}
                </button>
                {(row.fillers.length > 0 || row.repetitions.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {row.fillers.map((chip, k) => (
                      <button
                        key={`f-${k}`}
                        onClick={() => onSeek(Math.max(0, chip.at - LEAD_SEC))}
                        className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded-lg text-xs font-bold border border-orange-200 inline-flex items-center gap-1 hover:bg-orange-200 transition-colors"
                      >
                        <MessageSquare className="w-3 h-3" />
                        {chip.label} · {fmtTime(chip.at)}
                      </button>
                    ))}
                    {row.repetitions.map((chip, k) => (
                      <button
                        key={`r-${k}`}
                        onClick={() => onSeek(Math.max(0, chip.at - LEAD_SEC))}
                        className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-lg text-xs font-bold border border-amber-200 inline-flex items-center gap-1 hover:bg-amber-200 transition-colors"
                      >
                        <Repeat className="w-3 h-3" />
                        {chip.label} · {fmtTime(chip.at)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        }

        if (row.kind === 'silence') {
          return (
            <div key={`sil-${i}`} className="flex gap-3 text-[14px]">
              {time}
              <button
                onClick={() => onSeek(Math.max(0, row.t - LEAD_SEC))}
                className="bg-slate-200 text-slate-600 px-2.5 py-1 rounded-lg text-xs font-bold border border-slate-300 inline-flex items-center gap-1.5 hover:bg-slate-300 transition-colors"
              >
                <Clock className="w-3.5 h-3.5" />
                무음 {row.duration.toFixed(1)}초
              </button>
            </div>
          );
        }

        // 동작 분석 조각 (약 20초 단위 — 제스처 하나하나의 시각은 알 수 없고, 그 조각 안에서 센 횟수만 안다)
        const counts = Object.entries(row.chunk.gesture_counts || {}).filter(([, n]) => n > 0);
        return (
          <div key={`m-${i}`} className="flex gap-3 text-[14px]">
            {time}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => onSeek(Math.max(0, row.t - LEAD_SEC))}
                className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-lg text-xs font-bold border border-slate-200 inline-flex items-center gap-1 hover:bg-slate-200 transition-colors"
                title="이 동작 분석 구간부터 재생"
              >
                <Video className="w-3 h-3" />
                동작 {fmtTime(row.chunk.t_start)}~{fmtTime(row.chunk.t_end)}
              </button>
              {counts.map(([key, n]) => {
                const info = GESTURE_LABELS[key];
                const positive = info ? info.positive : true;
                return (
                  <span
                    key={key}
                    className={`px-2 py-0.5 rounded-lg text-xs font-bold border inline-flex items-center gap-1 ${
                      positive ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                    }`}
                  >
                    {positive ? <ThumbsUp className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                    {info ? info.label : key} {n}회
                  </span>
                );
              })}
              {(row.chunk.posture || row.chunk.eye_contact) && (
                <span className="text-xs text-slate-500 font-medium">
                  {[row.chunk.posture && `자세 ${row.chunk.posture}`, row.chunk.eye_contact && `시선 ${row.chunk.eye_contact}`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
