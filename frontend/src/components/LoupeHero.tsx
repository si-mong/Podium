"use client";

// 첫 화면 히어로 — 무대(전체 화면) → 박스로 줄어듦 → 분석 장면 → "AI의 눈" 돋보기.
// ServiceGuide 가 쓰며, 제목·소개문·시작 버튼도 여기서 그린다 (무대 위에 얹혀 같이 움직이기 때문).
//
// 스크롤 흐름 (화면에 붙어 있는 sticky 구간 동안 진행된다):
//   1) 무대 (public/stage.webp) 가 화면을 꽉 채운다. 그 위에 제목·소개문·시작 버튼.
//   2) 스크롤하면 글자가 먼저 걷히고, 꽉 찬 무대가 둥근 박스로 줄어든다.
//   3) 박스 안에서 무대가 밝게 날아가고(두 그림의 사람 위치가 달라서 겹쳐 보이지 않도록
//      중간에 밝은 화면을 한 번 끼운다) 분석 장면이 들어온다.
//   4) 분석 장면 (public/presenter.webp — 사람 + 발표 자료 화면)
//      - 아래 칸: 그냥 발표 영상처럼 보인다
//      - 위 칸: 같은 그림을 어둡게 깔고 그 위에 시선·자세·제스처·목소리 파형·자막을 그린다.
//        커서 둘레만 동그랗게 뚫려서, 돋보기 안에서만 보인다
//   즉 "사람 눈엔 그냥 영상, AI 눈엔 데이터" 를 보여준다.
//
// 돋보기 움직임:
//   - 커서(손가락)를 올리면 돋보기가 따라온다. 부드럽게 따라가도록 매 프레임 조금씩 다가간다.
//   - 커서가 없으면 볼거리(얼굴 → 목소리 → 자막 → 제스처)를 2.4초마다 혼자 돌아다닌다.
//   - 「분석 레이어 전체 보기」를 누르면 돋보기 없이 전부 보인다 (키보드 사용자·터치 사용자용).
//
// "애니메이션 줄이기"를 켠 사용자에게는 스크롤 전환을 쓰지 않고, 무대 → 분석 장면을 위아래로
// 그냥 쌓아서 보여준다 (아래 StaticHero).
//
// 그림 안의 숫자·문장은 전부 보여주기용 예시다 (서버를 부르지 않음).
// 분석 레이어 색은 라이트/다크에서 똑같이 보이도록 Tailwind 색 이름 대신 색값을 직접 적었다.
// (tailwind.config.ts 가 색 이름을 다크 모드에서 뒤집기 때문)
//
// 좌표 메모: 그림판은 1000×620. 발표 장면 그림(public/presenter.webp, 원본 1400×857)은 x 30, y 24 에 940×575 로 놓았고,
// 아래 분석 레이어의 숫자는 그 그림 위에서 직접 잰 눈·어깨·손 위치다. 그림을 바꾸면 이 숫자도 전부 다시 재야 한다.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";

// 그림판 전체는 1000×620. 좁은 화면에서는 글씨가 너무 작아져서 사람 쪽(430,40 부터 570×570)만 잘라 크게 보여준다.
const VIEW_WIDE = "0 0 1000 620";
const VIEW_NARROW = "430 50 570 570";
const RATIO_WIDE = 1000 / 620;
const RATIO_NARROW = 580 / 570;

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
const SPOT_MS = 2400;

// 발표 장면 그림을 놓는 자리 (그림판 좌표). 원본 1400×857.
const FIG = { x: 30, y: 24, w: 940, h: 575 };

const HEADER_SAFE = 92; // 떠 있는 상단 바에 가리지 않도록 박스 위에 비워 두는 높이
const CAPTION_H = 44; // 박스 아래 설명 줄 높이

interface Props {
  primaryAction: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (t: number) => t * t * (3 - 2 * t); // 시작·끝을 부드럽게
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// 돋보기 — 분석 레이어를 커서 둘레만 동그랗게 보여 준다. 두 히어로(스크롤용·정지용)가 같이 쓴다.
function useLoupe(narrow: boolean, reduce: boolean, showAll: boolean, active = true) {
  const boxRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [moved, setMoved] = useState(false);
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const activeRef = useRef(active);
  activeRef.current = active;

  const pos = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const following = useRef(false);

  const draw = useCallback(() => {
    const box = boxRef.current;
    const layer = layerRef.current;
    const ring = ringRef.current;
    if (!box || !layer || !ring) return;
    const r = Math.min(155, Math.max(68, box.clientWidth * 0.19)); // 돋보기 반지름 — 틀 크기를 따라간다
    const { x, y } = pos.current;
    layer.style.clipPath = showAllRef.current ? "none" : `circle(${r}px at ${x}px ${y}px)`;
    ring.style.width = ring.style.height = `${r * 2}px`;
    ring.style.transform = `translate(${x - r}px, ${y - r}px)`;
    ring.style.opacity = showAllRef.current ? "0" : "1";
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const spots = () => (narrowRef.current ? SPOTS_NARROW : SPOTS_WIDE);
    const toPx = (s: { x: number; y: number }) => ({ x: box.clientWidth * s.x, y: box.clientHeight * s.y });

    let spot = 0;
    target.current = toPx(spots()[0]);
    pos.current = { ...target.current };
    draw();

    // 커서가 없으면 볼거리를 하나씩 혼자 돌아다닌다
    const timer = reduce
      ? null
      : setInterval(() => {
          if (following.current) return;
          spot = (spot + 1) % spots().length;
          target.current = toPx(spots()[spot]);
        }, SPOT_MS);

    let raf = 0;
    const tick = () => {
      pos.current.x += (target.current.x - pos.current.x) * 0.12;
      pos.current.y += (target.current.y - pos.current.y) * 0.12;
      draw();
      raf = requestAnimationFrame(tick);
    };
    if (!reduce) raf = requestAnimationFrame(tick);

    const move = (e: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      target.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      following.current = true;
      if (activeRef.current) setMoved(true);
      if (reduce) {
        pos.current = { ...target.current };
        draw();
      }
    };
    const leave = () => {
      following.current = false;
      if (reduce) {
        pos.current = toPx(spots()[0]);
        target.current = { ...pos.current };
        draw();
      }
    };
    const resize = () => {
      if (!following.current) target.current = toPx(spots()[spot]);
      draw();
    };

    box.addEventListener("pointermove", move);
    box.addEventListener("pointerleave", leave);
    window.addEventListener("resize", resize);
    return () => {
      if (timer) clearInterval(timer);
      cancelAnimationFrame(raf);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", resize);
    };
  }, [draw, reduce]);

  useEffect(() => { draw(); }, [showAll, narrow, draw]);

  return { boxRef, layerRef, ringRef, moved, draw };
}

// 틀 안에 들어가는 분석 장면 (아래 칸 + 돋보기로 보는 위 칸 + 테두리)
function Scene({
  view,
  layerRef,
  ringRef,
}: {
  view: string;
  layerRef: React.RefObject<HTMLDivElement>;
  ringRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <>
      <BaseScene view={view} />
      <div ref={layerRef} className="absolute inset-0">
        <AnalysisScene view={view} />
      </div>
      <div
        ref={ringRef}
        aria-hidden="true"
        className="absolute left-0 top-0 rounded-full pointer-events-none"
        style={{ boxShadow: "0 0 0 1.5px rgba(45,212,191,0.55), 0 0 0 7px rgba(45,212,191,0.10)" }}
      />
    </>
  );
}

// 박스 아래 설명 줄
function CaptionRow({ showAll, onToggle, enabled }: { showAll: boolean; onToggle: () => void; enabled: boolean }) {
  return (
    <>
      <span>AI가 읽어내는 것들 · 예시 화면</span>
      <button
        type="button"
        onClick={onToggle}
        tabIndex={enabled ? 0 : -1}
        className="rounded-full border border-stone-300 px-3 py-1 font-semibold text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors"
      >
        {showAll ? "돋보기로 보기" : "분석 레이어 전체 보기"}
      </button>
    </>
  );
}

const HERO_TITLE = (
  <>
    발표 연습,
    <br />
    혼자서도 쉽게!
  </>
);
const HERO_LEAD = "목소리와 제스처, 시선을 분석하고 발표를 내용 흐름에 따라 구간으로 나눠 구간별 피드백과 전체 총평을 보여줍니다.";

export default function LoupeHero({ primaryAction, secondaryAction }: Props) {
  const [narrow, setNarrow] = useState(false);
  const [touch, setTouch] = useState(false);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    setTouch(window.matchMedia("(hover: none)").matches);
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const common = { narrow, touch, reduce, primaryAction, secondaryAction };
  return reduce ? <StaticHero {...common} /> : <ScrollHero {...common} />;
}

type HeroProps = Props & { narrow: boolean; touch: boolean; reduce: boolean };

// ── 스크롤 전환 히어로 ────────────────────────────────────────────────────────
function ScrollHero({ narrow, touch, reduce, primaryAction, secondaryAction }: HeroProps) {
  const runwayRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);
  const lightRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(entered);
  enteredRef.current = entered;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  const { boxRef, layerRef, ringRef, moved, draw } = useLoupe(narrow, reduce, showAll, entered);

  useEffect(() => {
    const runway = runwayRef.current;
    const sticky = stickyRef.current;
    if (!runway || !sticky) return;
    let raf = 0;

    const apply = () => {
      raf = 0;
      const vw = sticky.clientWidth;
      const vh = sticky.clientHeight;
      const span = Math.max(1, runway.offsetHeight - vh);
      const p = clamp01(-runway.getBoundingClientRect().top / span);

      // 줄어든 뒤의 박스 자리
      const ratio = narrowRef.current ? RATIO_NARROW : RATIO_WIDE;
      const pad = narrowRef.current ? 0 : 24;
      let W = Math.min(976, vw - pad * 2);
      let H = W / ratio;
      const maxH = vh - HEADER_SAFE - CAPTION_H - 16;
      if (H > maxH) {
        H = maxH;
        W = H * ratio;
      }
      const L = (vw - W) / 2;
      const T = HEADER_SAFE + Math.max(0, (vh - HEADER_SAFE - CAPTION_H - H) / 2);

      // 1) 글자가 먼저 걷힌다
      const co = 1 - clamp01(p / 0.14);
      if (copyRef.current) {
        copyRef.current.style.opacity = String(co);
        copyRef.current.style.transform = `translateY(${-30 * (1 - co)}px)`;
        copyRef.current.style.visibility = co < 0.05 ? "hidden" : "visible";
      }
      if (scrimRef.current) scrimRef.current.style.opacity = String(co);

      // 2) 꽉 찬 화면이 박스로 줄어든다
      const s = ease(clamp01((p - 0.1) / 0.28));
      const startH = narrowRef.current ? vh * 0.54 : vh; // 좁은 화면에서는 무대가 위쪽만 차지한다
      const bx = { l: lerp(0, L, s), t: lerp(0, T, s), w: lerp(vw, W, s), h: lerp(startH, H, s) };
      const box = boxRef.current;
      if (box) {
        box.style.left = `${bx.l}px`;
        box.style.top = `${bx.t}px`;
        box.style.width = `${bx.w}px`;
        box.style.height = `${bx.h}px`;
        box.style.borderRadius = `${s * (narrowRef.current ? 0 : 20)}px`;
      }

      // 3) 무대가 다가가며 사라지고, 한 번 밝아졌다가, 분석 장면이 들어온다
      const out = clamp01((p - 0.34) / 0.16);
      if (lightRef.current) lightRef.current.style.opacity = String(1 - out);
      if (glowRef.current) glowRef.current.style.opacity = String(1 - out);
      if (stageRef.current) {
        stageRef.current.style.opacity = String(1 - out);
        stageRef.current.style.transform = `scale(${1 + 0.07 * ease(clamp01((p - 0.08) / 0.42))})`;
      }
      if (washRef.current) {
        washRef.current.style.opacity = String(p < 0.5 ? clamp01((p - 0.38) / 0.12) : 1 - clamp01((p - 0.5) / 0.2));
      }
      const into = clamp01((p - 0.5) / 0.22);
      if (sceneRef.current) {
        sceneRef.current.style.opacity = String(into);
        sceneRef.current.style.transform = `scale(${lerp(1.04, 1, into)})`;
      }

      // 4) 박스 아래 설명 줄은 박스를 따라다닌다
      if (capRef.current) {
        capRef.current.style.left = `${bx.l}px`;
        capRef.current.style.width = `${bx.w}px`;
        capRef.current.style.top = `${bx.t + bx.h + 12}px`;
        capRef.current.style.opacity = String(into > 0.8 ? 1 : 0);
      }

      const on = into > 0.6;
      if (on !== enteredRef.current) setEntered(on);
      draw();
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [boxRef, draw]);

  // 무대 조명 — 커서를 따라 천천히 옮겨 다니고, 커서가 없으면 발표자 자리로 돌아간다.
  // 조명 밖은 어둡게 깔려서, 첫 화면에서 스크롤하기 전부터 화면이 손에 반응한다.
  useEffect(() => {
    const box = boxRef.current;
    const light = lightRef.current;
    const glow = glowRef.current;
    if (!box || !light || !glow) return;
    const REST = { x: 0.5, y: 0.62 }; // 발표자가 서 있는 자리
    const at = { x: 0, y: 0 };
    const to = { x: 0, y: 0 };
    const rest = () => ({ x: box.clientWidth * REST.x, y: box.clientHeight * REST.y });
    at.x = rest().x;
    at.y = rest().y;
    to.x = at.x;
    to.y = at.y;

    let raf = 0;
    const tick = () => {
      at.x += (to.x - at.x) * 0.08;
      at.y += (to.y - at.y) * 0.08;
      const r = Math.min(460, Math.max(220, box.clientWidth * 0.26));
      light.style.background = `radial-gradient(circle ${r}px at ${at.x}px ${at.y}px, rgba(22,14,4,0) 0%, rgba(22,14,4,0.16) 45%, rgba(22,14,4,0.52) 100%)`;
      glow.style.background = `radial-gradient(circle ${r * 0.72}px at ${at.x}px ${at.y}px, rgba(255,208,140,0.3) 0%, rgba(255,208,140,0) 72%)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const move = (e: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      to.x = e.clientX - rect.left;
      to.y = e.clientY - rect.top;
    };
    const leave = () => {
      const r = rest();
      to.x = r.x;
      to.y = r.y;
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerleave", leave);
    };
  }, [boxRef]);

  const view = narrow ? VIEW_NARROW : VIEW_WIDE;

  return (
    <section ref={runwayRef} className="relative -mt-14">
      <HeroSrOnly />
      <div ref={stickyRef} className="sticky top-0 h-screen overflow-hidden">
        {/* 무대 → 분석 장면이 담긴 틀. 꽉 찬 화면에서 시작해 박스로 줄어든다 */}
        <div
          ref={boxRef}
          className="absolute overflow-hidden border border-stone-200 bg-stone-100 select-none"
          style={{
            left: 0,
            top: 0,
            width: "100%",
            height: narrow ? "54%" : "100%",
            cursor: entered && !showAll ? "crosshair" : "default",
          }}
        >
          <div ref={stageRef} className="absolute inset-0 will-change-transform" aria-hidden="true">
            <Image src="/stage.webp" alt="" fill priority sizes="100vw" className="object-cover dark:brightness-[0.78]" />
          </div>
          {/* 무대 조명 — 커서가 비추는 곳만 밝고 나머지는 어둡다 */}
          <div ref={lightRef} className="absolute inset-0 pointer-events-none" aria-hidden="true" />
          <div ref={glowRef} className="absolute inset-0 pointer-events-none mix-blend-screen" aria-hidden="true" />

          {/* 글자가 읽히도록 위쪽을 밝게 (글자와 같이 걷힌다) */}
          <div
            ref={scrimRef}
            aria-hidden="true"
            className="absolute inset-0 hidden sm:block bg-gradient-to-b from-[rgba(253,246,235,0.92)] via-[rgba(253,246,235,0.45)] to-transparent"
          />
          {/* 무대와 분석 장면 사이에서 한 번 밝아지는 화면 */}
          <div ref={washRef} className="absolute inset-0 bg-stone-100" style={{ opacity: 0 }} aria-hidden="true" />
          <div
            ref={sceneRef}
            className="absolute inset-0 will-change-transform"
            style={{ opacity: 0, transform: "scale(1.04)" }}
          >
            <Scene view={view} layerRef={layerRef} ringRef={ringRef} />
          </div>

          {entered && !moved && !showAll && (
            <div className="absolute left-3 top-3 sm:left-4 sm:top-4 rounded-full bg-stone-900/80 px-3 py-1.5 text-xs font-semibold text-white pointer-events-none motion-safe:animate-fade-up">
              {touch ? "그림 위를 문질러 보세요" : "커서를 올려 AI가 보는 것을 확인해 보세요"}
            </div>
          )}
        </div>

        {/* 제목 — 꽉 찬 무대 위에 얹혀 있다가 먼저 걷힌다 */}
        <div
          ref={copyRef}
          className="absolute inset-x-0 bottom-[4%] px-6 text-center will-change-transform pointer-events-none sm:inset-0 sm:bottom-0 sm:flex sm:flex-col sm:pt-[max(84px,8vh)] sm:pb-[16vh]"
        >
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-[-0.04em] leading-[1.1] text-stone-900 sm:text-[#241c13]">{HERO_TITLE}</h1>
          <p className="mt-4 sm:mt-5 mx-auto max-w-xl text-base md:text-lg leading-relaxed text-stone-500 sm:text-[rgba(36,28,19,0.72)]">{HERO_LEAD}</p>
          <div className="mt-5 sm:mt-7 flex items-center justify-center gap-2 pointer-events-auto">
            <button
              onClick={primaryAction.onClick}
              className="h-12 px-6 rounded-full bg-stone-900 text-white sm:bg-[#241c13] sm:hover:bg-[#3b2f20] sm:text-[#fdf6eb] text-[15px] font-semibold transition-colors"
            >
              {primaryAction.label}
            </button>
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="h-12 px-6 rounded-full border border-stone-300 text-stone-700 sm:border-[rgba(36,28,19,0.35)] sm:text-[#241c13] text-[15px] font-semibold sm:hover:bg-[rgba(36,28,19,0.07)] transition-colors"
              >
                {secondaryAction.label}
              </button>
            )}
          </div>
          <div className="mt-6 sm:mt-auto text-xs font-semibold tracking-wide text-stone-400 sm:text-[rgba(36,28,19,0.6)]">
            스크롤하면 AI가 보기 시작해요
          </div>
        </div>

        {/* 박스 아래 설명 줄 */}
        <div
          ref={capRef}
          className="absolute flex items-center justify-center gap-3 text-xs text-stone-400 motion-safe:transition-opacity motion-safe:duration-300"
          style={{ opacity: 0, left: 0, top: 0, width: "100%" }}
        >
          <CaptionRow showAll={showAll} onToggle={() => setShowAll((v) => !v)} enabled={entered} />
        </div>
      </div>

      {/* 활주로 — 이 길이만큼 스크롤하는 동안 위 장면이 진행된다 */}
      <div className="h-[110vh] sm:h-[130vh]" aria-hidden="true" />
    </section>
  );
}

// ── "애니메이션 줄이기"를 켠 사용자용: 전환 없이 위아래로 쌓아서 보여준다 ──────────
function StaticHero({ narrow, touch, reduce, primaryAction, secondaryAction }: HeroProps) {
  const [showAll, setShowAll] = useState(false);
  const { boxRef, layerRef, ringRef, moved } = useLoupe(narrow, reduce, showAll);
  const view = narrow ? VIEW_NARROW : VIEW_WIDE;

  return (
    <section className="relative -mt-14">
      <HeroSrOnly />
      {/* 무대 — 글자는 그림 위에 얹지 않고 아래에 둔다 (전환이 없으니 단순한 쪽이 읽기 좋다) */}
      <div className="relative h-[46vh] sm:h-[56vh] min-h-[300px] overflow-hidden">
        <Image src="/stage.webp" alt="" fill priority sizes="100vw" className="object-cover dark:brightness-[0.78]" />
      </div>
      <div className="px-6 pt-10 text-center">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-[-0.04em] leading-[1.1] text-stone-900">{HERO_TITLE}</h1>
        <p className="mt-5 mx-auto max-w-xl text-base md:text-lg leading-relaxed text-stone-500">{HERO_LEAD}</p>
        <div className="mt-7 flex items-center justify-center gap-2">
          <button
            onClick={primaryAction.onClick}
            className="h-12 px-6 rounded-full bg-stone-900 hover:bg-stone-700 text-white text-[15px] font-semibold transition-colors"
          >
            {primaryAction.label}
          </button>
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className="h-12 px-6 rounded-full border border-stone-300 hover:bg-stone-50 text-stone-700 text-[15px] font-semibold transition-colors"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-0 sm:px-6 mt-10">
        <div
          ref={boxRef}
          className="relative overflow-hidden rounded-none sm:rounded-[20px] border-y sm:border border-stone-200 bg-stone-100 select-none"
          style={{ aspectRatio: narrow ? "580 / 570" : "1000 / 620", cursor: showAll ? "default" : "crosshair" }}
        >
          <Scene view={view} layerRef={layerRef} ringRef={ringRef} />
          {!moved && !showAll && (
            <div className="absolute left-3 top-3 sm:left-4 sm:top-4 rounded-full bg-stone-900/80 px-3 py-1.5 text-xs font-semibold text-white pointer-events-none">
              {touch ? "그림 위를 문질러 보세요" : "커서를 올려 AI가 보는 것을 확인해 보세요"}
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-center gap-3 text-xs text-stone-400">
          <CaptionRow showAll={showAll} onToggle={() => setShowAll((v) => !v)} enabled />
        </div>
      </div>
    </section>
  );
}

function HeroSrOnly(): ReactNode {
  return (
    <p className="sr-only">
      무대에서 발표하는 장면으로 시작해, 스크롤하면 분석 화면으로 바뀝니다. 그 위에 돋보기를 올리면 돋보기 안에서만 AI
      분석 결과(시선, 자세, 제스처, 목소리 파형, 자막의 군말)가 보입니다. 「분석 레이어 전체 보기」 버튼으로 전체를 펼쳐
      볼 수 있습니다.
    </p>
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
const VIOLET = "#ddd6fe";

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
      <g stroke={VIOLET} strokeWidth="2" fill="none">
        <rect x="665" y="147" width="22" height="18" rx="3" />
        <rect x="715" y="147" width="22" height="18" rx="3" />
        <path d="M790 128 L742 152" />
      </g>
      <rect x="790" y="110" width="186" height="34" rx="9" fill="#2e1065" stroke="#6d28d9" />
      <text x="804" y="133" fill={VIOLET} fontSize="16" fontWeight="700">시선 — 카메라 응시 중</text>

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

      {/* 자막 — 군말에 표시 */}
      <text x="956" y="462" textAnchor="end" fill={MINT} fontSize="15" fontWeight="700" opacity="0.75">구간 3 / 7 · 문제 정의</text>
      <rect x="40" y="472" width="920" height="74" rx="12" fill="#111b1a" stroke="#134e4a" />
      <text x="64" y="518" fill="#d6d3d1" fontSize="22" fontWeight="600">그러니까</text>
      <rect x="162" y="492" width="74" height="36" rx="7" fill="#7c2d12" />
      <text x="174" y="518" fill="#fdba74" fontSize="22" fontWeight="700">음…</text>
      <text x="250" y="518" fill="#d6d3d1" fontSize="22" fontWeight="600">저희가 제안하는 구조는</text>
      <rect x="502" y="492" width="46" height="36" rx="7" fill="#7c2d12" />
      <text x="514" y="518" fill="#fdba74" fontSize="22" fontWeight="700">어</text>
      <text x="560" y="518" fill="#d6d3d1" fontSize="22" fontWeight="600">이렇게 세 단계입니다</text>
    </svg>
  );
}
