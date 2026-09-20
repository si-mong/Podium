"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Circle, Square, Sparkles, Loader2, AlertCircle, RotateCcw } from "lucide-react";

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
  const logBoxRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stepLabel, setStepLabel] = useState("AI 분석 중..."); // 분석 중일 때 화면에 보여줄 현재 단계
  const [analysisFailed, setAnalysisFailed] = useState(false); // 분석이 실패했으면 버튼 글자가 "분석 다시 시도"
  const [retaking, setRetaking] = useState(false); // 재촬영 처리(이전 영상 삭제) 중

  const log = (msg: string) => setLogs((prev) => [...prev, msg]);

  // 로그가 쌓이면 맨 아래로 스크롤해서 최신 로그가 보이게 한다.
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);

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
    } catch (err) {
      console.error(err);
      setErrorMsg("전처리에 실패했습니다.");
      setPhase("error");
      return;
    }
    // 분석은 자동으로 시작하지 않는다. "분석 시작"을 누르면 analyze(), "재촬영"을 누르면 retake() 가 실행된다.
    log('촬영 완료. "분석 시작"을 누르면 분석하고, "재촬영"을 누르면 이 영상을 지우고 다시 촬영합니다.');
    setPhase("ready");
  };

  // 분석 단계 하나를 호출한다. 실패하면 서버가 알려준 이유(detail)를 담아 에러를 던진다.
  const callStep = async (path: string) => {
    const res = await fetch(`${API_BASE}/sessions/${sessionIdRef.current}${path}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  };

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // STEP 2~5를 차례로 실행한다. (실패하면 "ready" 상태로 돌아가 같은 세션으로 다시 시도할 수 있다)
  const analyze = async () => {
    if (!sessionIdRef.current) return;
    setPhase("analyzing");
    setErrorMsg(null);
    setAnalysisFailed(false);
    try {
      // STEP 2(영상)와 STEP 3(음성)은 서로 의존하지 않아 동시에 돌려서 시간을 줄인다.
      setStepLabel("영상·음성 분석 중 (수 분 걸릴 수 있어요)");
      log("STEP 2·3 시작: 동작 분석 + 음성 분석 (동시 실행)...");
      const [motion, voice] = await Promise.allSettled([
        callStep("/analyze/motion"),
        callStep("/analyze/voice"),
      ]);
      // 음성 결과 없이는 구간을 나눌 수 없어서 실패하면 멈춘다.
      if (voice.status === "rejected") throw new Error(`음성 분석 실패: ${errText(voice.reason)}`);
      log("STEP 3 음성 분석 완료");
      // 영상 분석은 실패해도 계속 진행한다 (제스처 값만 비게 됨).
      if (motion.status === "rejected") log(`STEP 2 동작 분석 실패 (제스처 없이 계속): ${errText(motion.reason)}`);
      else log(`STEP 2 동작 분석 완료 (${motion.value.analyzed_count}/${motion.value.chunk_count} 구간)`);

      setStepLabel("발표를 구간으로 나누는 중");
      const seg = await callStep("/analyze/segments");
      log(`STEP 4 구간 분리 완료 (${seg.segment_count}개 구간)`);

      // 구간별 피드백은 실패해도 앞 단계 결과는 볼 수 있으니 경고만 남기고 넘어간다.
      setStepLabel("구간별 피드백 생성 중");
      try {
        await callStep("/analyze/segment-feedback");
        log("STEP 5 구간별 피드백 완료");
      } catch (err) {
        log(`STEP 5 구간별 피드백 실패 (건너뜀): ${errText(err)}`);
      }

      setPhase("done");
      router.push(`/dashboard?session=${sessionIdRef.current}`);
    } catch (err) {
      console.error(err);
      setErrorMsg(`분석에 실패했습니다. ${errText(err)}`);
      setAnalysisFailed(true);
      setPhase("ready");
    }
  };

  // 재촬영: 방금 촬영한 영상(세션)을 서버에서 지우고 촬영을 처음부터 다시 시작한다.
  // 지운 세션이 그 프로젝트의 마지막 회차였으므로, 새 세션은 같은 회차 번호를 다시 받는다.
  const retake = async () => {
    setRetaking(true);
    setErrorMsg(null);
    try {
      const oldSessionId = sessionIdRef.current;
      if (oldSessionId) {
        const res = await fetch(`${API_BASE}/sessions/${oldSessionId}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log(`이전 영상 삭제됨 (session_id=${oldSessionId})`);
      }
      sessionIdRef.current = null;
      setAnalysisFailed(false);
    } catch (err) {
      console.error(err);
      setErrorMsg(`이전 영상을 지우지 못했습니다. 다시 시도해주세요. (${errText(err)})`);
      setRetaking(false);
      return;
    }
    await startRecording();
    setRetaking(false);
  };

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-6 px-4">
      {/* 화면 너비의 80%를 쓴다 (좁은 화면에서는 전체 너비) */}
      <div className="w-full lg:w-[80vw]">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 font-semibold text-sm mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          세션 관리로 돌아가기
        </button>

        {/* 왼쪽 70%: 촬영 화면 + 버튼 / 오른쪽 30%: 활동 로그 (좁은 화면에서는 위아래로 쌓임) */}
        <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
          <h1 className="text-xl font-extrabold text-slate-800 mb-1">발표 영상 촬영</h1>
          <p className="text-sm text-slate-500 mb-5">
            촬영이 끝나면 &quot;분석 시작&quot;을 눌러 AI 분석(동작·음성·구간 분리·피드백)을 진행하세요.
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
                <p className="font-bold">{phase === "finalizing" ? "전처리 중..." : stepLabel}</p>
                {phase === "analyzing" && (
                  <p className="text-xs text-slate-300">분석이 끝날 때까지 이 화면을 닫지 마세요.</p>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mb-4">
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
              <>
                <button
                  onClick={analyze}
                  disabled={retaking}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  <Sparkles className="w-4 h-4" />
                  {analysisFailed ? "분석 다시 시도" : "분석 시작"}
                </button>
                <button
                  onClick={retake}
                  disabled={retaking}
                  className="flex-1 flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-300 px-5 py-3 rounded-xl font-bold hover:bg-slate-50 shadow-sm transition-colors disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  {retaking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  재촬영
                </button>
              </>
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
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-100 text-rose-700 rounded-xl p-3 text-sm font-medium">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              {errorMsg}
            </div>
          )}
        </div>

        {/* 활동 로그: 왼쪽 카드와 같은 높이로 늘어나고, 로그가 많으면 안에서 스크롤한다.
            (absolute 로 넣어서 로그가 길어져도 왼쪽 카드의 높이를 키우지 않는다) */}
        <div className="relative min-h-[260px]">
          <div className="absolute inset-0 flex flex-col bg-slate-900 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 text-sm font-bold text-slate-200 shrink-0">활동 로그</div>
            <div ref={logBoxRef} className="flex-1 overflow-y-auto p-4 text-xs font-mono text-slate-200 space-y-1.5">
              {logs.length === 0 ? (
                <p className="text-slate-500">촬영을 시작하면 진행 상황이 여기에 표시됩니다.</p>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="break-words">
                    {l}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
