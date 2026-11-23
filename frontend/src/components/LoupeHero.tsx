"use client";

// 첫 화면 히어로 — 왼쪽에 제목, 오른쪽에 "AI의 눈" 돋보기 (ServiceGuide 가 쓴다).
//   아래 칸: 발표하는 장면 그림 (public/presenter.webp — 사람 + 발표 자료 화면). 그냥 발표 영상처럼 보인다.
//   위 칸: 같은 그림을 어둡게 깔고 그 위에 시선·자세·제스처·목소리 파형·자막을 그린다.
//          커서 둘레만 동그랗게 뚫려서, 돋보기 안에서만 보인다.
// 즉 "사람 눈엔 그냥 영상, AI 눈엔 데이터" 를 한 그림으로 보여준다.
//
// 돋보기 움직임:
//   - 커서(손가락)를 올리면 돋보기가 따라온다. 부드럽게 따라가도록 매 프레임 조금씩 다가간다.
//   - 커서가 없으면 볼거리(얼굴 → 목소리 → 자막 → 제스처) 사이를 천천히 미끄러지듯 혼자 돌아다닌다.
//   - "애니메이션 줄이기"를 켠 사용자: 혼자 돌아다니지 않고, 커서를 따라갈 때도 바로 그 자리로 간다.
//   - 「분석 레이어 전체 보기」를 누르면 돋보기 없이 전부 보인다 (키보드 사용자·터치 사용자용).
//
// 그림 안의 숫자·문장은 전부 보여주기용 예시다 (서버를 부르지 않음).
// 분석 레이어 색은 라이트/다크에서 똑같이 보이도록 Tailwind 색 이름 대신 색값을 직접 적었다.
// (tailwind.config.ts 가 색 이름을 다크 모드에서 뒤집기 때문)
//
// 좌표 메모: 그림판은 1000×620. 발표 장면 그림(원본 1400×857)은 x 30, y 24 에 940×575 로 놓았고,
// 아래 분석 레이어의 숫자는 그 그림 위에서 직접 잰 눈·어깨·손 위치다. 그림을 바꾸면 이 숫자도 전부 다시 재야 한다.

import { useCallback, useEffect, useRef, useState } from "react";
import GoogleLogo from "./GoogleLogo";

// 그림판 전체는 1000×620. 좁은 화면에서는 글씨가 너무 작아져서 사람 쪽(430,40 부터 570×570)만 잘라 크게 보여준다.
const VIEW_WIDE = "0 0 1000 620";
const VIEW_NARROW = "430 50 570 570";

// 돋보기가 혼자 돌아다닐 때 들르는 볼거리 (보이는 범위의 가로·세로를 1 로 봤을 때의 위치)
const SPOTS_WIDE = [
  { x: 0.7, y: 0.252 }, // 얼굴(시선)
  { x: 0.24, y: 0.403 }, // 목소리 파형
  { x: 0.5, y: 0.827 }, // 자막
  { x: 0.538, y: 0.339 }, // 제스처(자료를 가리키는 손)
];
const SPOTS_NARROW = [
  { x: 0.483, y: 0.186 },
  { x: 0.203, y: 0.281 },
  { x: 0.483, y: 0.812 },
  { x: 0.659, y: 0.396 },
];
const LEG_MS = 2800; // 볼거리 한 곳에서 다음 곳까지 미끄러지는 시간
const HOLD_MS = 900; // 도착해서 잠깐 머무는 시간

// 발표 장면 그림을 놓는 자리 (그림판 좌표). 원본 1400×857.
const FIG = { x: 30, y: 24, w: 940, h: 575 };

interface Props {
  primaryAction: { label: string; onClick: () => void; google?: boolean }; // google: 구글 로고가 붙은 흰 버튼으로
  secondaryAction?: { label: string; onClick: () => void };
}

export default function LoupeHero({ primaryAction, secondaryAction }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLDivElement>(null); // 돋보기 안쪽 — 살짝 확대해서 유리처럼 보이게 한다
  const ringRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  const [moved, setMoved] = useState(false); // 한 번이라도 커서를 올렸는지 (안내 문구 숨김용)
  const [narrow, setNarrow] = useState(false); // 좁은 화면이면 그림을 잘라 크게 보여준다
  const [touch, setTouch] = useState(false); // 커서가 없는 기기면 안내 문구를 바꾼다
  const [reduce, setReduce] = useState(false);
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  // 지금 위치(pos)가 목표(target)로 조금씩 따라간다
  const pos = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const following = useRef(false); // 커서를 따라가는 중인지

  // 돋보기를 지금 위치에 그린다
  const draw = useCallback(() => {
    const box = boxRef.current;
    const layer = layerRef.current;
    const lens = lensRef.current;
    const ring = ringRef.current;
    if (!box || !layer || !lens || !ring) return;
    const all = showAllRef.current;
    const r = Math.min(104, Math.max(50, box.clientWidth * 0.135)); // 돋보기 반지름 — 틀 크기를 따라간다
    const { x, y } = pos.current;
    // 바깥: 동그랗게 뚫린 창 / 안쪽: 그 자리를 중심으로 조금 확대 → 진짜 렌즈처럼 보인다
    layer.style.clipPath = all ? "none" : `circle(${r}px at ${x}px ${y}px)`;
    lens.style.transformOrigin = `${x}px ${y}px`;
    lens.style.transform = all ? "none" : "scale(1.14)";
    ring.style.width = ring.style.height = `${r * 2}px`;
    ring.style.transform = `translate(${x - r}px, ${y - r}px)`;
    ring.style.opacity = all ? "0" : "1";
  }, []);

  // 좁은 화면인지 / 커서가 없는 기기인지 / 애니메이션을 줄였는지
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    setTouch(window.matchMedia("(hover: none)").matches);
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const spots = () => (narrowRef.current ? SPOTS_NARROW : SPOTS_WIDE);
    const toPx = (s: { x: number; y: number }) => ({ x: box.clientWidth * s.x, y: box.clientHeight * s.y });
    const smooth = (t: number) => t * t * (3 - 2 * t); // 출발·도착이 느린 곡선

    // 혼자 돌아다닐 때는 "다음 볼거리까지 LEG_MS 동안 미끄러지고 HOLD_MS 쉬기"를 되풀이한다.
    // 목표만 바꿔 두고 따라가게 하면 처음엔 확 움직이고 끝엔 멈춰 있어서 뚝뚝 끊겨 보인다.
    const trip = { from: toPx(spots()[0]), to: toPx(spots()[1 % spots().length]), at: 0, i: 1 };
    pos.current = { ...trip.from };
    target.current = { ...trip.from };
    draw();

    let raf = 0;
    const tick = (now: number) => {
      if (following.current) {
        // 커서를 따라갈 때는 조금 빠르게 붙는다
        pos.current.x += (target.current.x - pos.current.x) * 0.16;
        pos.current.y += (target.current.y - pos.current.y) * 0.16;
      } else {
        if (!trip.at) trip.at = now;
        const e = now - trip.at;
        if (e < LEG_MS) {
          const t = smooth(e / LEG_MS);
          pos.current.x = trip.from.x + (trip.to.x - trip.from.x) * t;
          pos.current.y = trip.from.y + (trip.to.y - trip.from.y) * t;
        } else if (e < LEG_MS + HOLD_MS) {
          pos.current = { ...trip.to };
        } else {
          trip.i = (trip.i + 1) % spots().length;
          trip.from = { ...pos.current };
          trip.to = toPx(spots()[trip.i]);
          trip.at = now;
        }
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    if (!reduce) raf = requestAnimationFrame(tick);

    const move = (e: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      target.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      following.current = true;
      setMoved(true);
      if (reduce) {
        pos.current = { ...target.current }; // 움직임을 줄인 사용자에겐 따라오는 동작 없이 바로 그 자리로
        draw();
      }
    };
    const leave = () => {
      following.current = false;
      // 커서를 치운 자리에서 다음 볼거리로 이어서 미끄러진다
      trip.from = { ...pos.current };
      trip.to = toPx(spots()[trip.i]);
      trip.at = 0;
      if (reduce) {
        pos.current = toPx(spots()[0]);
        draw();
      }
    };
    const resize = () => {
      trip.from = { ...pos.current };
      trip.to = toPx(spots()[trip.i]);
      trip.at = 0;
      draw();
    };

    box.addEventListener("pointermove", move);
    box.addEventListener("pointerleave", leave);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", resize);
    };
  }, [draw, reduce]);

  // 보이는 범위가 바뀌면 돋보기도 그 범위의 볼거리로 옮긴다
  useEffect(() => {
    const box = boxRef.current;
    if (box && !following.current) {
      const spot = (narrow ? SPOTS_NARROW : SPOTS_WIDE)[0];
      target.current = { x: box.clientWidth * spot.x, y: box.clientHeight * spot.y };
      if (reduce) pos.current = { ...target.current };
    }
    draw();
  }, [showAll, narrow, reduce, draw]);

  const view = narrow ? VIEW_NARROW : VIEW_WIDE;

  return (
    <section className="pt-10 pb-14 md:pt-16 md:pb-20">
      <div className="max-w-7xl mx-auto px-5 sm:px-6 lg:px-8 grid items-center gap-10 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:gap-16">
        {/* 왼쪽 — 제목과 시작 버튼 */}
        <div className="text-center lg:text-left motion-safe:animate-fade-up">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-[-0.04em] leading-[1.12] text-stone-900">
            발표 연습,
            <br />
            혼자서도 쉽게!
          </h1>
          <p className="mt-5 mx-auto lg:mx-0 max-w-md text-base md:text-lg leading-relaxed text-stone-500">
            목소리와 제스처, 시선을 분석하고 발표를 내용 흐름에 따라 구간으로 나눠 구간별 피드백과 전체 총평을
            보여줍니다.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center lg:justify-start gap-2">
            <button
              onClick={primaryAction.onClick}
              className={
                primaryAction.google
                  ? "h-12 pl-5 pr-6 rounded-full bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 text-[15px] font-semibold flex items-center gap-3 shadow-sm transition-colors"
                  : "h-12 px-6 rounded-full bg-stone-900 hover:bg-stone-700 text-white text-[15px] font-semibold transition-colors"
              }
            >
              {primaryAction.google && <GoogleLogo />}
              {primaryAction.label}
            </button>
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="h-12 px-6 rounded-full border border-stone-300 bg-white/60 hover:bg-white text-stone-700 text-[15px] font-semibold transition-colors"
              >
                {secondaryAction.label}
              </button>
            )}
          </div>
        </div>

        {/* 오른쪽 — 돋보기 박스 */}
        <div className="lg:pt-8 motion-safe:animate-fade-up [animation-delay:80ms]">
          <p className="sr-only">
            발표하는 장면 위에 돋보기를 올리면 돋보기 안에서만 AI 분석 결과(시선, 자세, 제스처, 목소리 파형, 자막의
            군말)가 보이는 그림입니다. 아래 「분석 레이어 전체 보기」 버튼으로 전체를 펼쳐 볼 수 있습니다.
          </p>

          <div
            ref={boxRef}
            className="relative overflow-hidden -mx-5 sm:mx-0 rounded-none sm:rounded-2xl border-y sm:border border-slate-200 bg-white shadow-xl shadow-slate-300/30 select-none"
            style={{ aspectRatio: narrow ? "580 / 570" : "1000 / 620", cursor: showAll ? "default" : "crosshair" }}
          >
            {/* 아래 칸 — 사람 눈에 보이는 그대로의 발표 영상 */}
            <BaseScene view={view} />

            {/* 위 칸 — AI 분석 레이어. 돋보기 안에서만 보인다 */}
            <div ref={layerRef} className="absolute inset-0">
              <div ref={lensRef} className="absolute inset-0 will-change-transform">
                <AnalysisScene view={view} />
              </div>
            </div>

            {/* 돋보기 유리 — 가장자리 그림자와 위쪽 하이라이트로 볼록한 느낌을 낸다 */}
            <div
              ref={ringRef}
              aria-hidden="true"
              className="absolute left-0 top-0 rounded-full pointer-events-none overflow-hidden"
              style={{
                background:
                  "radial-gradient(circle at 34% 26%, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.1) 20%, rgba(255,255,255,0) 44%), radial-gradient(circle at 72% 80%, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0) 38%)",
                boxShadow: [
                  "inset 0 0 0 1px rgba(255,255,255,0.4)", // 유리 안쪽 테
                  "inset 3px 4px 10px rgba(255,255,255,0.22)", // 왼쪽 위에서 들어오는 빛
                  "inset -5px -6px 16px rgba(8,20,18,0.45)", // 오른쪽 아래 두께감
                  "0 0 0 2px rgba(45,212,191,0.55)", // 테 (민트)
                  "0 0 0 7px rgba(45,212,191,0.1)",
                  "0 14px 30px rgba(10,28,26,0.35)", // 떠 있는 그림자
                ].join(", "),
              }}
            >
              {/* 유리에 비치는 빛 한 점 */}
              <span
                className="absolute rounded-full"
                style={{
                  left: "17%",
                  top: "13%",
                  width: "32%",
                  height: "19%",
                  transform: "rotate(-28deg)",
                  background: "radial-gradient(ellipse at center, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0) 70%)",
                }}
              />
            </div>

            {/* 처음 한 번만 보이는 안내 */}
            {!moved && !showAll && (
              <div className="absolute left-3 top-3 sm:left-4 sm:top-4 rounded-full bg-stone-900/80 px-3 py-1.5 text-xs font-semibold text-white pointer-events-none motion-safe:animate-fade-up">
                {touch ? "그림 위를 문질러 보세요" : "커서를 올려 AI가 보는 것을 확인해 보세요"}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center justify-center gap-3 text-xs text-stone-400">
            <span>AI가 읽어내는 것들 · 예시 화면</span>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="rounded-full border border-stone-300 bg-white/60 px-3 py-1 font-semibold text-stone-500 hover:bg-white hover:text-stone-700 transition-colors"
            >
              {showAll ? "돋보기로 보기" : "분석 레이어 전체 보기"}
            </button>
          </div>
        </div>
      </div>

      {/* 아래에 더 있다는 걸 알려 주는 작은 표시 */}
      <div className="mt-14 flex flex-col items-center gap-2" aria-hidden="true">
        <span className="relative block h-9 w-[22px] rounded-full border border-stone-300">
          <span className="absolute left-1/2 top-[7px] h-[6px] w-[2px] -translate-x-1/2 rounded-full bg-stone-400 motion-safe:animate-scroll-dot" />
        </span>
        <span className="text-[11px] font-semibold tracking-wide text-stone-400">스크롤</span>
      </div>
    </section>
  );
}

// ── 아래 칸: 그냥 발표 영상 ───────────────────────────────────────────────────
// 바탕은 회색(stone)이라 화면 밝기(라이트/다크)에 맞춰 같이 어두워지고, 발표 장면 그림만 제 색을 지킨다.
function BaseScene({ view }: { view: string }) {
  return (
    <svg viewBox={view} className="absolute inset-0 w-full h-full" aria-hidden="true">
      <rect x="0" y="0" width="1000" height="620" className="fill-stone-100" />

      {/* 자료 화면과 사람이 바닥에 놓여 보이도록 깔아 주는 옅은 그림자 */}
      <ellipse cx="318" cy="424" rx="268" ry="13" className="fill-stone-400" opacity="0.3" />
      <ellipse cx="790" cy="588" rx="218" ry="16" className="fill-stone-400" opacity="0.3" />

      {/* 발표하는 장면 */}
      <image href="/presenter.webp" x={FIG.x} y={FIG.y} width={FIG.w} height={FIG.h} />

      {/* 영상 재생 막대 */}
      <rect x="40" y="598" width="920" height="6" rx="3" className="fill-stone-300" />
      <rect x="40" y="598" width="408" height="6" rx="3" className="fill-stone-400" />
      <circle cx="448" cy="601" r="8" className="fill-stone-500" />
    </svg>
  );
}

// ── 위 칸: AI 분석 레이어 ────────────────────────────────────────────────────
// 라이트/다크 어느 쪽이든 똑같이 보이도록 색을 직접 적는다 (민트=분석, 보라=시선, 주황=군말).
const MINT = "#5eead4";
const MINT_DOT = "#99f6e4";
const PINK = "#fbcfe8"; // 시선

// 목소리 파형 막대 높이 (보여주기용)
const WAVE = [8, 14, 22, 30, 24, 16, 26, 34, 40, 30, 20, 12, 6, 4, 5, 7, 18, 28, 36, 30, 22, 14, 24, 32, 38, 28, 18, 10];

function AnalysisScene({ view }: { view: string }) {
  return (
    <svg viewBox={view} className="absolute inset-0 w-full h-full" aria-hidden="true">
      <rect x="0" y="0" width="1000" height="620" fill="#0a1211" opacity="0.93" />

      {/* 눈금 */}
      <g stroke={MINT} strokeWidth="1" opacity="0.06">
        {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((x) => <line key={x} x1={x} y1="0" x2={x} y2="620" />)}
        {[100, 200, 300, 400, 500, 600].map((y) => <line key={y} x1="0" y1={y} x2="1000" y2={y} />)}
      </g>

      {/* 같은 장면을 어둡게 깔아서, 돋보기 안에서도 같은 장면임이 보이게 한다 */}
      <image
        href="/presenter.webp"
        x={FIG.x}
        y={FIG.y}
        width={FIG.w}
        height={FIG.h}
        style={{ filter: "grayscale(1) brightness(0.52) contrast(1.15)" }}
      />

      {/* 목소리 — 발표 자료 화면 위에 파형이 뜬다 */}
      <rect x="76" y="170" width="324" height="160" rx="12" fill="#111b1a" stroke="#134e4a" />
      <text x="96" y="198" fill={MINT} fontSize="15" fontWeight="700" opacity="0.8">목소리</text>
      <text x="96" y="224" fill={MINT} fontSize="18" fontWeight="700">212 WPM · 조금 빨라요</text>
      <g fill={MINT} opacity="0.85">
        {WAVE.map((h, i) => (
          <rect key={i} x={96 + i * 9} y={282 - h / 2} width="5" height={h} rx="2.5" />
        ))}
      </g>
      <rect x="170" y="256" width="30" height="52" rx="6" fill="#7c2d12" opacity="0.5" />
      <text x="158" y="322" fill="#fdba74" fontSize="13" fontWeight="700">무음 1.8초</text>

      {/* 시선 — 두 눈에 조준 표시 */}
      <g stroke={PINK} strokeWidth="2" fill="none">
        <rect x="665" y="147" width="22" height="18" rx="3" />
        <rect x="715" y="147" width="22" height="18" rx="3" />
        <path d="M790 128 L742 152" />
      </g>
      <rect x="790" y="110" width="186" height="34" rx="9" fill="#500724" stroke="#9d174d" />
      <text x="804" y="133" fill={PINK} fontSize="16" fontWeight="700">시선 — 카메라 응시 중</text>

      {/* 자세 — 어깨선과 척추 */}
      <g stroke={MINT} strokeWidth="3" strokeLinecap="round" fill="none">
        <path d="M697 218 L698 361 M641 236 L753 231 M681 361 L718 361 M641 236 L580 250 M580 250 L556 228 M556 228 L534 208 M753 231 L765 260 M765 260 L802 276" />
      </g>
      <g fill={MINT_DOT}>
        {[[697, 218], [641, 236], [753, 231], [580, 250], [556, 228], [765, 260], [802, 276], [681, 361], [718, 361]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="6" />
        ))}
      </g>
      <rect x="790" y="300" width="188" height="34" rx="9" fill="#042f2e" stroke="#0f766e" />
      <text x="804" y="323" fill={MINT} fontSize="16" fontWeight="700">자세 — 흔들림 적음</text>
      <path d="M790 317 L712 345" stroke={MINT} strokeWidth="2" fill="none" />

      {/* 제스처 — 자료를 가리키는 손 */}
      <circle cx="538" cy="210" r="32" fill="none" stroke={MINT} strokeWidth="2" strokeDasharray="5 7" />
      <g fill={MINT}>
        {[[520, 214], [528, 204], [540, 199], [553, 201], [560, 212]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="3.5" />
        ))}
      </g>
      <rect x="430" y="252" width="196" height="34" rx="9" fill="#042f2e" stroke="#0f766e" />
      <text x="444" y="275" fill={MINT} fontSize="16" fontWeight="700">제스처 — 자료 가리킴</text>
      <path d="M536 252 L537 240" stroke={MINT} strokeWidth="2" fill="none" />

      {/* 목소리 → 말한 내용 — 둘 다 음성에서 나온 것이라 왼쪽을 세로선으로 묶는다 */}
      <path d="M90 338 L90 486" stroke={MINT} strokeWidth="2" strokeDasharray="4 7" fill="none" opacity="0.5" />
      <g fill={MINT} opacity="0.6">
        <circle cx="90" cy="336" r="3.5" />
        <circle cx="90" cy="488" r="3.5" />
      </g>

      {/* 말한 내용(자막) — 군말에 표시. 목소리 패널과 왼쪽 끝을 맞춘다 */}
      <text x="96" y="492" fill={MINT} fontSize="15" fontWeight="700" opacity="0.8">말한 내용</text>
      <text x="956" y="492" textAnchor="end" fill={MINT} fontSize="15" fontWeight="700" opacity="0.75">구간 3 / 7 · 문제 정의</text>
      <rect x="76" y="500" width="884" height="74" rx="12" fill="#111b1a" stroke="#134e4a" />
      <text x="100" y="546" fill="#d6d3d1" fontSize="22" fontWeight="600">그러니까</text>
      <rect x="198" y="520" width="74" height="36" rx="7" fill="#7c2d12" />
      <text x="210" y="546" fill="#fdba74" fontSize="22" fontWeight="700">음…</text>
      <text x="286" y="546" fill="#d6d3d1" fontSize="22" fontWeight="600">저희가 제안하는 구조는</text>
      <rect x="538" y="520" width="46" height="36" rx="7" fill="#7c2d12" />
      <text x="550" y="546" fill="#fdba74" fontSize="22" fontWeight="700">어</text>
      <text x="596" y="546" fill="#d6d3d1" fontSize="22" fontWeight="600">이렇게 세 단계입니다</text>
    </svg>
  );
}
