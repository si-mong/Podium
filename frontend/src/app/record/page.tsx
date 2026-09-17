"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Circle, Square, Sparkles, Loader2, AlertCircle } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const CHUNK_MS = 30_000; // 전송용 청크 길이 (STEP1 전처리 단위, app/api/sessions.py CHUNK_DURATION_SEC와 동일)

type Phase = "idle" | "recording" | "finalizing" | "ready" | "analyzing" | "done" | "error";

function pickMime() {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export default function RecordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project");

  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fullStreamRef = useRef<MediaStream | null>(null);
  const chunkRecorderRef = useRef<MediaRecorder | null>(null);
  const fullRecorderRef = useRef<MediaRecorder | null>(null);
  const fullPartsRef = useRef<Blob[]>([]);
  const chunkIndexRef = useRef(0);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingUploadsRef = useRef<Promise<unknown>[]>([]);
  const sessionIdRef = useRef<number | null>(null);
  const recordingRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const log = (msg: string) => setLogs((prev) => [...prev, msg]);

  // 페이지를 벗어날 때 카메라/타이머 정리
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      fullStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, []);

  const uploadChunk = (blob: Blob, idx: number) => {
    const fd = new FormData();
    fd.append("file", blob, `chunk_${String(idx).padStart(3, "0")}.webm`);
    const p = fetch(`${API_BASE}/sessions/${sessionIdRef.current}/chunks?chunk_index=${idx}`, {
      method: "POST",
      body: fd,
    })
      .then(() => {
        setChunkCount(idx + 1);
        log(`청크 ${idx} 업로드 완료`);
      })
      .catch((err) => log(`청크 ${idx} 업로드 실패: ${err}`));
    pendingUploadsRef.current.push(p);
  };

  const uploadFullVideo = (blob: Blob) => {
    const fd = new FormData();
    fd.append("file", blob, "full_video.webm");
    const p = fetch(`${API_BASE}/sessions/${sessionIdRef.current}/video`, {
      method: "POST",
      body: fd,
    })
      .then(() => log(`전체 영상 업로드 완료 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`))
      .catch((err) => log(`전체 영상 업로드 실패: ${err}`));
    pendingUploadsRef.current.push(p);
  };

  const startRecorderForChunk = () => {
    const idx = chunkIndexRef.current++;
    const parts: Blob[] = [];
    const mimeType = pickMime();
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current!, { mimeType })
      : new MediaRecorder(streamRef.current!);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(parts, { type: recorder.mimeType || "video/webm" });
      uploadChunk(blob, idx);
    };
    recorder.start();
    return recorder;
  };

  const rotateRecorder = () => {
    if (!recordingRef.current) return;
    const old = chunkRecorderRef.current;
    chunkRecorderRef.current = startRecorderForChunk();
    if (old && old.state === "recording") old.stop();
    chunkTimerRef.current = setTimeout(rotateRecorder, CHUNK_MS);
  };

  const startRecording = async () => {
    if (!projectId) {
      setErrorMsg("프로젝트 정보가 없습니다. 세션 관리 화면에서 다시 시도해주세요.");
      return;
    }
    setErrorMsg(null);
    setLogs([]); // 이전 촬영/분석 시도의 로그를 지우고 새로 시작
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      streamRef.current = stream;
      if (videoPreviewRef.current) videoPreviewRef.current.srcObject = stream;

      const startRes = await fetch(`${API_BASE}/projects/${projectId}/sessions/start`, { method: "POST" });
      if (!startRes.ok) throw new Error("세션 생성 실패");
      const session = await startRes.json();
      sessionIdRef.current = session.session_id;
      log(`세션 생성됨 (session_id=${session.session_id})`);

      chunkIndexRef.current = 0;
      setChunkCount(0);
      pendingUploadsRef.current = [];
      fullPartsRef.current = [];
      recordingRef.current = true;

      // 풀 recorder는 트랙을 clone() 한 별도 스트림에 붙인다 (동시 두 recorder 인코더 충돌 방지).
      const fullStream = new MediaStream(stream.getTracks().map((t) => t.clone()));
      fullStreamRef.current = fullStream;
      const fullMime = pickMime();
      const fullRecorder = fullMime
        ? new MediaRecorder(fullStream, { mimeType: fullMime })
        : new MediaRecorder(fullStream);
      fullRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) fullPartsRef.current.push(e.data);
      };
      fullRecorder.onstop = () => {
        const blob = new Blob(fullPartsRef.current, { type: fullRecorder.mimeType || "video/webm" });
        uploadFullVideo(blob);
      };
      fullRecorder.start();
      fullRecorderRef.current = fullRecorder;

      chunkRecorderRef.current = startRecorderForChunk();
      chunkTimerRef.current = setTimeout(rotateRecorder, CHUNK_MS);

      setElapsedSec(0);
      elapsedTimerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);

      setPhase("recording");
    } catch (err) {
      console.error(err);
      setErrorMsg("카메라 접근에 실패했습니다. 브라우저 권한을 확인해주세요.");
      setPhase("error");
    }
  };

  const stopRecording = async () => {
    recordingRef.current = false;
    if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);

    const stopPromises: Promise<void>[] = [];
    if (chunkRecorderRef.current && chunkRecorderRef.current.state === "recording") {
      stopPromises.push(
        new Promise((resolve) => {
          chunkRecorderRef.current!.addEventListener("stop", () => resolve(), { once: true });
          chunkRecorderRef.current!.stop();
        })
      );
    }
    if (fullRecorderRef.current && fullRecorderRef.current.state === "recording") {
      stopPromises.push(
        new Promise((resolve) => {
          fullRecorderRef.current!.addEventListener("stop", () => resolve(), { once: true });
          fullRecorderRef.current!.stop();
        })
      );
    }
    await Promise.all(stopPromises);

    streamRef.current?.getTracks().forEach((t) => t.stop());
    fullStreamRef.current?.getTracks().forEach((t) => t.stop());

    setPhase("finalizing");
    log("업로드 대기 중...");
    await Promise.allSettled(pendingUploadsRef.current);

    log("전처리 중 (오디오 추출)...");
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionIdRef.current}/end`, { method: "POST" });
      if (!res.ok) throw new Error("전처리 실패");
      const data = await res.json();
      log(`전처리 완료 (총 ${Math.round(data.total_duration_sec ?? 0)}초, 청크 ${data.chunk_count}개)`);
      setPhase("ready");
    } catch (err) {
      console.error(err);
      setErrorMsg("전처리에 실패했습니다.");
      setPhase("error");
    }
  };

  const analyze = async () => {
    if (!sessionIdRef.current) return;
    setPhase("analyzing");
    setErrorMsg(null);
    log("AI 분석 시작 (동작 인식 — 수십 초~수 분 소요될 수 있습니다)...");
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionIdRef.current}/analyze/motion`, { method: "POST" });
      if (!res.ok) throw new Error("분석 실패");
      const data = await res.json();
      log(`분석 완료 (${data.analyzed_count}/${data.chunk_count} 구간)`);
      setPhase("done");
      router.push(`/dashboard?session=${sessionIdRef.current}`);
    } catch (err) {
      console.error(err);
      setErrorMsg("분석에 실패했습니다. 다시 시도해주세요.");
      setPhase("error");
    }
  };

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-2xl">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 font-semibold text-sm mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          세션 관리로 돌아가기
        </button>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h1 className="text-xl font-extrabold text-slate-800 mb-1">발표 영상 촬영</h1>
          <p className="text-sm text-slate-500 mb-5">
            촬영이 끝나면 &quot;분석 시작&quot;을 눌러 AI 동작 분석을 진행하세요.
          </p>

          <div className="relative bg-black rounded-xl overflow-hidden aspect-video mb-4">
            <video ref={videoPreviewRef} autoPlay muted playsInline className="w-full h-full object-cover" />
            {phase === "recording" && (
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/60 backdrop-blur-md text-white px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10">
                <Circle className="w-3 h-3 text-red-500 fill-red-500 animate-pulse" />
                {mm}:{ss}
                <span className="text-slate-300 font-medium">· chunks {chunkCount}</span>
              </div>
            )}
            {(phase === "analyzing" || phase === "finalizing") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="font-bold">{phase === "finalizing" ? "전처리 중..." : "AI 분석 중..."}</p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mb-5">
            {phase === "idle" || phase === "error" ? (
              <button
                onClick={startRecording}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors"
              >
                <Circle className="w-4 h-4 fill-white" />
                촬영 시작
              </button>
            ) : phase === "recording" ? (
              <button
                onClick={stopRecording}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-red-700 shadow-sm transition-colors"
              >
                <Square className="w-4 h-4 fill-white" />
                촬영 종료
              </button>
            ) : phase === "ready" ? (
              <button
                onClick={analyze}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                분석 시작
              </button>
            ) : (
              <button
                disabled
                className="flex-1 flex items-center justify-center gap-2 bg-slate-300 text-white px-5 py-3 rounded-xl font-bold cursor-not-allowed"
              >
                <Loader2 className="w-4 h-4 animate-spin" />
                {phase === "finalizing" ? "전처리 중..." : "분석 중..."}
              </button>
            )}
          </div>

          {errorMsg && (
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-100 text-rose-700 rounded-xl p-3 mb-4 text-sm font-medium">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {errorMsg}
            </div>
          )}

          {logs.length > 0 && (
            <div className="bg-slate-900 text-slate-200 rounded-xl p-4 text-xs font-mono max-h-40 overflow-y-auto space-y-1">
              {logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
