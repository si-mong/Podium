"use client";

// 서비스 안내 화면 — 로그인 전 첫 화면(/)과 로그인 후 홈(/home)이 똑같이 쓴다.
//   1) 가운데 떠 있는 알약 모양 상단 바 (Podium 워드마크 + 오른쪽 버튼)
//   2) 소개: Podium 워드마크 + 아주 큰 제목 + 사실 한 줄 + 검은 알약 버튼
//   3) 분석하는 항목: 항목이 하나씩 돌아가며 켜지고 아래에 설명이 바뀐다 (마우스를 올리면 그 항목에서 멈춤)
//   4) 이렇게 사용해요: 스크롤 따라 진행 — UsageSteps.tsx
// 디자인: 파란색 없이 검정·흰색·따뜻한 회색(stone)만 쓰고, 글꼴은 Pretendard (layout.tsx 에서 불러옴).
// 두 화면의 차이는 상단 오른쪽 버튼(headerActions)과 시작 버튼(primaryAction)뿐이다.

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Eye, Gauge, Hand, MessageCircleMore, Pause, PersonStanding, Repeat, type LucideIcon } from "lucide-react";
import UsageSteps from "./UsageSteps";

interface Props {
  headerActions: ReactNode; // 상단 오른쪽 버튼들 (로그인/회원가입 또는 내 기록/로그아웃)
  primaryAction: { label: string; onClick: () => void }; // 소개 아래 검은 버튼
  secondaryAction?: { label: string; onClick: () => void };
}

// 분석하는 항목 — 실제로 분석하는 것만 적는다 (음성: STEP3, 동작: STEP2)
const ANALYSIS_ITEMS: { name: string; desc: string; Icon: LucideIcon }[] = [
  { name: "발화 속도", desc: "1분에 몇 음절을 말하는지 재서 너무 빠르거나 느린 구간을 알려줘요.", Icon: Gauge },
  { name: "필러", desc: "‘음’, ‘어’ 같은 군말이 언제, 몇 번 나왔는지 세어 줘요.", Icon: MessageCircleMore },
  { name: "무음", desc: "말이 길게 끊긴 곳을 찾아 흐름이 멈춘 지점을 짚어 줘요.", Icon: Pause },
  { name: "반복", desc: "같은 말을 되풀이한 곳을 찾아 대본에 표시해 줘요.", Icon: Repeat },
  { name: "제스처", desc: "손동작이 언제, 얼마나 자주 나왔는지 구간별로 보여줘요.", Icon: Hand },
  { name: "시선", desc: "청중(카메라)을 바라보는지, 자료만 보고 있는지 확인해요.", Icon: Eye },
  { name: "자세", desc: "몸이 기울거나 흔들리지 않고 안정적인지 살펴봐요.", Icon: PersonStanding },
];
const ROTATE_MS = 2400;

// Podium 워드마크 (마이크가 o 자리에 들어간 로고). public/podium-logo.png — 투명 배경, 1237×309
export function PodiumLogo({ className }: { className?: string }) {
  return <Image src="/podium-logo.png" alt="Podium" width={1237} height={309} priority className={className} />;
}

// 분석하는 항목: 2.4초마다 다음 항목으로 넘어간다. 마우스를 올리거나 눌러서 고르면 그 항목에서 멈춘다.
// "애니메이션 줄이기"를 켠 사용자에게는 자동으로 넘기지 않는다.
function AnalysisItems() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(() => setActive((i) => (i + 1) % ANALYSIS_ITEMS.length), ROTATE_MS);
    return () => clearTimeout(t);
  }, [active, paused]);

  const item = ANALYSIS_ITEMS[active];
  return (
    <div onMouseLeave={() => setPaused(false)}>
      <p className="text-sm text-stone-500">분석하는 항목</p>
      <ul className="mt-5 flex flex-wrap justify-center gap-2">
        {ANALYSIS_ITEMS.map((it, i) => {
          const on = i === active;
          return (
            <li key={it.name}>
              <button
                type="button"
                onMouseEnter={() => { setActive(i); setPaused(true); }}
                onFocus={() => { setActive(i); setPaused(true); }}
                onClick={() => { setActive(i); setPaused(true); }}
                className={`relative overflow-hidden h-11 px-5 rounded-full text-[17px] font-bold tracking-tight transition-all duration-300 ${
                  on ? "bg-stone-900 text-white scale-105 shadow-md" : "bg-stone-100 text-stone-400 hover:text-stone-600"
                }`}
              >
                {it.name}
                {/* 다음 항목으로 넘어가기까지 남은 시간 */}
                {on && !paused && (
                  <span
                    key={active}
                    style={{ ["--fill-duration" as string]: `${ROTATE_MS}ms` }}
                    className="absolute left-0 bottom-0 h-[3px] w-full origin-left bg-white/40 motion-safe:animate-fill-x"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* 선택된 항목 설명 — 바뀔 때마다 살짝 올라오며 나타난다 */}
      <div
        key={active}
        className="mt-6 mx-auto max-w-md flex items-center gap-4 text-left rounded-2xl bg-stone-50 border border-stone-200 px-5 py-4 motion-safe:animate-fade-up"
      >
        <div className="w-11 h-11 rounded-xl bg-white border border-stone-200 flex items-center justify-center shrink-0">
          <item.Icon className="w-5 h-5 text-stone-800" />
        </div>
        <div>
          <div className="font-bold text-stone-900">{item.name}</div>
          <div className="text-sm text-stone-500 leading-relaxed">{item.desc}</div>
        </div>
      </div>
    </div>
  );
}

export default function ServiceGuide({ headerActions, primaryAction, secondaryAction }: Props) {
  return (
    <div className="min-h-screen bg-white text-stone-900 font-['Pretendard_Variable',Pretendard,sans-serif]">
      {/* 1) 상단 바 — 화면 가운데 떠 있는 알약 모양 */}
      <div className="sticky top-4 z-20 px-4">
        <header className="max-w-2xl mx-auto h-14 rounded-full bg-stone-100/90 backdrop-blur flex items-center justify-between gap-2 pl-5 sm:pl-6 pr-2">
          <PodiumLogo className="h-5 sm:h-6 w-auto shrink-0" />
          <div className="flex items-center gap-1">{headerActions}</div>
        </header>
      </div>

      <main className="max-w-5xl mx-auto px-6">
        {/* 2) 소개 */}
        <section className="pt-24 pb-16 text-center motion-safe:animate-fade-up">
          <PodiumLogo className="mx-auto h-12 md:h-14 w-auto" />

          <h1 className="mt-10 text-5xl md:text-6xl font-extrabold tracking-[-0.04em] leading-[1.1]">
            발표 연습,
            <br />
            혼자서도 쉽게!
          </h1>
          <p className="mt-6 text-lg text-stone-500 leading-relaxed">
            목소리와 제스처, 시선을 분석하고 발표를 내용 흐름에 따라 구간으로 나눠
            <br className="hidden md:block" />
            구간별 피드백과 전체 총평을 보여줍니다.
          </p>

          <div className="mt-8 flex items-center justify-center gap-2">
            <button
              onClick={primaryAction.onClick}
              className="h-11 px-5 rounded-full bg-stone-900 hover:bg-stone-700 text-white text-[15px] font-semibold transition-colors"
            >
              {primaryAction.label}
            </button>
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="h-11 pl-5 pr-2 rounded-full border border-stone-300 hover:bg-stone-50 text-[15px] font-semibold flex items-center gap-2 transition-colors"
              >
                {secondaryAction.label}
                <span className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center">
                  <ArrowRight className="w-4 h-4" />
                </span>
              </button>
            )}
          </div>

          {/* 3) 분석하는 항목 — 하나씩 돌아가며 켜진다 */}
          <div className="mt-20">
            <AnalysisItems />
          </div>
        </section>

        {/* 4) 이렇게 사용해요 — 스크롤하면 단계가 하나씩 켜지고 오른쪽 그림이 바뀐다 (UsageSteps.tsx) */}
        <section className="pt-16 border-t border-stone-200 motion-safe:animate-fade-up [animation-delay:80ms]">
          <h2 className="text-3xl font-extrabold tracking-[-0.03em]">이렇게 사용해요.</h2>
          <div className="mt-10">
            <UsageSteps />
          </div>
        </section>
      </main>

      <footer className="mt-16 border-t border-stone-200 py-8 text-center text-xs text-stone-400">
        © {new Date().getFullYear()} Podium ·{" "}
        <Link href="/terms" className="hover:text-stone-600 hover:underline">이용약관</Link> ·{" "}
        <Link href="/privacy" className="hover:text-stone-600 hover:underline">개인정보 처리방침</Link>
      </footer>
    </div>
  );
}
