"use client";

// "이렇게 사용해요" — 스크롤하면서 단계를 따라가는 안내 (ServiceGuide 가 쓴다).
//   왼쪽: 5단계 목록. 화면 가운데에 온 단계가 "지금 단계"가 되어 번호가 파랗게 켜지고,
//         지나온 단계 사이 세로선이 위에서부터 파랗게 차오른다.
//   오른쪽: 지금 단계의 화면을 작게 그린 미니 그림. 스크롤해도 화면에 고정된 채(sticky) 그림만 바뀐다.
//   좁은 화면(1024px 미만)에서는 오른쪽 그림 없이 목록만 보여준다.
// 미니 그림은 보여주기용 예시 내용이다 (서버를 부르지 않음).
//
// 빼고 싶으면: ServiceGuide.tsx 에서 <UsageSteps /> 를 지우면 된다.

import { useEffect, useRef, useState } from "react";
import { Check, Circle, Folder, Loader2, Plus, Presentation, User } from "lucide-react";

// 사용 순서 — 화면에 실제로 보이는 버튼·메뉴 이름을 「」로 적는다
const STEPS = [
  {
    title: "발표 주제 폴더 만들기",
    desc: "「내 기록」에서 「새 주제 폴더 추가」를 눌러 발표 주제별 폴더를 만들어요. 같은 발표를 여러 번 연습하면 이 폴더에 회차별로 쌓여요.",
  },
  {
    title: "발표 촬영하기",
    desc: "폴더를 열고 「발표 추가」 → 「영상촬영하기」를 눌러요. 촬영 페이지에서 발표 자료 PDF를 올리면 슬라이드를 보면서 촬영할 수 있어요. 이미 찍어 둔 영상이 있으면 「영상 업로드하기」를 고르세요.",
  },
  {
    title: "분석 시작하기",
    desc: "촬영을 마치고 「분석 시작」을 누르면 목소리 → 발표 구간 나누기 → 구간별 동작 → 피드백 순서로 분석해요. 몇 분 정도 걸리니 끝날 때까지 창을 닫지 말아 주세요.",
  },
  {
    title: "결과 확인하기",
    desc: "분석이 끝나면 「단일 분석」 화면으로 넘어가요. 구간별 지표, 종합 피드백, 영상과 스크립트, 구간별 피드백을 한 화면에서 볼 수 있어요.",
  },
  {
    title: "다시 연습하기",
    desc: "피드백을 참고해서 같은 폴더에서 다시 촬영해요. 회차가 쌓일수록 무엇이 나아졌는지 확인할 수 있어요.",
  },
];

export default function UsageSteps() {
  const [active, setActive] = useState(0); // 지금 단계 (0부터)
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);

  // 화면 세로 가운데 띠(위아래 45%를 뺀 10%)에 들어온 단계를 "지금 단계"로 정한다.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    itemRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-12">
      {/* 왼쪽: 단계 목록.
          lg:pb-[35vh]: 마지막 단계도 화면 가운데까지 스크롤해 올릴 수 있게 아래 여백을 둔다 (없으면 마지막 단계가 안 켜짐) */}
      <ol className="lg:pb-[35vh]">
        {STEPS.map((step, i) => {
          const reached = i <= active;
          return (
            <li
              key={step.title}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              data-index={i}
              // 단계마다 세로 공간을 넉넉히 줘서 스크롤하면 한 단계씩 가운데로 온다
              className="relative flex gap-5 pb-16 last:pb-0 lg:min-h-[220px]"
            >
              {/* 다음 단계로 이어지는 세로선: 회색 바탕 위에 파란 선이 위에서부터 차오른다 (마지막 단계엔 없음) */}
              {i < STEPS.length - 1 && (
                <span className="absolute left-4 top-10 bottom-1 w-0.5 -translate-x-1/2 bg-slate-200 rounded-full overflow-hidden" aria-hidden="true">
                  <span
                    className={`block w-full h-full bg-stone-900 origin-top motion-safe:transition-transform motion-safe:duration-500 ${
                      i < active ? "scale-y-100" : "scale-y-0"
                    }`}
                  />
                </span>
              )}
              <span
                className={`w-8 h-8 rounded-full text-sm font-extrabold flex items-center justify-center shrink-0 motion-safe:transition-colors motion-safe:duration-300 ${
                  reached ? "bg-stone-900 text-white" : "bg-slate-200 text-slate-500"
                }`}
              >
                {i + 1}
              </span>
              <div className="pt-1">
                <p className={`font-extrabold text-lg motion-safe:transition-colors ${i === active ? "text-slate-900" : "text-slate-500"}`}>
                  {step.title}
                </p>
                <p className={`mt-1.5 text-[15px] leading-relaxed max-w-xl motion-safe:transition-colors ${i === active ? "text-slate-600" : "text-slate-400"}`}>
                  {step.desc}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {/* 오른쪽: 지금 단계의 미니 그림 — 스크롤해도 화면에 붙어 있다 (넓은 화면에서만) */}
      <div className="hidden lg:block">
        <div className="sticky top-32">
          {/* key 가 바뀌면 새로 그려지면서 fade-up 애니메이션이 다시 나온다 */}
          <div key={active} className="motion-safe:animate-fade-up bg-white rounded-2xl border border-slate-200 shadow-xl shadow-slate-200/60 p-5 h-[300px] flex flex-col" aria-hidden="true">
            <p className="text-xs font-bold text-stone-500">STEP {active + 1}</p>
            <p className="text-sm font-extrabold text-slate-800 mt-0.5">{STEPS[active].title}</p>
            <div className="mt-4 flex-1 min-h-0">
              <StepPreview step={active} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 분석 진행 미니 그림 — 위에서부터 한 단계씩 "분석 중" → "완료"로 바뀌고, 마지막 "피드백 만들기"까지 완료되면 멈춘다.
// 이 그림이 다시 보일 때(3단계로 다시 스크롤해 오면) 처음부터 다시 진행된다 — UsageSteps 가 key 로 새로 그리기 때문.
// "애니메이션 줄이기"를 켠 사용자에게는 처음부터 전부 완료된 모습을 보여준다.
const ANALYSIS_STAGES = ["목소리 분석", "발표 구간 나누기", "구간별 동작 분석", "피드백 만들기"];
const STAGE_MS = 900; // 한 단계가 "분석 중"으로 보이는 시간

function AnalysisPreview() {
  // current: 지금 "분석 중"인 단계 번호. 그보다 앞은 완료, 뒤는 대기. 단계 수와 같으면 전부 완료.
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCurrent(ANALYSIS_STAGES.length);
      return;
    }
    const timer = setInterval(() => {
      setCurrent((c) => {
        if (c + 1 >= ANALYSIS_STAGES.length) clearInterval(timer); // 마지막 단계가 끝나면 멈춘다
        return Math.min(c + 1, ANALYSIS_STAGES.length);
      });
    }, STAGE_MS);
    return () => clearInterval(timer);
  }, []);

  const allDone = current >= ANALYSIS_STAGES.length;

  return (
    <div>
      <ul className="space-y-2.5">
        {ANALYSIS_STAGES.map((name, i) => {
          const state = i < current ? "done" : i === current ? "running" : "wait";
          return (
            <li
              key={name}
              className={`rounded-lg border px-3 py-2.5 flex items-center gap-2.5 text-[12px] font-bold motion-safe:transition-colors motion-safe:duration-300 ${
                state === "running" ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"
              }`}
            >
              {state === "done" && <Check className="w-4 h-4 text-green-600" />}
              {state === "running" && <Loader2 className="w-4 h-4 text-blue-600 motion-safe:animate-spin" />}
              {state === "wait" && <Circle className="w-4 h-4 text-slate-300" />}
              <span className={state === "wait" ? "text-slate-400" : "text-slate-700"}>{name}</span>
              <span className={`ml-auto text-[10px] ${state === "done" ? "text-green-600" : state === "running" ? "text-blue-600" : "text-slate-400"}`}>
                {state === "done" ? "완료" : state === "running" ? "분석 중" : "대기"}
              </span>
            </li>
          );
        })}
      </ul>
      {/* 전부 끝나면 안내 한 줄 */}
      <p className={`mt-3 text-center text-[11px] font-bold text-green-600 motion-safe:transition-opacity motion-safe:duration-300 ${allDone ? "opacity-100" : "opacity-0"}`}>
        분석이 끝났어요! 결과 화면으로 이동해요
      </p>
    </div>
  );
}

// 단계별 미니 그림 (실제 화면을 단순하게 줄인 모양)
function StepPreview({ step }: { step: number }) {
  const box = "rounded-lg border border-slate-200 bg-slate-50";

  if (step === 0) {
    // 내 기록 — 폴더 추가 버튼 + 폴더들
    return (
      <div className="h-full flex flex-col">
        <div className="self-end inline-flex items-center gap-1 bg-blue-600 text-white text-[11px] font-bold px-2.5 py-1.5 rounded-lg">
          <Plus className="w-3 h-3" />새 주제 폴더 추가
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {["가성비 밥집 소개", "캡스톤 중간발표", "영어 발표"].map((name) => (
            <div key={name} className="flex flex-col items-center text-center">
              <Folder className="w-12 h-12 text-amber-400 fill-amber-300" strokeWidth={1.5} />
              <p className="mt-1 text-[11px] font-bold text-slate-700 leading-tight">{name}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (step === 1) {
    // 촬영 페이지 — 슬라이드(PDF) 크게 + 카메라 작게 + 촬영 중 표시
    return (
      <div className="h-full flex flex-col gap-2">
        <div className={`${box} flex-1 flex items-center justify-center gap-2 text-slate-400`}>
          <Presentation className="w-5 h-5" />
          <span className="text-[11px] font-bold">발표 자료 슬라이드</span>
        </div>
        <div className="flex gap-2 items-stretch">
          <div className="relative w-28 aspect-video rounded-lg bg-slate-800 flex items-center justify-center">
            <User className="w-7 h-7 text-slate-500" />
            <span className="absolute top-1 left-1 flex items-center gap-1 bg-black/60 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
              <Circle className="w-1.5 h-1.5 text-red-500 fill-red-500" />
              촬영 중 00:42
            </span>
          </div>
          <div className="flex-1 rounded-lg bg-red-600 text-white text-[11px] font-bold flex items-center justify-center">촬영 종료</div>
        </div>
      </div>
    );
  }

  if (step === 2) return <AnalysisPreview />;

  if (step === 3) {
    // 단일 분석 화면 배치
    const cell = `${box} p-2 text-[10px] font-bold text-slate-500`;
    return (
      <div className="h-full grid grid-rows-[1fr_1fr_auto] gap-2">
        <div className="grid grid-cols-2 gap-2">
          <div className={`${cell} flex flex-col`}>
            구간별 지표
            <div className="mt-auto flex items-end gap-1 h-10">
              {[40, 75, 55, 90].map((h, i) => (
                <span key={i} className="flex-1 bg-purple-300 rounded-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          <div className={cell}>
            종합 피드백
            <div className="mt-2 space-y-1">
              <div className="h-1.5 bg-slate-300 rounded" />
              <div className="h-1.5 bg-slate-200 rounded w-4/5" />
              <div className="h-1.5 bg-slate-200 rounded w-3/5" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-slate-800 p-2 text-[10px] font-bold text-slate-400">영상</div>
          <div className={cell}>
            발표 스크립트
            <div className="mt-2 h-1.5 bg-yellow-200 rounded" />
            <div className="mt-1 h-1.5 bg-slate-200 rounded w-4/5" />
          </div>
        </div>
        <div className={`${cell} flex items-center gap-1.5`}>
          구간별 피드백
          <span className="ml-auto px-1.5 py-0.5 rounded-full border bg-green-100 text-green-700 border-green-200">잘한 점</span>
          <span className="px-1.5 py-0.5 rounded-full border bg-amber-100 text-amber-700 border-amber-200">개선할 점</span>
        </div>
      </div>
    );
  }

  // step 4: 다시 연습 — 회차가 쌓인 폴더 + 회차별 필러 수
  const sessions = [
    { name: "1회차 연습", filler: 12 },
    { name: "2회차 연습", filler: 9 },
    { name: "3회차 연습", filler: 5 },
  ];
  return (
    <ul className="space-y-2.5">
      {sessions.map((s) => (
        <li key={s.name} className={`${box} px-3 py-2.5 flex items-center gap-3 text-[12px] font-bold`}>
          <span className="text-slate-700">{s.name}</span>
          <span className="ml-auto text-[11px] text-slate-500">필러 {s.filler}회</span>
          <span className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <span className="block h-full bg-blue-500 rounded-full" style={{ width: `${(s.filler / 12) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
