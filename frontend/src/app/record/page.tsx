"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getPendingSlide } from "../slideStore";
import { ArrowLeft, Circle, Square, Sparkles, Loader2, AlertCircle, RotateCcw, CheckCircle2, Upload } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const CHUNK_MS = 30_000; // 전송용 청크 길이 (STEP1 전처리 단위, app/api/sessions.py CHUNK_DURATION_SEC와 동일)

type Phase = "idle" | "recording" | "finalizing" | "ready" | "analyzing" | "done" | "error";

// 진행 상황 로그 한 줄. kind로 아이콘·색을 정한다 (success=완료, warn=실패했지만 계속 진행, error=완전히 실패, info=진행 중).
type LogKind = "info" | "success" | "warn" | "error";
interface LogEntry {
  text: string;
  kind: LogKind;
}

// 초 -> "2분 5초" 같은 사람이 읽기 편한 표현 (0분이면 "5초"만).
function fmtDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}분 ${r}초` : `${r}초`;
}

// 업로드할 수 있는 영상 확장자 (백엔드 ALLOWED_VIDEO_SUFFIXES 와 같게 유지)
const ALLOWED_EXTS = [".mp4", ".mov", ".webm"];

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
  // ?mode=upload 이면 카메라 대신 영상 파일을 올려서 분석한다 (세션 관리의 "영상 업로드하기").
  const isUpload = searchParams.get("mode") === "upload";

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
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stepLabel, setStepLabel] = useState("AI 분석 중..."); // 분석 중일 때 화면에 보여줄 현재 단계
  const [analysisFailed, setAnalysisFailed] = useState(false); // 분석이 실패했으면 버튼 글자가 "분석 다시 시도"
  const [retaking, setRetaking] = useState(false); // 재촬영 처리(이전 영상 삭제) 중
  const [showStartNotice, setShowStartNotice] = useState(false); // "촬영 시작" 누르면 먼저 이 안내부터 뜨고, 확인해야 진짜 촬영 시작

  // 업로드 모드 전용
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null); // 고른 파일을 화면에서 미리 보기 위한 임시 주소
  const [dragOver, setDragOver] = useState(false);

  // 발표자료 PDF (세션 추가 창에서 골랐을 때만). 있으면 슬라이드 크게 + 카메라 작게 화면으로 바뀐다.
  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const hasSlide = !isUpload && slideUrl !== null;

  useEffect(() => {
    const file = isUpload ? null : getPendingSlide();
    if (!file) return;
    const url = URL.createObjectURL(file);
    setSlideUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isUpload]);

  const log =(text: string, kind: LogKind = "info") => setLogs((prev) => [...prev, { text, kind }]);

  // 파일을 고르면 미리보기 주소를 만들고, 파일이 바뀌거나 페이지를 떠나면 지운다 (메모리 정리).
  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

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
    }).catch(() => log("영상을 저장하는 중 잠깐 문제가 있었어요. 촬영은 계속 진행돼요.", "warn"));
    pendingUploadsRef.current.push(p);
  };

  const uploadFullVideo = (blob: Blob) => {
    const fd = new FormData();
    fd.append("file", blob, "full_video.webm");
    const p = fetch(`${API_BASE}/sessions/${sessionIdRef.current}/video`, {
      method: "POST",
      body: fd,
    })
      .catch(() => log("영상 파일을 저장하는 중 문제가 있었어요.", "warn"));
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
      setErrorMsg("발표 프로젝트 정보를 찾을 수 없어요. 세션 관리 화면에서 다시 시도해주세요.");
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
      log("카메라 연결 완료! 촬영을 시작합니다.", "success");

      chunkIndexRef.current = 0;
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
      setErrorMsg("카메라에 연결하지 못했어요. 브라우저의 카메라 권한을 확인해주세요.");
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
    log("촬영한 영상을 저장하고 있어요...");
    await Promise.allSettled(pendingUploadsRef.current);

    log("영상을 분석할 수 있게 준비하고 있어요...");
    try {
      const res = await fetch(`${API_BASE}/sessions/${sessionIdRef.current}/end`, { method: "POST" });
      if (!res.ok) throw new Error("전처리 실패");
      const data = await res.json();
      log(`영상 준비가 끝났어요! (총 ${fmtDuration(data.total_duration_sec ?? 0)} 분량)`, "success");
    } catch (err) {
      console.error(err);
      setErrorMsg("영상을 준비하는 중 문제가 생겼어요. 다시 시도해주세요.");
      setPhase("error");
      return;
    }
    // 분석은 자동으로 시작하지 않는다. "분석 시작"을 누르면 analyze(), "재촬영"을 누르면 retake() 가 실행된다.
    log('촬영이 끝났어요! "분석 시작"을 누르면 AI가 분석을 시작해요.', "success");
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
      setStepLabel("동작과 목소리를 분석하는 중이에요 (몇 분 정도 걸려요)");
      log("동작과 목소리를 살펴보고 있어요...");
      const [motion, voice] = await Promise.allSettled([
        callStep("/analyze/motion"),
        callStep("/analyze/voice"),
      ]);
      // 음성 결과 없이는 구간을 나눌 수 없어서 실패하면 멈춘다.
      if (voice.status === "rejected") throw new Error(`음성 분석 실패: ${errText(voice.reason)}`);
      log("목소리 분석을 마쳤어요.", "success");
      // 영상 분석은 실패해도 계속 진행한다 (제스처 값만 비게 됨).
      if (motion.status === "rejected") log("동작 분석에 문제가 있었지만, 나머지는 계속 진행할게요.", "warn");
      else log("동작 분석을 마쳤어요.", "success");

      setStepLabel("발표 내용을 구간으로 나누는 중이에요");
      const seg = await callStep("/analyze/segments");
      log(`발표를 ${seg.segment_count}개 구간으로 나눴어요.`, "success");

      // 구간별 피드백은 실패해도 앞 단계 결과는 볼 수 있으니 경고만 남기고 넘어간다.
      setStepLabel("구간별로 자세한 피드백을 만드는 중이에요");
      try {
        await callStep("/analyze/segment-feedback");
        log("구간별 피드백이 완성됐어요!", "success");
      } catch {
        log("구간별 피드백 생성에는 실패했어요. 다른 결과는 확인할 수 있어요.", "warn");
      }

      // 종합 피드백(발표 전체 총평)도 마찬가지로 실패해도 넘어간다.
      setStepLabel("전체 총평을 정리하는 중이에요");
      try {
        await callStep("/analyze/overall-feedback");
        log("전체 총평까지 완성됐어요!", "success");
      } catch {
        log("총평 생성에는 실패했어요. 나머지 결과는 확인할 수 있어요.", "warn");
      }

      log("분석이 모두 끝났습니다! 결과 화면으로 이동할게요.", "success");
      setPhase("done");
      router.push(`/dashboard?session=${sessionIdRef.current}`);
    } catch (err) {
      console.error(err);
      log(`분석에 실패했어요. (${errText(err)})`, "error");
      setErrorMsg("분석 중 문제가 발생했어요. 다시 시도해주세요.");
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
        log("이전 촬영본을 정리했어요. 다시 촬영을 시작할게요!", "success");
      }
      sessionIdRef.current = null;
      setAnalysisFailed(false);
    } catch (err) {
      console.error(err);
      setErrorMsg("이전 영상을 정리하지 못했어요. 다시 시도해주세요.");
      setRetaking(false);
      return;
    }
    await startRecording();
    setRetaking(false);
  };

  // ── 업로드 모드 ────────────────────────────────────────────────────────────

  // 파일을 골랐을 때 (클릭 선택·드래그 둘 다). 확장자가 안 맞으면 막는다.
  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      setErrorMsg("mp4, mov, webm 영상 파일만 올릴 수 있어요.");
      return;
    }
    setErrorMsg(null);
    setSelectedFile(file);
  };

  // 업로드 흐름: 세션 생성 → 영상 파일 저장 → 전처리(/end, 소리 추출).
  // 촬영 모드와 같은 API 를 쓰고, 30초 청크만 안 보낸다 (백엔드가 청크 없으면 전체 영상에서 소리를 뽑음).
  const startUpload = async () => {
    if (!projectId) {
      setErrorMsg("발표 프로젝트 정보를 찾을 수 없어요. 세션 관리 화면에서 다시 시도해주세요.");
      return;
    }
    if (!selectedFile) return;
    setErrorMsg(null);
    setLogs([]);
    setPhase("finalizing");
    try {
      const startRes = await fetch(`${API_BASE}/projects/${projectId}/sessions/start`, { method: "POST" });
      if (!startRes.ok) throw new Error("세션을 만들지 못했어요.");
      const session = await startRes.json();
      sessionIdRef.current = session.session_id;

      log("영상을 올리고 있어요... (파일이 크면 몇 분 걸릴 수 있어요)");
      const fd = new FormData();
      fd.append("file", selectedFile, selectedFile.name); // 백엔드가 파일 이름의 확장자로 저장 형식을 정한다
      const upRes = await fetch(`${API_BASE}/sessions/${session.session_id}/video`, { method: "POST", body: fd });
      const upData = await upRes.json().catch(() => ({}));
      if (!upRes.ok) throw new Error(upData.detail || "영상을 올리지 못했어요.");
      log("영상 업로드를 마쳤어요.", "success");

      log("영상을 분석할 수 있게 준비하고 있어요...");
      const endRes = await fetch(`${API_BASE}/sessions/${session.session_id}/end`, { method: "POST" });
      const endData = await endRes.json().catch(() => ({}));
      if (!endRes.ok) throw new Error(endData.detail || "영상을 준비하지 못했어요.");
      log(`영상 준비가 끝났어요! (총 ${fmtDuration(endData.total_duration_sec ?? 0)} 분량)`, "success");
    } catch (err) {
      console.error(err);
      log(`업로드에 실패했어요. (${errText(err)})`, "error");
      setErrorMsg("영상을 올리는 중 문제가 생겼어요. 다시 시도해주세요.");
      // 반쯤 만들어진 세션이 목록에 남지 않게 지운다.
      if (sessionIdRef.current) {
        await fetch(`${API_BASE}/sessions/${sessionIdRef.current}`, { method: "DELETE" }).catch(() => {});
        sessionIdRef.current = null;
      }
      setPhase("idle");
      return;
    }
    log('업로드가 끝났어요! "분석 시작"을 누르면 AI가 분석을 시작해요.', "success");
    setPhase("ready");
  };

  // 다른 영상 선택: 방금 올린 영상(세션)을 서버에서 지우고 파일 고르기부터 다시 한다. (촬영 모드의 "재촬영")
  const reselect = async () => {
    setRetaking(true);
    setErrorMsg(null);
    try {
      if (sessionIdRef.current) {
        const res = await fetch(`${API_BASE}/sessions/${sessionIdRef.current}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      sessionIdRef.current = null;
      setAnalysisFailed(false);
      setSelectedFile(null);
      setLogs([]);
      setPhase("idle");
    } catch (err) {
      console.error(err);
      setErrorMsg("이전 영상을 정리하지 못했어요. 다시 시도해주세요.");
    }
    setRetaking(false);
  };

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-6 px-4">
      {/* 화면 너비의 80%를 쓴다 (좁은 화면에서는 전체 너비).
          flex-1 로 화면 높이만큼 늘려서, 아래 촬영+로그 묶음이 세로 가운데에 오게 한다 */}
      <div className="w-full lg:w-[80vw] flex-1 flex flex-col">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-slate-500 hover:text-slate-800 font-semibold text-sm mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          세션 관리로 돌아가기
        </button>

        {/* 왼쪽 70%: (슬라이드) + 촬영 화면 + 버튼 / 오른쪽 30%: 활동 로그 (좁은 화면에서는 위아래로 쌓임) */}
        {/* my-auto: "돌아가기" 버튼 아래 남은 공간에서 위아래 여백을 똑같이 → 세로 가운데 정렬 */}
        <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-4 my-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
          <h1 className="text-xl font-extrabold text-slate-800 mb-1">{isUpload ? "발표 영상 업로드" : "발표 영상 촬영"}</h1>
          <p className="text-sm text-slate-500 mb-5">
            {isUpload
              ? "발표 영상 파일(mp4, mov, webm)을 올리고 \"분석 시작\" 버튼을 눌러주세요. AI가 자세와 목소리, 발표 흐름을 분석해드려요."
              : "촬영이 끝나면 \"분석 시작\" 버튼을 눌러주세요. AI가 자세와 목소리, 발표 흐름을 분석해드려요."}
          </p>

          {/* 발표자료 PDF 가 있으면 슬라이드를 크게 띄운다 (브라우저 기본 PDF 뷰어 — 화살표·스크롤로 넘김).
              높이를 화면의 55%로 정하고 #view=Fit 으로 한 장이 통째로 보이게 → 카메라까지 한 화면에 들어온다 */}
          {hasSlide && (
            <iframe
              src={`${slideUrl}#view=Fit`}
              title="발표 슬라이드"
              className="w-full h-[55vh] rounded-xl border border-slate-200 bg-slate-100 mb-4"
            />
          )}

          {/* 슬라이드가 있으면: 카메라(작게, 왼쪽) + 버튼(오른쪽)을 한 줄로 / 없으면: 위아래로 */}
          <div className={hasSlide ? "flex flex-col lg:flex-row lg:items-start gap-4" : ""}>

          {/* 촬영 모드: 카메라 화면 / 업로드 모드: 같은 자리에 파일 선택 칸 (고르면 미리보기로 바뀜)
              카메라 크기 — 슬라이드 있음: 카드 너비의 1/3 / 슬라이드 없음: 절반, 가운데 정렬 (좁은 화면에선 꽉 채움) */}
          <div
            className={`relative rounded-xl overflow-hidden aspect-video mb-4 ${
              hasSlide ? "w-full lg:w-1/3 shrink-0" : !isUpload ? "w-full lg:w-1/2 mx-auto" : ""
            } ${
              isUpload && !previewUrl
                ? `border-2 border-dashed transition-colors ${dragOver ? "border-blue-400 bg-blue-50" : "border-slate-300 bg-slate-50"}`
                : "bg-black"
            }`}
          >
            {!isUpload ? (
              <video ref={videoPreviewRef} autoPlay muted playsInline className="w-full h-full object-cover" />
            ) : previewUrl ? (
              <video src={previewUrl} controls playsInline className="w-full h-full object-contain" />
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  chooseFile(e.dataTransfer.files[0]);
                }}
                className="w-full h-full flex flex-col items-center justify-center gap-3 cursor-pointer hover:bg-blue-50 transition-colors"
              >
                <div className="w-14 h-14 rounded-full bg-white shadow-sm flex items-center justify-center">
                  <Upload className="w-7 h-7 text-blue-500" />
                </div>
                <p className="font-bold text-slate-700">클릭하거나 영상 파일을 여기로 끌어다 놓으세요</p>
                <p className="text-xs text-slate-400">mp4, mov, webm 파일을 올릴 수 있어요</p>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
              className="hidden"
              onChange={(e) => {
                chooseFile(e.target.files?.[0]);
                e.target.value = ""; // 같은 파일을 다시 골라도 onChange 가 불리게
              }}
            />
            {phase === "recording" && (
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/60 backdrop-blur-md text-white px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10">
                <Circle className="w-3 h-3 text-red-500 fill-red-500 animate-pulse" />
                촬영 중 · {mm}:{ss}
              </div>
            )}
            {(phase === "analyzing" || phase === "finalizing") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white text-center px-6">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="font-bold">
                  {phase === "finalizing" ? (isUpload ? "영상을 올리고 준비하는 중이에요..." : "영상을 준비하는 중이에요...") : stepLabel}
                </p>
                {phase === "analyzing" && (
                  <p className="text-xs text-slate-300">분석이 끝날 때까지 이 화면을 닫지 말아주세요.</p>
                )}
              </div>
            )}
          </div>

          {/* 버튼 + 오류 안내. 슬라이드 있으면 카메라 오른쪽 남은 칸을 채운다 */}
          <div className={hasSlide ? "flex-1 w-full" : ""}>
          {/* 버튼 줄도 촬영 모드(슬라이드 없음)에선 카메라와 같은 너비(절반)로 맞춘다 */}
          <div className={`flex items-center gap-3 mb-4 ${!isUpload && !hasSlide ? "w-full lg:w-1/2 mx-auto" : ""}`}>
            {isUpload && (phase === "idle" || phase === "error") ? (
              <>
                <button
                  onClick={startUpload}
                  disabled={!selectedFile}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  <Upload className="w-4 h-4" />
                  업로드 시작
                </button>
                {selectedFile && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-300 px-5 py-3 rounded-xl font-bold hover:bg-slate-50 shadow-sm transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    다른 파일 선택
                  </button>
                )}
              </>
            ) : phase === "idle" || phase === "error" ? (
              <button
                onClick={() => setShowStartNotice(true)}
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
                  onClick={isUpload ? reselect : retake}
                  disabled={retaking}
                  className="flex-1 flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-300 px-5 py-3 rounded-xl font-bold hover:bg-slate-50 shadow-sm transition-colors disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  {retaking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  {isUpload ? "다른 영상 선택" : "재촬영"}
                </button>
              </>
            ) : (
              <button
                disabled
                className="flex-1 flex items-center justify-center gap-2 bg-slate-300 text-white px-5 py-3 rounded-xl font-bold cursor-not-allowed"
              >
                <Loader2 className="w-4 h-4 animate-spin" />
                {phase === "finalizing" ? (isUpload ? "업로드 중..." : "영상 준비 중...") : "분석 중..."}
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
          </div>
        </div>

        {/* 진행 상황: 왼쪽 카드와 같은 높이로 늘어나고, 내용이 많으면 안에서 스크롤한다.
            (absolute 로 넣어서 로그가 길어져도 왼쪽 카드의 높이를 키우지 않는다) */}
        <div className="relative min-h-[260px]">
          <div className="absolute inset-0 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 text-sm font-bold text-slate-700 shrink-0">진행 상황</div>
            <div ref={logBoxRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {logs.length === 0 ? (
                <p className="text-sm text-slate-400 font-medium">
                  {isUpload ? "업로드를 시작하면" : "촬영을 시작하면"} 진행 상황이 여기에 표시됩니다.
                </p>
              ) : (
                logs.map((l, i) => {
                  const isLast = i === logs.length - 1;
                  const busy = isLast && (phase === "recording" || phase === "finalizing" || phase === "analyzing") && l.kind === "info";
                  return (
                    <div key={i} className="flex items-start gap-2.5">
                      {busy ? (
                        <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-blue-500 animate-spin" />
                      ) : l.kind === "success" ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />
                      ) : l.kind === "warn" ? (
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                      ) : l.kind === "error" ? (
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-500" />
                      ) : (
                        <span className="w-4 h-4 mt-0.5 shrink-0 flex items-center justify-center">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                        </span>
                      )}
                      <p className="text-sm text-slate-700 font-medium leading-relaxed break-words">{l.text}</p>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* 촬영 시작 전 안내 — 확인을 눌러야 실제로 촬영이 시작된다 */}
      {showStartNotice && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
            <p className="text-slate-800 font-bold text-[15px] leading-relaxed whitespace-pre-line">
              {"실수해도 괜찮아요 연습이니까요!\n재촬영 하지 말고 계속 촬영 진행해주세요!"}
            </p>
            <button
              onClick={() => {
                setShowStartNotice(false);
                startRecording();
              }}
              className="w-full mt-5 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors"
            >
              확인
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
