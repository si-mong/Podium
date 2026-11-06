"use client";

// 인터랙티브 스크립트 — 세션 전체(모든 구간) 발화 스크립트를 영상과 연결해서 보여준다.
//   - 문장을 누르면 영상이 그 시각으로 이동해서 재생된다.
//   - 영상이 재생되는 동안 지금 말하는 문장이 강조되고, 스크롤도 따라간다.
//   - 구간 버튼을 눌러도(대시보드 쪽에서 영상을 그 구간 시작으로 옮겨주면) 같은 방식으로 따라간다.
//   - 필러/반복/무음/동작 표시를 누르면 그 장면 1초 전부터 재생된다.
//   - plain 이면 "원본 스크립트" — 필러/반복/무음/동작 표시 없이 문장만 보여준다 (위의 재생·강조·스크롤은 그대로).
//   - 구간이 바뀌는 곳에 가로선을 긋는다 (두 스크립트 모두).
// 데이터: GET /sessions/{id}/script (문장·무음·필러·반복) + GET /sessions/{id}/analysis (동작 분석)

import React, { useEffect, useRef } from 'react';
import { MessageSquare, Repeat, Video } from 'lucide-react';

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
            className="inline-block mx-0.5 px-1 rounded bg-rose-50 text-rose-700 font-mono text-[0.88em] font-semibold hover:bg-rose-100 transition-colors"
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
  script: ScriptData | null;   // null = 아직 못 불러옴
  videoChunks: VideoChunk[];
  currentTime: number;         // 영상의 현재 재생 위치(초)
  isPlaying: boolean;
  onSeek: (sec: number) => void;
  plain?: boolean;             // true = 원본 스크립트 (문장만)
  segmentStarts?: number[];    // 각 구간의 시작 시각(초). 두 번째 구간부터 그 앞에 구분선을 긋는다.
  heightClass?: string;        // 스크립트 영역 높이 (기본 h-[400px]). 비교 분석은 내용만큼만 보이게 max-h 를 쓴다.
  sameSentences?: Set<string>; // 비교 분석: 다른 회차에도 있는 문장(normalizeSentence 형태). 노란 표시를 하고, 재생 중 강조는 회색으로 바꾼다.
}

/** 필러 한 개를 표시할 글. 모델 태그("<um>")나 음향 검출이면 어휘를 모르니 "필러"만. */
function fillerLabel(f: { text?: string | null }) {
  const word = f.text && !f.text.startsWith('<') ? f.text : '';
  return word ? `필러 '${word}'` : '필러';
}

/** 두 회차의 문장이 같은지 볼 때 쓰는 형태 — 띄어쓰기·문장부호 차이는 무시한다. */
export function normalizeSentence(text: string) {
  return text.replace(/[\s.,!?·…'"‘’“”~-]/g, '');
}

// 제스처·무음 앞에 붙는 작은 점
function Dot({ tone }: { tone: 'good' | 'bad' | 'muted' }) {
  const color = tone === 'good' ? 'bg-emerald-600' : tone === 'bad' ? 'bg-rose-600' : 'bg-stone-400';
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

// 세션 전체 스크립트로 줄을 만든다 (구간 필터 없음 — 처음부터 끝까지 다 보여준다).
// plain 이면 문장 줄만 만들고 필러/반복/무음/동작은 붙이지 않는다.
function buildRows(script: ScriptData, chunks: VideoChunk[], plain: boolean): Row[] {
  const rows: Row[] = script.sentences.map((s) => ({
    kind: 'sentence',
    t: s.t_start,
    end: s.t_end,
    text: s.text,
    fillers: [],
    repetitions: [],
  }));
  if (plain) return rows;

  // 필러·반복은 그것이 나온 시각에 말하던 문장(= 그 시각 이전에 시작한 마지막 문장) 아래에 붙인다.
  const owner = (t: number) => {
    let found = rows.find((r) => r.kind === 'sentence');
    for (const r of rows) {
      if (r.kind === 'sentence' && r.t <= t) found = r;
    }
    return found && found.kind === 'sentence' ? found : null;
  };
  for (const f of script.fillers) {
    owner(f.t_start)?.fillers.push({ label: fillerLabel(f), at: f.t_start });
  }
  for (const r of script.repetitions) {
    owner(r.t_start)?.repetitions.push({ label: r.text ? `반복 '${r.text}'` : '반복', at: r.t_start });
  }

  for (const s of script.silences.filter((s) => s.duration >= MIN_SILENCE_SEC)) {
    rows.push({ kind: 'silence', t: s.t_start, duration: s.duration });
  }
  for (const c of chunks) {
    rows.push({ kind: 'motion', t: c.t_start, chunk: c });
  }

  return rows.sort((a, b) => a.t - b.t);
}

export default function InteractiveScript({ script, videoChunks, currentTime, isPlaying, onSeek, plain = false, segmentStarts = [], heightClass = 'h-[400px]', sameSentences }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const rows = script ? buildRows(script, videoChunks, plain) : [];

  // 구분선을 그을 줄 번호 = 각 구간(첫 구간 제외)이 시작한 뒤 나오는 첫 줄.
  // 구간 시작은 문장 시작 시각과 같아서 소수점 오차만 조금 봐준다.
  const dividerBefore = new Set<number>();
  for (const start of segmentStarts.slice(1)) {
    const idx = rows.findIndex((r) => r.t >= start - 0.01);
    if (idx > 0) dividerBefore.add(idx);
  }

  // 지금 재생 중인 문장 = 시작 ≤ 현재 위치 < 끝
  const activeIndex = rows.findIndex((r) => r.kind === 'sentence' && r.t <= currentTime && currentTime < r.end);

  // 재생 중에는 지금 문장이 보이도록 스크립트 영역 안에서만 스크롤한다 (페이지 전체가 움직이지 않게).
  // 구간 버튼을 눌러서 영상이 그 구간 시작으로 옮겨갈 때도, 재생이 시작되며 이 effect가 그대로 따라가 준다.
  useEffect(() => {
    const box = containerRef.current;
    const el = activeRef.current;
    if (!isPlaying || !box || !el) return;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }, [activeIndex, isPlaying, plain]);

  if (!script || script.sentences.length === 0) {
    return <p className="text-sm text-stone-400 font-medium py-6 text-center">이 세션에는 음성 분석(스크립트) 결과가 없습니다.</p>;
  }

  return (
    // relative: 안쪽 줄의 offsetTop 이 이 박스 기준이 되도록 (자동 스크롤 계산용)
    // h-[400px](기본): 대략 10줄 정도가 보이는 높이. 그 이상은 스크롤로 본다.
    <div ref={containerRef} className={`relative space-y-1 ${heightClass} overflow-y-auto custom-scrollbar pr-1`}>
      {rows.map((row, i) => {
        const time = <span className="text-stone-400 font-mono shrink-0 w-12 pt-px text-[14px]">{fmtTime(row.t)}</span>;
        // 새 구간의 첫 줄이면 위쪽에 얇은 구분선. 바깥 박스의 space-y 가 위 여백을 덮어쓰므로 !mt-3 으로 강제한다.
        const divider = dividerBefore.has(i) ? 'border-t border-stone-200 !mt-3 pt-3' : '';

        if (row.kind === 'sentence') {
          const isActive = i === activeIndex;
          const isSame = sameSentences?.has(normalizeSentence(row.text));
          const activeBg = sameSentences ? 'bg-stone-100' : 'bg-yellow-100';
          return (
            <div key={`s-${i}`} ref={isActive ? activeRef : null} className={divider}>
              <div className={`flex gap-2 px-2 py-1.5 rounded transition-colors text-[15.5px] ${isActive ? activeBg : 'hover:bg-stone-50'}`}>
                {time}
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => onSeek(row.t)}
                    title="이 문장부터 재생"
                    className={`text-left leading-relaxed ${isActive && !sameSentences ? 'font-semibold text-stone-900' : 'font-medium text-stone-800'}`}
                  >
                    {isSame ? <mark className="bg-yellow-200 text-stone-900 rounded-sm px-0.5 [box-decoration-break:clone]">{row.text}</mark> : row.text}
                  </button>
                  {(row.fillers.length > 0 || row.repetitions.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {row.fillers.map((chip, k) => (
                        <button
                          key={`f-${k}`}
                          onClick={() => onSeek(Math.max(0, chip.at - LEAD_SEC))}
                          className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full text-[13px] font-bold border border-orange-200 inline-flex items-center gap-1 hover:bg-orange-200 transition-colors"
                        >
                          <MessageSquare className="w-3 h-3" />
                          {chip.label} · {fmtTime(chip.at)}
                        </button>
                      ))}
                      {row.repetitions.map((chip, k) => (
                        <button
                          key={`r-${k}`}
                          onClick={() => onSeek(Math.max(0, chip.at - LEAD_SEC))}
                          className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[13px] font-bold border border-amber-200 inline-flex items-center gap-1 hover:bg-amber-200 transition-colors"
                        >
                          <Repeat className="w-3 h-3" />
                          {chip.label} · {fmtTime(chip.at)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }

        if (row.kind === 'silence') {
          return (
            <div key={`sil-${i}`} className={divider}>
              <div className="flex gap-2 px-2 py-0.5">
                <span className="shrink-0 w-12" />
                <button
                  onClick={() => onSeek(Math.max(0, row.t - LEAD_SEC))}
                  title={`${fmtTime(row.t)}부터 재생`}
                  className="inline-flex items-center gap-1.5 text-[14px] font-medium text-stone-500 hover:text-stone-800 transition-colors"
                >
                  <Dot tone="muted" />
                  무음 {row.duration.toFixed(1)}초
                </button>
              </div>
            </div>
          );
        }

        // 동작 분석 조각 (구간 기준 최대 1분 단위 — 제스처 하나하나의 시각은 알 수 없고, 그 조각 안에서 센 횟수만 안다)
        const counts = Object.entries(row.chunk.gesture_counts || {}).filter(([, n]) => n > 0);
        const eye = row.chunk.eye_contact;
        return (
          <div key={`m-${i}`} className={divider}>
            <div className="flex gap-2 px-2 py-1">
              {time}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                <button
                  onClick={() => onSeek(Math.max(0, row.t - LEAD_SEC))}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-stone-300 bg-white text-[13px] font-semibold text-stone-700 whitespace-nowrap hover:bg-stone-100 transition-colors"
                  title="이 동작 분석 구간부터 재생"
                >
                  <Video className="w-3.5 h-3.5" />
                  동작 {fmtTime(row.chunk.t_start)}~{fmtTime(row.chunk.t_end)}
                </button>
                {counts.map(([key, n]) => {
                  const info = GESTURE_LABELS[key];
                  const positive = info ? info.positive : true;
                  return (
                    <span key={key} className={`inline-flex items-center gap-1.5 text-[14px] font-semibold ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>
                      <Dot tone={positive ? 'good' : 'bad'} />
                      {info ? info.label : key} {n}회
                    </span>
                  );
                })}
                {(row.chunk.posture || eye) && (
                  <span className="text-[13px] text-stone-500 font-medium">
                    {[row.chunk.posture && `자세 ${row.chunk.posture}`, eye && `시선 ${eye}`].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
