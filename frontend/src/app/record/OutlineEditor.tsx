"use client";

// 발표 목차 입력 (선택) — 촬영·업로드 화면에서 시작하기 전에 쓴다.
// 프로젝트에 저장해 두므로 다음 회차에는 그대로 채워져 있고, 고치거나 추가·삭제할 수 있다.
// 목차가 있으면 구간 분리(STEP 4)가 이 항목들을 구간 이름으로 쓴다. 순서는 강제하지 않고,
// 말하지 않은 항목은 빠져도 된다. 비워 두면 지금처럼 자동으로 나눈다.

import { useState } from "react";
import { ChevronDown, ListOrdered, Plus, X } from "lucide-react";

// 백엔드 schemas/project.py 의 OUTLINE_MAX_ITEMS, OUTLINE_ITEM_MAX 와 같다
export const OUTLINE_MAX_ITEMS = 12;
const ITEM_MAX = 30;

interface Props {
  items: string[];
  onChange: (items: string[]) => void;
  className?: string;
}

export default function OutlineEditor({ items, onChange, className = "" }: Props) {
  // 저장된 목차가 있으면 펼쳐서 보여주고, 없으면 접어 둔다 (선택 기능이라 화면을 덜 차지하게)
  const [open, setOpen] = useState(items.length > 0);
  const filled = items.filter((x) => x.trim()).length;

  const update = (i: number, value: string) => onChange(items.map((x, k) => (k === i ? value : x)));
  const remove = (i: number) => onChange(items.filter((_, k) => k !== i));
  const add = () => {
    if (items.length < OUTLINE_MAX_ITEMS) onChange([...items, ""]);
  };

  return (
    // 선택 기능이지만 놓치기 쉬워서 눈에 띄게: 주황 강조 테두리 + 굵은 제목 + "추천" 표시
    <div className={`mb-4 bg-amber-50 border-2 border-amber-300 rounded-xl overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open && items.length === 0) onChange(["", "", ""]);   // 처음 펼치면 빈 칸 3개
        }}
        className="w-full flex items-center gap-2.5 px-4 py-3.5 text-left hover:bg-amber-100/60 transition-colors"
      >
        <ListOrdered className="w-5 h-5 text-amber-600 shrink-0" />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-base font-extrabold text-stone-900">발표 목차 입력</span>
            {filled ? (
              <span className="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">{filled}개</span>
            ) : (
              <span className="text-xs font-bold text-white bg-amber-500 px-2 py-0.5 rounded-full">추천</span>
            )}
          </span>
          <span className="block text-sm text-amber-800 mt-0.5">
            {filled ? "이 목차를 바탕으로 발표 구간을 나눠요" : "목차를 적으면 그 흐름대로 구간을 더 정확하게 나눠요 (선택)"}
          </span>
        </span>
        <ChevronDown className={`ml-auto w-5 h-5 text-amber-600 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-amber-200 bg-white">
          <p className="text-xs text-stone-500 leading-relaxed mt-3 mb-3">
            목차를 참고해서 발표 구간을 나눠요. 순서가 달라도, 말하지 않은 항목이 있어도 괜찮고,
            목차에 없는 내용을 길게 말하면 그 부분은 따로 이름을 붙여요. 비워 두면 자동으로 나누고,
            이 폴더의 다음 연습에도 그대로 불러와요.
          </p>
          <ol className="space-y-2">
            {items.map((item, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-5 text-xs font-bold text-stone-400 text-right shrink-0">{i + 1}</span>
                <input
                  value={item}
                  onChange={(e) => update(i, e.target.value)}
                  maxLength={ITEM_MAX}
                  placeholder={["예: 도입", "예: 문제 정의", "예: 해결 방법"][i] ?? "목차 항목"}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-stone-200 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`${i + 1}번 항목 삭제`}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ol>
          {items.length < OUTLINE_MAX_ITEMS && (
            <button
              type="button"
              onClick={add}
              className="mt-2 ml-7 flex items-center gap-1 text-sm font-semibold text-stone-500 hover:text-stone-800 transition-colors"
            >
              <Plus className="w-4 h-4" />
              항목 추가
            </button>
          )}
        </div>
      )}
    </div>
  );
}
