"use client";

// 분석하는 항목 — 실제 분석 화면의 「구간별 지표」를 그대로 줄여 놓은 카드.
// 위쪽 탭(발화 속도 … 자세)을 고르면 왼쪽 숫자와 오른쪽 꺾은선이 같이 바뀐다.
//   - 아무것도 안 하면 4초마다 다음 항목으로 혼자 넘어간다 (마우스를 올리면 멈춤).
//   - 탭을 한 번 누르면 자동 넘김을 끄고 고른 항목에 머문다.
//   - 화면에 들어올 때마다 아래에서 솟아오르며 나타난다 (스크롤을 올렸다 내려도 다시).
//   - "애니메이션 줄이기"를 켠 사용자: 자동 넘김·기울기 없이 바로 선 카드로 보여준다.
// 숫자는 전부 보여주기용 예시다 (서버를 부르지 않음).

import { useEffect, useRef, useState } from "react";

const SEGS = ["도입", "배경", "문제제시", "핵심개념", "해결방안", "마무리"];

type Tab = {
  name: string;
  label: string;
  unit: string;
  vals: number[];
  total: string;
  note: string;
  desc: string;
  base: number; // 꺾은선의 바닥값 (발화 속도만 0 이 아니다)
};

const TABS: Tab[] = [
  { name: "필러", label: "필러 단어 빈도", unit: "회", vals: [0, 0, 0, 1, 1, 0], total: "2", note: "최다 구간 · 핵심개념 · 해결방안", desc: "‘음’, ‘어’ 같은 군말이 언제, 몇 번 나왔는지 세어 줘요.", base: 0 },
  { name: "무음", label: "전체 무음 시간", unit: "초", vals: [0, 4.8, 7.6, 2.0, 1.2, 0], total: "15.6", note: "가장 긴 구간 · 문제제시", desc: "말이 길게 끊긴 곳을 찾아 흐름이 멈춘 지점을 짚어 줘요.", base: 0 },
  { name: "반복", label: "반복한 말", unit: "회", vals: [1, 0, 2, 0, 1, 0], total: "4", note: "최다 구간 · 문제제시", desc: "같은 말을 되풀이한 곳을 찾아 대본에 표시해 줘요.", base: 0 },
  { name: "제스처", label: "설명 제스처", unit: "회", vals: [0, 2, 4, 1, 1, 0], total: "8", note: "최다 구간 · 문제제시", desc: "손동작이 언제, 얼마나 자주 나왔는지 구간별로 보여줘요.", base: 0 },
  { name: "시선", label: "정면 응시 비율", unit: "%", vals: [22, 30, 71, 18, 25, 20], total: "31", note: "가장 좋은 구간 · 문제제시", desc: "청중(카메라)을 바라보는지, 자료만 보고 있는지 확인해요.", base: 0 },
  { name: "자세", label: "얼굴·머리 만지기", unit: "회", vals: [0, 1, 1, 1, 1, 0], total: "4", note: "0:34 · 2:44 · 3:15 · 3:51", desc: "몸이 기울거나 흔들리지 않고 안정적인지 살펴봐요.", base: 0 },
  { name: "발화 속도", label: "평균 말하기 속도", unit: "음절/분", vals: [298, 305, 342, 361, 337, 372], total: "336", note: "가장 빠른 구간 · 마무리", desc: "1분에 몇 음절을 말하는지 재서 너무 빠르거나 느린 구간을 알려줘요.", base: 260 },
];

// 그래프 자리 (viewBox 640×230)
const X0 = 86;
const DX = 93.6;
const YTOP = 40;
const YBOT = 190;
const AUTO_MS = 4000; // 혼자 다음 항목으로 넘어가는 간격
const MORPH_MS = 420; // 항목이 바뀔 때 선이 옮겨 가는 시간
const RESUME_MS = 9000; // 탭을 누른 뒤 자동 넘김이 다시 켜지기까지

// 카드는 늘 조금 비스듬히 놓여 있고(REST), 화면 밖에서는 더 많이 돌아간 채 멀리·흐리게 있다가(HIDDEN) 날아온다
const REST = "perspective(2200px) rotateY(6deg) rotateX(2.5deg) rotateZ(-0.8deg)";
const HIDDEN = "perspective(2200px) rotateY(26deg) rotateX(11deg) rotateZ(-3.5deg) translate3d(60px, 150px, -200px) scale(0.82)";
// 좁은 화면에서는 기울이지 않는다 (가뜩이나 좁은데 글씨가 더 안 읽힌다)
const REST_NARROW = "none";
const HIDDEN_NARROW = "translate3d(0, 120px, 0) scale(0.88)";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

// 값들을 그래프 높이로 바꾼다 (가장 큰 값이 위쪽에 여유를 두고 닿게)
function toY(tab: Tab) {
  const max = Math.max(...tab.vals);
  const span = Math.max(1, max - tab.base) * 1.15;
  return tab.vals.map((v) => YBOT - ((v - tab.base) / span) * (YBOT - YTOP));
}

// 점들을 부드러운 곡선으로 잇는다
function curve(pts: [number, number][]) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export default function SegmentMetrics() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState(0);
  const [prev, setPrev] = useState(0);
  const [p, setP] = useState(1); // 0 = 이전 항목 모양, 1 = 지금 항목 모양
  const [auto, setAuto] = useState(true);
  const [shown, setShown] = useState(false);
  const [wide, setWide] = useState(false); // 넓은 화면에서만 비스듬히 놓는다
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 혼자 다음 항목으로 (마우스를 올려도 멈추지 않는다 — 읽는 동안 멈춰 버리면 고장 난 것처럼 보인다)
  useEffect(() => {
    if (!auto || reduce) return;
    const t = setTimeout(() => {
      setPrev(tab);
      setTab((i) => (i + 1) % TABS.length);
    }, AUTO_MS);
    return () => clearTimeout(t);
  }, [auto, reduce, tab]);

  // 탭을 직접 누르면 잠시 멈췄다가 다시 혼자 돈다
  useEffect(() => {
    if (auto) return;
    const t = setTimeout(() => setAuto(true), RESUME_MS);
    return () => clearTimeout(t);
  }, [auto]);

  // 화면에 들어올 때마다 떠오르며 나타난다 (올렸다 내려도 다시 나온다)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (reduce) {
      setShown(true);
      return;
    }
    // 화면 밖으로 나가면 다시 숨겨 둔다 — 올렸다 내릴 때마다 효과가 다시 나오게
    const io = new IntersectionObserver(([e]) => setShown(e.isIntersecting), { rootMargin: "0px 0px -18% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);

  // 항목이 바뀌면 선이 옮겨 가는 동안만 다시 그린다
  useEffect(() => {
    if (reduce) {
      setP(1);
      return;
    }
    setP(0);
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = clamp01((now - t0) / MORPH_MS);
      setP(k);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tab, reduce]);

  const cur = TABS[tab];
  const y0 = toY(TABS[prev]);
  const y1 = toY(cur);
  const maxI = cur.vals.indexOf(Math.max(...cur.vals));
  const pts = SEGS.map((seg, i) => ({
    x: X0 + DX * i,
    y: lerp(y0[i], y1[i], ease(p)),
    val: cur.vals[i],
    show: p > 0.9 && (cur.base > 0 || cur.vals[i] > 0),
    seg,
    strong: i === maxI,
  }));

  const pick = (i: number) => {
    setPrev(tab);
    setTab(i);
    setAuto(false);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:gap-14">
      {/* 오른쪽 — 제목과 설명 (좁은 화면에서는 카드보다 먼저 나온다) */}
      <div
        className={`min-w-0 lg:order-2 motion-safe:transition-all motion-safe:duration-700 ${
          shown ? "" : "motion-safe:translate-y-10 motion-safe:opacity-0"
        }`}
        style={{ transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
        <p className="text-[15px] font-extrabold text-teal-700">분석하는 항목</p>
        <h2 className="mt-4 text-4xl font-extrabold tracking-[-0.045em] leading-[1.12] text-stone-900">
          일곱 가지를,
          <br />
          구간마다 잽니다.
        </h2>
        <p className="mt-5 text-[17px] leading-relaxed text-stone-500">
          발표를 내용 흐름대로 나눈 뒤, 구간마다 말과 몸짓을 따로 셉니다. 이게 실제 분석 화면의 「구간별 지표」예요.
        </p>
      </div>

      <div ref={wrapRef} className="min-w-0 lg:order-1 lg:px-3">
        <div
          className="rounded-2xl border border-slate-200 bg-white px-5 pb-6 pt-5 shadow-2xl shadow-slate-500/25 sm:px-7"
          style={
            reduce
              ? undefined
              : {
                  transform: shown ? (wide ? REST : REST_NARROW) : wide ? HIDDEN : HIDDEN_NARROW,
                  opacity: shown ? 1 : 0,
                  filter: shown ? "none" : "blur(18px)",
                  transformOrigin: "70% 50%",
                  transition:
                    "transform 1050ms cubic-bezier(0.16, 1, 0.3, 1) 120ms, opacity 820ms ease-out 120ms, filter 820ms ease-out 120ms",
                  willChange: "transform",
                }
          }
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-base font-extrabold text-stone-900">구간별 지표</span>
            <span className="text-[13px] text-stone-400">예시 발표 · 1회차 연습</span>
          </div>

          {/* 항목 탭 */}
          <div role="tablist" aria-label="분석 항목" className="mt-4 flex gap-5 overflow-x-auto border-b border-slate-200">
            {TABS.map((t, i) => {
              const on = i === tab;
              return (
                <button
                  key={t.name}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => pick(i)}
                  className={`h-11 shrink-0 whitespace-nowrap text-[15px] transition-colors ${
                    on ? "font-extrabold text-stone-900 shadow-[inset_0_-2px_0_currentColor]" : "font-medium text-stone-400 hover:text-stone-600"
                  }`}
                >
                  {t.name}
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-7">
            {/* 왼쪽 — 숫자 */}
            <div className="min-w-0 flex-[1_1_210px]">
              <div className="text-sm text-stone-500">{cur.label} · 전체</div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="text-4xl font-extrabold tracking-[-0.04em] text-stone-900 tabular-nums">{cur.total}</span>
                <span className="text-lg font-extrabold text-stone-500">{cur.unit}</span>
              </div>
              <div className="mt-1 text-sm text-stone-500">{cur.note}</div>
              <p className="mt-4 border-t border-slate-200 pt-3.5 text-[14px] leading-relaxed text-stone-600">{cur.desc}</p>
            </div>

            {/* 오른쪽 — 구간별 꺾은선 */}
            <div className="min-w-0 flex-[999_1_380px]">
              <svg viewBox="0 0 640 230" className="block h-auto w-full" role="img" aria-label={`${cur.label} 구간별 그래프`}>
                <rect x={X0 + DX * maxI - 46} y="10" width="92" height="180" className="fill-stone-100" />
                {[40, 90, 140].map((y) => (
                  <line key={y} x1="40" y1={y} x2="620" y2={y} className="stroke-stone-100" />
                ))}
                <line x1="40" y1="190" x2="620" y2="190" className="stroke-stone-200" />
                <path d={curve(pts.map((q) => [q.x, q.y] as [number, number]))} fill="none" className="stroke-rose-600" strokeWidth="2.5" strokeLinecap="round" />
                {pts.map((q) => (
                  <g key={q.seg}>
                    <circle cx={q.x} cy={q.y} r="5.5" className="fill-white stroke-rose-600" strokeWidth="2.5" />
                    {q.show && (
                      <text x={q.x} y={q.y - 14} textAnchor="middle" fontSize="13" fontWeight="700" className="fill-rose-700">
                        {fmt(q.val)}
                      </text>
                    )}
                    <text x={q.x} y="216" textAnchor="middle" fontSize="14" fontWeight={q.strong ? 800 : 500} className="fill-stone-600">
                      {q.seg}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
