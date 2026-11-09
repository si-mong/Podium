"use client";

// 촬영 후 영상 방향 확인 — 휴대폰을 가로로 들었는데 '화면 방향 고정' 때문에 페이지가 세로로 남으면
// 세로 영상이 녹화돼서 사람이 옆으로 누워 있다. 촬영 중에 미리보기를 돌리면 들고 있는 방향과
// 화면이 어긋나 헷갈리므로, 촬영이 끝난 뒤 녹화본의 한 장면을 보여주고 방향을 고르게 한다.
// 고른 방향은 "분석 시작" 때 서버가 영상을 실제로 돌린다 (POST /sessions/{id}/video/rotate).

import { useEffect, useRef, useState } from "react";
import { RotateCcw, RotateCw } from "lucide-react";

export default function OrientationCheck({
  url,
  quarter,
  onChange,
}: {
  url: string;                          // 녹화본(전체 영상) 임시 주소
  quarter: number;                      // 시계 방향 90° 단위 (0~3)
  onChange: (quarter: number) => void;
}) {
  const frameRef = useRef<HTMLCanvasElement | null>(null); // 녹화본에서 뽑은 한 장면 (원래 방향)
  const viewRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  // 녹화본 0.5초 지점의 한 장면을 뽑는다. iPhone 은 seek 만으로 그림이 안 나올 때가 있어 재생으로도 시도한다.
  useEffect(() => {
    setReady(false);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    let done = false;
    const grab = () => {
      if (done || !v.videoWidth || !v.videoHeight) return;
      done = true;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0);
      frameRef.current = c;
      setReady(true);
    };
    const onLoaded = () => {
      try {
        v.currentTime = 0.5;
      } catch {}
    };
    v.addEventListener("loadeddata", onLoaded);
    v.addEventListener("seeked", grab);
    const fallback = setTimeout(() => {
      v.play()
        .then(() => setTimeout(() => {
          v.pause();
          grab();
        }, 300))
        .catch(() => {});
    }, 1500);
    return () => {
      clearTimeout(fallback);
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("seeked", grab);
      v.removeAttribute("src");
      v.load();
    };
  }, [url]);

  // 고른 방향으로 돌려 그린다
  useEffect(() => {
    const frame = frameRef.current;
    const view = viewRef.current;
    if (!ready || !frame || !view) return;
    const fw = frame.width;
    const fh = frame.height;
    view.width = quarter % 2 ? fh : fw;
    view.height = quarter % 2 ? fw : fh;
    const ctx = view.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(view.width / 2, view.height / 2);
    ctx.rotate((quarter * Math.PI) / 2);
    ctx.drawImage(frame, -fw / 2, -fh / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [ready, quarter]);

  const turn = (delta: number) => onChange((quarter + delta + 4) % 4);

  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
      <p className="font-bold text-stone-900 text-[15px]">영상 방향을 확인해 주세요</p>
      <p className="text-sm text-stone-600 mt-1 leading-relaxed">
        휴대폰을 가로로 들고 찍었다면 아래처럼 사람이 옆으로 누워 있을 수 있어요. 똑바로 서게 돌린 뒤 &ldquo;분석 시작&rdquo;을 눌러주세요.
        처음부터 세로로 찍었다면 그대로 두면 돼요.
      </p>
      <div className="flex justify-center my-3">
        {ready ? (
          <canvas ref={viewRef} className="max-h-56 max-w-full rounded-lg bg-black" />
        ) : (
          <div className="h-40 w-full max-w-xs rounded-lg bg-stone-200 animate-pulse" />
        )}
      </div>
      <div className="flex justify-center gap-2">
        <button
          onClick={() => turn(-1)}
          disabled={!ready}
          className="flex items-center gap-1.5 bg-white border border-stone-300 text-stone-700 px-3 py-2 rounded-lg text-sm font-bold hover:bg-stone-50 disabled:opacity-50"
        >
          <RotateCcw className="w-4 h-4" />
          왼쪽으로
        </button>
        <button
          onClick={() => turn(1)}
          disabled={!ready}
          className="flex items-center gap-1.5 bg-white border border-stone-300 text-stone-700 px-3 py-2 rounded-lg text-sm font-bold hover:bg-stone-50 disabled:opacity-50"
        >
          <RotateCw className="w-4 h-4" />
          오른쪽으로
        </button>
      </div>
    </div>
  );
}
