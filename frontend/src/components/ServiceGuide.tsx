"use client";

// 서비스 안내 화면 — 로그인 전 첫 화면(/)과 로그인 후 홈(/home)이 똑같이 쓴다.
//   1) 가운데 떠 있는 알약 모양 상단 바 (Podium 워드마크 + 오른쪽 버튼)
//   2) 히어로: 왼쪽에 제목·시작 버튼, 오른쪽에 발표 장면 그림.
//      그림 위에서 커서를 움직이면 돋보기 안에만 분석 레이어가 보인다 — LoupeHero.tsx
//   3) 분석하는 항목: 목소리 4가지 · 몸짓 3가지를 카드로 늘어놓고, 마지막 칸은 사용 방법으로 보내는 버튼
//   4) 이렇게 사용해요: 스크롤 따라 진행 — UsageSteps.tsx
// 디자인: 바탕은 대시보드와 같은 파스텔(.dashboard-bg), 글자는 검정·따뜻한 회색(stone), 글꼴은 Pretendard.
// 두 화면의 차이는 상단 오른쪽 버튼(headerActions)과 시작 버튼(primaryAction)뿐이다.

import { type ReactNode, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import LoupeHero from "./LoupeHero";
import SegmentMetrics from "./SegmentMetrics";
import UsageSteps from "./UsageSteps";

interface Props {
  headerActions: ReactNode; // 상단 오른쪽 버튼들 (로그인/시작하기 또는 내 기록/로그아웃)
  primaryAction: { label: string; onClick: () => void; google?: boolean }; // google: 구글 로고가 붙은 흰 버튼으로 // 소개 아래 검은 버튼
  secondaryAction?: { label: string; onClick: () => void };
}

// Podium 워드마크 (마이크가 o 자리에 들어간 로고). public/podium-logo.png — 투명 배경, 1237×309
export function PodiumLogo({ className }: { className?: string }) {
  // 로고 이미지는 검정이라 다크 모드에서는 색을 뒤집어 흰색으로 보인다
  return <Image src="/podium-logo.png" alt="Podium" width={1237} height={309} priority className={`dark:invert ${className ?? ""}`} />;
}

// 분석하는 항목: 2.4초마다 다음 항목으로 넘어간다. 마우스를 올리거나 눌러서 고르면 그 항목에서 멈춘다.
// "애니메이션 줄이기"를 켠 사용자에게는 자동으로 넘기지 않는다.
export default function ServiceGuide({ headerActions, primaryAction, secondaryAction }: Props) {
  return (
    <div className="dashboard-bg min-h-screen text-stone-900 font-['Pretendard_Variable',Pretendard,sans-serif]">
      {/* 1) 상단 바 — 화면 가운데 떠 있는 알약 모양 */}
      <div className="sticky top-4 z-20 px-4">
        <header className="max-w-3xl mx-auto h-12 rounded-full border border-stone-200/80 bg-white/80 backdrop-blur flex items-center justify-between gap-2 pl-5 sm:pl-6 pr-1.5">
          <PodiumLogo className="h-[18px] sm:h-5 w-auto shrink-0" />
          <div className="flex items-center gap-1">{headerActions}</div>
        </header>
      </div>

      {/* 2) 히어로 — 꽉 찬 무대로 시작해 스크롤하면 박스로 줄어들며 분석 장면이 된다 (LoupeHero.tsx).
             제목·소개문·시작 버튼도 무대 위에 얹혀 있어서 LoupeHero 가 같이 그린다. */}
      <div id="hero">
        <LoupeHero primaryAction={primaryAction} secondaryAction={secondaryAction} />
      </div>

      <main className="max-w-7xl mx-auto px-6 sm:px-10 lg:px-14">
        {/* 3) 분석하는 항목 — 실제 분석 화면의 「구간별 지표」를 줄여 놓은 카드 (SegmentMetrics.tsx).
               탭을 고르면 숫자와 꺾은선이 같이 바뀌고, 스크롤하면 누워 있던 카드가 똑바로 선다 */}
        <section id="metrics" className="scroll-mt-24 pt-12 pb-20">
          <SegmentMetrics />
        </section>

        {/* 4) 이렇게 사용해요 — 스크롤하면 단계가 하나씩 켜지고 오른쪽 그림이 바뀐다 (UsageSteps.tsx) */}
        <section id="how-to" className="scroll-mt-24 pt-20 pb-8 md:pt-28 lg:px-10 border-t border-stone-200 motion-safe:animate-fade-up [animation-delay:80ms]">
          <p className="text-[15px] font-extrabold text-stone-900">이렇게 사용해요</p>
          <h2 className="mt-4 text-4xl font-extrabold tracking-[-0.045em] leading-[1.12] text-stone-900">
            찍고, 기다리고,
            <br />
            고쳐서 다시.
          </h2>
          <div className="mt-12">
            <UsageSteps />
          </div>
        </section>
      </main>

      <SectionNav />

      <footer className="mt-16 border-t border-stone-200 py-8 text-center text-xs text-stone-400">
        © {new Date().getFullYear()} Podium ·{" "}
        <Link href="/terms" className="hover:text-stone-600 hover:underline">이용약관</Link> ·{" "}
        <Link href="/privacy" className="hover:text-stone-600 hover:underline">개인정보 처리방침</Link>
      </footer>
    </div>
  );
}


// 오른쪽 가운데 세로 점 3개 — 누르면 그 단으로 스크롤. 지금 보고 있는 단의 점은 길게 늘어난다.
// 아무 조작(마우스·휠·터치·키보드)이 IDLE_ADVANCE_MS 동안 없으면 다음 단으로 넘긴다. 조작하면 다시 처음부터 잰다.
// 마지막 단 다음은 첫 단으로 돌아간다. 좁은 화면(md 미만, 점 버튼도 숨김)과 "애니메이션 줄이기"를 켠 사용자에게는 넘기지 않는다.
// 점에 마우스를 올리면 단 이름이 왼쪽에 나온다 (늘 띄워 두면 히어로 그림과 겹쳐서). 좁은 화면(md 미만)에서는 숨긴다.
const SECTIONS = [
  { id: "hero", label: "AI 돋보기" },
  { id: "metrics", label: "분석하는 항목" },
  { id: "how-to", label: "이렇게 사용해요" },
];

const IDLE_ADVANCE_MS = 20_000;

const goTo = (id: string) => {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (id === "hero") window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  else document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
};

function SectionNav() {
  const [active, setActive] = useState("hero");
  const activeRef = useRef(active);
  activeRef.current = active;

  // 가만히 있을 때만 다음 단으로. 자동 스크롤이 내는 scroll 이벤트는 조작으로 치지 않으려고 scroll 은 듣지 않는다.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: number;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // 창 크기는 바뀔 수 있어서 넘길 때마다 확인한다
        if (window.matchMedia("(min-width: 768px)").matches) {
          const idx = SECTIONS.findIndex((x) => x.id === activeRef.current);
          goTo(SECTIONS[(idx + 1) % SECTIONS.length].id);
        }
        arm();
      }, IDLE_ADVANCE_MS);
    };
    const events = ["mousemove", "wheel", "touchstart", "pointerdown", "keydown"] as const;
    events.forEach((ev) => window.addEventListener(ev, arm, { passive: true }));
    arm();
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, arm));
    };
  }, []);

  useEffect(() => {
    // 화면 세로 가운데 선에 걸친 단을 "지금 보는 단"으로 친다
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: "-50% 0px -50% 0px" },
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="화면 단 이동" className="hidden md:flex fixed right-5 lg:right-7 top-1/2 -translate-y-1/2 z-30 flex-col items-end gap-1">
      {SECTIONS.map(({ id, label }) => {
        const on = active === id;
        return (
          <button
            key={id}
            onClick={() => goTo(id)}
            aria-label={label}
            aria-current={on ? "true" : undefined}
            className="group flex items-center gap-3 py-2 pl-3"
          >
            <span className={`rounded-full border border-stone-200/80 bg-white/90 backdrop-blur px-3 py-1 text-[13px] font-bold text-stone-700 shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100`}>
              {label}
            </span>
            <span className={`block w-2.5 rounded-full transition-all duration-300 ${on ? "h-7 bg-stone-900" : "h-2.5 bg-stone-300 group-hover:bg-stone-500"}`} />
          </button>
        );
      })}
    </nav>
  );
}
