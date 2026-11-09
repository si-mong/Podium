"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Camera, SwitchCamera, Circle, Square, Sparkles, Loader2, AlertCircle, RotateCcw, CheckCircle2, Upload, FileText } from "lucide-react";

// API 호출은 apiFetch (로그인 토큰 자동 첨부, 만료 시 자동 갱신) — frontend/src/utils/api.ts
import { apiFetch } from "@/utils/api";
import { runAnalysis } from "@/utils/analysis";
import { isLoggedIn } from "@/utils/auth";
import { startBackgroundBlur, BlurredCamera } from "./backgroundBlur";
const CHUNK_MS = 30_000; // 전송용 청크 길이 (STEP1 전처리 단위, app/api/sessions.py CHUNK_DURATION_SEC와 동일)

// previewing = 카메라만 켜고 아직 녹화 전 (구도를 맞추는 단계)
type Phase = "idle" | "previewing" | "recording" | "finalizing" | "ready" | "analyzing" | "done" | "error";

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

// 카메라를 못 켰을 때 원인별 안내 문구. 모바일은 권한 팝업 없이 바로 거부되는 경우가 많아서
// 어디서 권한을 켜야 하는지까지 알려준다.
function cameraErrorMessage(err: unknown): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\//i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
  const isAndroid = /Android/i.test(ua);

  if (inApp) {
    return "앱 안 브라우저(카카오톡·인스타그램 등)에서는 카메라를 쓸 수 없어요. 오른쪽 위 메뉴에서 \"다른 브라우저로 열기\"를 눌러 Chrome이나 Safari로 열어주세요.";
  }
  if (typeof window !== "undefined" && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
    return "이 브라우저에서는 카메라를 쓸 수 없어요. 최신 Chrome이나 Safari로 열어주세요.";
  }
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (isIOS) return "카메라·마이크 권한이 꺼져 있어요. iPhone 설정 앱 → 사용 중인 브라우저(Chrome 또는 Safari) → 카메라·마이크를 켠 뒤, 브라우저를 완전히 껐다가 다시 열어주세요.";
    if (isAndroid) return "카메라·마이크 권한이 꺼져 있어요. 주소창 왼쪽 아이콘 → 권한에서 허용하거나, 휴대폰 설정 → 애플리케이션 → Chrome → 권한에서 카메라·마이크를 켜주세요.";
    return "카메라·마이크 권한이 꺼져 있어요. 주소창 왼쪽 아이콘을 눌러 카메라·마이크를 허용한 뒤 새로고침해주세요.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "카메라나 마이크를 찾지 못했어요. 기기에 연결돼 있는지 확인해주세요.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "다른 앱(Zoom, 카메라 앱 등)이 카메라를 쓰고 있어요. 그 앱을 끄고 다시 시도해주세요.";
  }
  return "카메라를 켜지 못했어요. 페이지를 새로고침한 뒤 다시 시도해주세요.";
}

function RecordPage() {
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
  const blurRef = useRef<BlurredCamera | null>(null); // 배경 흐림을 켜고 촬영 중일 때만 값이 있다

  // 배경 흐리게 — 촬영 시작 전에만 바꿀 수 있다. 마지막 선택은 브라우저에 기억해 둔다.
  const [blurOn, setBlurOn] = useState(false);
  useEffect(() => {
    try {
      setBlurOn(localStorage.getItem("podium.backgroundBlur") === "on");
    } catch {}
  }, []);
  const changeBlur = (on: boolean) => {
    setBlurOn(on);
    try {
      localStorage.setItem("podium.backgroundBlur", on ? "on" : "off");
    } catch {}
    // 미리보기 중에 바꾸면 카메라를 다시 켜서 바로 보이게 한다
    if (phase === "previewing") openCamera(on);
  };
  const [cameraBusy, setCameraBusy] = useState(false); // 카메라(배경 흐림 포함)를 켜는 중
  // 전면(user)/후면(environment) 카메라. 후면은 휴대폰을 세워 두고 찍거나 다른 사람이 찍어 줄 때 쓴다.
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [canSwitch, setCanSwitch] = useState(false); // 카메라가 2개 이상일 때만 전환 버튼을 보여준다
  // 전면 카메라는 거울처럼 좌우를 뒤집어 보여준다 (화면에서만, 녹화 파일은 원래 방향 그대로)
  const [mirrored, setMirrored] = useState(true);
  // 카메라 영상의 가로/세로 비율. 휴대폰 방향에 따라 바뀌고, 촬영 화면 틀도 이 비율을 따른다.
  const [videoAspect, setVideoAspect] = useState(16 / 9);

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

  // 발표자료 PDF (촬영 모드에서 촬영 시작 전에 고름, 선택). 있으면 슬라이드 크게 + 카메라 작게 화면으로 바뀐다.
  // 서버에는 저장하지 않고 이 화면에서 보여주기만 한다.
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [slideFile, setSlideFile] = useState<File | null>(null);
  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const hasSlide = !isUpload && slideUrl !== null;

  // PDF 를 고르면 화면에 띄울 임시 주소를 만들고, 바꾸거나 빼거나 페이지를 떠나면 지운다 (메모리 정리).
  useEffect(() => {
    if (!slideFile) {
      setSlideUrl(null);
      return;
    }
    const url = URL.createObjectURL(slideFile);
    setSlideUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [slideFile]);

  const choosePdf = (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setPdfError("PDF 파일만 올릴 수 있어요. PPT는 PDF로 저장해서 올려주세요.");
      return;
    }
    setPdfError(null);
    setSlideFile(file);
  };

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

  // 로그인 안 한 상태로 들어오면 바로 로그인 화면으로
  useEffect(() => {
    if (!isLoggedIn()) router.replace("/login");
  }, [router]);

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
      blurRef.current?.stop();
      if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, []);

  const uploadChunk = (blob: Blob, idx: number) => {
    const fd = new FormData();
    fd.append("file", blob, `chunk_${String(idx).padStart(3, "0")}.webm`);
    const p = apiFetch(`/sessions/${sessionIdRef.current}/chunks?chunk_index=${idx}`, {
      method: "POST",
      body: fd,
    }).catch(() => log("영상을 저장하는 중 잠깐 문제가 있었어요. 촬영은 계속 진행돼요.", "warn"));
    pendingUploadsRef.current.push(p);
  };

  const uploadFullVideo = (blob: Blob) => {
    const fd = new FormData();
    fd.append("file", blob, "full_video.webm");
    const p = apiFetch(`/sessions/${sessionIdRef.current}/video`, {
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

  // 카메라를 끈다. 배경 흐림을 썼으면 blur.stop() 이 원본 카메라까지 끈다.
  const closeCamera = () => {
    blurRef.current?.stop();
    blurRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
  };

  // 1단계: 카메라만 켜서 미리보기를 띄운다. 녹화는 "촬영 시작"을 눌러야 시작된다.
  const openCamera = async (blur: boolean = blurOn, face: "user" | "environment" = facing) => {
    setErrorMsg(null);
    setLogs([]); // 이전 촬영/분석 시도의 로그를 지우고 새로 시작
    setCameraBusy(true);
    closeCamera();
    let camera: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia 없음");
      camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: face }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch (err) {
      console.error(err);
      setErrorMsg(cameraErrorMessage(err));
      setPhase("error");
      setCameraBusy(false);
      return;
    }
    // 배경 흐림을 켰으면 흐린 영상을 보여주고 녹화한다. 준비에 실패하면 원본으로 그냥 촬영한다.
    // 실제로 켜진 카메라 방향 (PC 웹캠은 값이 없어서 요청한 방향으로 본다)
    const actualFacing = camera.getVideoTracks()[0]?.getSettings().facingMode;
    setMirrored((actualFacing ?? face) !== "environment");
    // 카메라 이름 목록은 권한을 받은 뒤에야 정확히 나온다
    navigator.mediaDevices
      .enumerateDevices()
      .then((ds) => setCanSwitch(ds.filter((d) => d.kind === "videoinput").length > 1))
      .catch(() => {});
    let stream = camera;
    if (blur) {
      log("배경을 흐리게 만드는 중이에요...");
      try {
        blurRef.current = await startBackgroundBlur(camera);
        stream = blurRef.current.stream;
        log("배경 흐림을 켰어요.", "success");
      } catch (err) {
        console.error(err);
        log("배경 흐림을 켜지 못해서 원래 화면으로 촬영할게요.", "warn");
      }
    }
    streamRef.current = stream;
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = stream;
    log('카메라를 켰어요. 얼굴과 상반신이 화면에 잘 들어오는지 확인하고 "촬영 시작"을 눌러주세요.', "success");
    setPhase("previewing");
    setCameraBusy(false);
  };

  // 미리보기 중 전면 ↔ 후면 전환
  const switchCamera = () => {
    const next = facing === "user" ? "environment" : "user";
    setFacing(next);
    openCamera(blurOn, next);
  };

  // 2단계: 켜 둔 카메라로 세션을 만들고 녹화를 시작한다.
  const startRecording = async () => {
    if (!projectId) {
      setErrorMsg("발표 프로젝트 정보를 찾을 수 없어요. 세션 관리 화면에서 다시 시도해주세요.");
      return;
    }
    const stream = streamRef.current;
    if (!stream) return; // 카메라를 먼저 켜야 한다
    setErrorMsg(null);
    let createdSession: number | null = null;
    try {
      const startRes = await apiFetch(`/projects/${projectId}/sessions/start`, { method: "POST" });
      if (!startRes.ok) throw new Error("세션 생성 실패");
      const session = await startRes.json();
      createdSession = session.session_id;
      sessionIdRef.current = session.session_id;

      chunkIndexRef.current = 0;
      pendingUploadsRef.current = [];
      fullPartsRef.current = [];

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
      recordingRef.current = true;
      blurRef.current?.setLocked(true); // 녹화 중에는 휴대폰을 돌려도 녹화 크기를 바꾸지 않는다
      fullRecorder.start();
      fullRecorderRef.current = fullRecorder;

      chunkRecorderRef.current = startRecorderForChunk();
      chunkTimerRef.current = setTimeout(rotateRecorder, CHUNK_MS);

      setElapsedSec(0);
      elapsedTimerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);

      log("촬영을 시작했어요!", "success");
      setPhase("recording");
    } catch (err) {
      console.error(err);
      // 녹화를 시작하다 실패하면 녹화기·타이머만 정리하고, 카메라는 켜 둔 채 미리보기로 돌아간다.
      recordingRef.current = false;
      blurRef.current?.setLocked(false);
      if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      for (const r of [chunkRecorderRef.current, fullRecorderRef.current]) {
        if (r && r.state === "recording") {
          r.onstop = null; // 반쯤 녹화된 영상을 올리지 않게
          r.stop();
        }
      }
      chunkRecorderRef.current = null;
      fullRecorderRef.current = null;
      fullStreamRef.current?.getTracks().forEach((t) => t.stop());
      fullStreamRef.current = null;
      // 세션까지 만들었으면 빈 회차가 남지 않게 지운다.
      if (createdSession) {
        await apiFetch(`/sessions/${createdSession}`, { method: "DELETE" }).catch(() => {});
        sessionIdRef.current = null;
      }
      setErrorMsg(
        createdSession
          ? "이 브라우저에서는 녹화를 시작하지 못했어요. 최신 Chrome이나 Safari로 다시 시도해주세요."
          : "서버에 연결하지 못해 촬영을 시작하지 못했어요. 잠시 후 다시 시도해주세요."
      );
      setPhase("previewing");
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
    blurRef.current?.stop(); // 배경 흐림을 썼으면 원본 카메라도 여기서 꺼진다
    blurRef.current = null;

    setPhase("finalizing");
    log("촬영한 영상을 저장하고 있어요...");
    await Promise.allSettled(pendingUploadsRef.current);

    log("영상을 분석할 수 있게 준비하고 있어요...");
    try {
      const res = await apiFetch(`/sessions/${sessionIdRef.current}/end`, { method: "POST" });
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

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // STEP 3~5를 차례로 실행한다 (utils/analysis.ts). 실패하면 "ready" 상태로 돌아가 같은 세션으로 다시 시도할 수 있다.
  const analyze = async () => {
    if (!sessionIdRef.current) return;
    setPhase("analyzing");
    setErrorMsg(null);
    setAnalysisFailed(false);
    try {
      await runAnalysis(sessionIdRef.current, { onStep: setStepLabel, onLog: log });

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
        const res = await apiFetch(`/sessions/${oldSessionId}`, { method: "DELETE" });
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
    await openCamera(); // 바로 녹화하지 않고 미리보기부터 다시 띄운다
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
      const startRes = await apiFetch(`/projects/${projectId}/sessions/start`, { method: "POST" });
      if (!startRes.ok) throw new Error("세션을 만들지 못했어요.");
      const session = await startRes.json();
      sessionIdRef.current = session.session_id;

      log("영상을 올리고 있어요... (파일이 크면 몇 분 걸릴 수 있어요)");
      const fd = new FormData();
      fd.append("file", selectedFile, selectedFile.name); // 백엔드가 파일 이름의 확장자로 저장 형식을 정한다
      const upRes = await apiFetch(`/sessions/${session.session_id}/video`, { method: "POST", body: fd });
      const upData = await upRes.json().catch(() => ({}));
      if (!upRes.ok) throw new Error(upData.detail || "영상을 올리지 못했어요.");
      log("영상 업로드를 마쳤어요.", "success");

      log("영상을 분석할 수 있게 준비하고 있어요...");
      const endRes = await apiFetch(`/sessions/${session.session_id}/end`, { method: "POST" });
      const endData = await endRes.json().catch(() => ({}));
      if (!endRes.ok) throw new Error(endData.detail || "영상을 준비하지 못했어요.");
      log(`영상 준비가 끝났어요! (총 ${fmtDuration(endData.total_duration_sec ?? 0)} 분량)`, "success");
    } catch (err) {
      console.error(err);
      log(`업로드에 실패했어요. (${errText(err)})`, "error");
      setErrorMsg("영상을 올리는 중 문제가 생겼어요. 다시 시도해주세요.");
      // 반쯤 만들어진 세션이 목록에 남지 않게 지운다.
      if (sessionIdRef.current) {
        await apiFetch(`/sessions/${sessionIdRef.current}`, { method: "DELETE" }).catch(() => {});
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
        const res = await apiFetch(`/sessions/${sessionIdRef.current}`, { method: "DELETE" });
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
    <div className="min-h-screen bg-stone-50 flex flex-col items-center py-6 px-4 font-['Pretendard_Variable',Pretendard,sans-serif]">
      {/* 화면 너비의 80%를 쓴다 (좁은 화면에서는 전체 너비).
          flex-1 로 화면 높이만큼 늘려서, 아래 촬영+로그 묶음이 세로 가운데에 오게 한다 */}
      <div className="w-full lg:w-[80vw] flex-1 flex flex-col">
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 text-stone-500 hover:text-stone-800 font-semibold text-sm mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          세션 관리로 돌아가기
        </button>

        {/* 왼쪽 70%: (슬라이드) + 촬영 화면 + 버튼 / 오른쪽 30%: 활동 로그 (좁은 화면에서는 위아래로 쌓임) */}
        {/* my-auto: "돌아가기" 버튼 아래 남은 공간에서 위아래 여백을 똑같이 → 세로 가운데 정렬 */}
        <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-4 my-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-5">
          <h1 className="text-xl font-extrabold text-stone-800 mb-1">{isUpload ? "발표 영상 업로드" : "발표 영상 촬영"}</h1>
          <p className="text-sm text-stone-500 mb-5">
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
              className="w-full h-[55vh] rounded-xl border border-stone-200 bg-stone-100 mb-4"
            />
          )}

          {/* 슬라이드가 있으면: 카메라(작게, 왼쪽) + 버튼(오른쪽)을 한 줄로 / 없으면: 위아래로 */}
          <div className={hasSlide ? "flex flex-col lg:flex-row lg:items-start gap-4" : ""}>

          {/* 촬영 모드: 카메라 화면 / 업로드 모드: 같은 자리에 파일 선택 칸 (고르면 미리보기로 바뀜)
              카메라 크기 — 슬라이드 있음: 카드 너비의 1/3 / 슬라이드 없음: 절반, 가운데 정렬 (좁은 화면에선 꽉 채움) */}
          <div
            // 촬영 모드: 틀을 카메라 영상 비율에 맞추고(가로/세로), 화면 높이의 70%를 넘지 않게 한다 (휴대폰 가로 화면에서도 한눈에)
            style={!isUpload ? { aspectRatio: videoAspect, maxWidth: `calc(70svh * ${videoAspect})` } : undefined}
            className={`relative rounded-xl overflow-hidden mb-4 ${isUpload ? "aspect-video" : "mx-auto"} ${
              hasSlide ? "w-full lg:w-1/3 shrink-0" : !isUpload ? "w-full lg:w-1/2" : ""
            } ${
              isUpload && !previewUrl
                ? `border-2 border-dashed transition-colors ${dragOver ? "border-stone-500 bg-stone-100" : "border-stone-300 bg-stone-50"}`
                : "bg-black"
            }`}
          >
            {!isUpload ? (
              <>
                <video
                  ref={videoPreviewRef}
                  autoPlay
                  muted
                  playsInline
                  onResize={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight);
                  }}
                  className={`w-full h-full object-cover ${mirrored ? "-scale-x-100" : ""}`}
                />
                {(phase === "idle" || phase === "error") && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#a8a29e] text-center px-6">
                    {cameraBusy ? <Loader2 className="w-8 h-8 animate-spin" /> : <Camera className="w-8 h-8" />}
                    <p className="text-sm font-semibold">{cameraBusy ? "카메라를 켜는 중이에요..." : "카메라를 켜면 여기에 미리보기가 나와요"}</p>
                  </div>
                )}
                {phase === "previewing" && (
                  <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md text-[#ffffff] px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10">
                    미리보기 · 아직 녹화 전이에요
                  </div>
                )}
                {phase === "previewing" && canSwitch && (
                  <button
                    onClick={switchCamera}
                    disabled={cameraBusy}
                    className="absolute bottom-3 right-3 flex items-center gap-1.5 bg-black/60 backdrop-blur-md text-[#ffffff] px-3 py-2 rounded-lg text-sm font-bold border border-white/10 hover:bg-black/75 disabled:opacity-50"
                  >
                    {cameraBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <SwitchCamera className="w-4 h-4" />}
                    {facing === "user" ? "후면 카메라로" : "전면 카메라로"}
                  </button>
                )}
              </>
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
                className="w-full h-full flex flex-col items-center justify-center gap-3 cursor-pointer hover:bg-stone-100 transition-colors"
              >
                <div className="w-14 h-14 rounded-full bg-white shadow-sm flex items-center justify-center">
                  <Upload className="w-7 h-7 text-stone-700" />
                </div>
                <p className="font-bold text-stone-700">클릭하거나 영상 파일을 여기로 끌어다 놓으세요</p>
                <p className="text-xs text-stone-400">mp4, mov, webm 파일을 올릴 수 있어요</p>
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
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/60 backdrop-blur-md text-[#ffffff] px-3 py-1.5 rounded-lg text-sm font-bold border border-white/10">
                <Circle className="w-3 h-3 text-red-500 fill-red-500 animate-pulse" />
                촬영 중 · {mm}:{ss}
              </div>
            )}
            {(phase === "analyzing" || phase === "finalizing") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-[#ffffff] text-center px-6">
                {/* 덮개는 다크 모드에서도 검정이라 글자색을 고정한다 (white·stone 은 다크 모드에서 어둡게 바뀜) */}
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="font-bold">
                  {phase === "finalizing" ? (isUpload ? "영상을 올리고 준비하는 중이에요..." : "영상을 준비하는 중이에요...") : stepLabel}
                </p>
                {phase === "analyzing" && (
                  <p className="text-xs text-[#e7e5e4]">분석이 끝날 때까지 이 화면을 닫지 말아주세요.</p>
                )}
              </div>
            )}
          </div>

          {/* 버튼 + 오류 안내. 슬라이드 있으면 카메라 오른쪽 남은 칸을 채운다 */}
          <div className={hasSlide ? "flex-1 w-full" : ""}>
          {/* 휴대폰을 세로로 들고 있거나, 가로로 돌렸는데 화면 방향이 고정돼 있으면 영상이 세로로 찍힌다 */}
          {!isUpload && phase === "previewing" && videoAspect < 1 && (
            <div className={`flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-sm font-medium mb-4 ${!hasSlide ? "w-full lg:w-1/2 mx-auto" : ""}`}>
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                지금은 세로 화면으로 찍혀요. 휴대폰을 가로로 돌려주세요.
                돌려도 화면이 그대로라면 iPhone은 제어 센터의 &lsquo;화면 방향 고정&rsquo;을 끄고, Android는 &lsquo;자동 회전&rsquo;을 켜주세요.
              </span>
            </div>
          )}
          {/* 버튼 줄도 촬영 모드(슬라이드 없음)에선 카메라와 같은 너비(절반)로 맞춘다 */}
          <div className={`flex items-center gap-3 mb-4 ${!isUpload && !hasSlide ? "w-full lg:w-1/2 mx-auto" : ""}`}>
            {isUpload && (phase === "idle" || phase === "error") ? (
              <>
                <button
                  onClick={startUpload}
                  disabled={!selectedFile}
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors disabled:bg-stone-300 disabled:cursor-not-allowed"
                >
                  <Upload className="w-4 h-4" />
                  업로드 시작
                </button>
                {selectedFile && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 flex items-center justify-center gap-2 bg-white text-stone-700 border border-stone-300 px-5 py-3 rounded-xl font-bold hover:bg-stone-50 shadow-sm transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    다른 파일 선택
                  </button>
                )}
              </>
            ) : phase === "idle" || phase === "error" ? (
              <button
                onClick={() => openCamera()}
                disabled={cameraBusy}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors disabled:bg-stone-300 disabled:cursor-not-allowed"
              >
                {cameraBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                {cameraBusy ? "카메라 켜는 중..." : "카메라 켜기"}
              </button>
            ) : phase === "previewing" ? (
              <button
                onClick={() => setShowStartNotice(true)}
                disabled={cameraBusy}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors disabled:bg-stone-300 disabled:cursor-not-allowed"
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
                  className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-sm transition-colors disabled:bg-stone-300 disabled:cursor-not-allowed"
                >
                  <Sparkles className="w-4 h-4" />
                  {analysisFailed ? "분석 다시 시도" : "분석 시작"}
                </button>
                <button
                  onClick={isUpload ? reselect : retake}
                  disabled={retaking}
                  className="flex-1 flex items-center justify-center gap-2 bg-white text-stone-700 border border-stone-300 px-5 py-3 rounded-xl font-bold hover:bg-stone-50 shadow-sm transition-colors disabled:text-stone-400 disabled:cursor-not-allowed"
                >
                  {retaking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  {isUpload ? "다른 영상 선택" : "재촬영"}
                </button>
              </>
            ) : (
              <button
                disabled
                className="flex-1 flex items-center justify-center gap-2 bg-stone-300 text-white px-5 py-3 rounded-xl font-bold cursor-not-allowed"
              >
                <Loader2 className="w-4 h-4 animate-spin" />
                {phase === "finalizing" ? (isUpload ? "업로드 중..." : "영상 준비 중...") : "분석 중..."}
              </button>
            )}
          </div>

          {/* 배경 흐리게 켜기/끄기 — 녹화 전(미리보기 포함)에만 보인다. 미리보기 중에 바꾸면 바로 반영된다 */}
          {!isUpload && (phase === "idle" || phase === "error" || phase === "previewing") && (
            <label className={`flex items-center gap-3 mb-4 cursor-pointer select-none ${!hasSlide ? "w-full lg:w-1/2 mx-auto" : ""}`}>
              <input
                type="checkbox"
                checked={blurOn}
                disabled={cameraBusy}
                onChange={(e) => changeBlur(e.target.checked)}
                className="sr-only peer"
              />
              <span className="relative w-10 h-6 rounded-full bg-stone-300 peer-checked:bg-blue-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-4" />
              <span className="text-sm font-bold text-stone-700">배경 흐리게</span>
              <span className="text-xs text-stone-400">촬영 영상의 배경을 흐리게 처리해요</span>
            </label>
          )}

          {/* 발표 자료 PDF (선택) — 촬영 시작 전에만 고르거나 바꿀 수 있다. 고르면 위에 슬라이드로 크게 뜬다 */}
          {!isUpload && (phase === "idle" || phase === "error" || phase === "previewing") && (
            <div className={`pt-2 mb-4 ${!hasSlide ? "w-full lg:w-1/2 mx-auto" : ""}`}>
              <input
                ref={pdfInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => {
                  choosePdf(e.target.files?.[0]);
                  e.target.value = ""; // 같은 파일을 다시 골라도 onChange 가 불리게
                }}
              />
              {slideFile ? (
                <div className="flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-xl px-3 py-2.5">
                  <FileText className="w-4 h-4 text-purple-500 shrink-0" />
                  <span className="text-sm font-bold text-purple-700 truncate">{slideFile.name}</span>
                  <button
                    onClick={() => pdfInputRef.current?.click()}
                    className="ml-auto shrink-0 text-xs font-bold text-purple-600 hover:text-purple-800 px-2 py-1 rounded-lg hover:bg-purple-100 transition-colors"
                  >
                    바꾸기
                  </button>
                  <button
                    onClick={() => setSlideFile(null)}
                    className="shrink-0 text-xs font-bold text-stone-400 hover:text-rose-600 px-2 py-1 rounded-lg hover:bg-rose-50 transition-colors"
                  >
                    빼기
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => pdfInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-stone-300 bg-stone-50 hover:bg-stone-100 rounded-xl px-4 py-3 flex items-center justify-center gap-2 text-sm font-semibold text-stone-500 transition-colors"
                >
                  <FileText className="w-4 h-4 text-stone-400" />
                  발표 자료 PDF 첨부 (선택) · 촬영 화면에 슬라이드로 보여요
                </button>
              )}
              {pdfError ? (
                <p className="text-xs text-rose-600 font-semibold mt-1.5">{pdfError}</p>
              ) : (
                !slideFile && <p className="text-xs text-stone-400 mt-1.5 text-center">PPT는 PDF로 저장해서 올려주세요</p>
              )}
            </div>
          )}

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
          <div className="absolute inset-0 flex flex-col bg-white rounded-2xl shadow-sm border border-stone-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-stone-100 text-sm font-bold text-stone-700 shrink-0">진행 상황</div>
            <div ref={logBoxRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {logs.length === 0 ? (
                <p className="text-sm text-stone-400 font-medium">
                  {isUpload ? "업로드를 시작하면" : "카메라를 켜면"} 진행 상황이 여기에 표시됩니다.
                </p>
              ) : (
                logs.map((l, i) => {
                  const isLast = i === logs.length - 1;
                  const busy = isLast && (phase === "recording" || phase === "finalizing" || phase === "analyzing") && l.kind === "info";
                  return (
                    <div key={i} className="flex items-start gap-2.5">
                      {busy ? (
                        <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-stone-700 animate-spin" />
                      ) : l.kind === "success" ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />
                      ) : l.kind === "warn" ? (
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
                      ) : l.kind === "error" ? (
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-500" />
                      ) : (
                        <span className="w-4 h-4 mt-0.5 shrink-0 flex items-center justify-center">
                          <span className="w-1.5 h-1.5 rounded-full bg-stone-300" />
                        </span>
                      )}
                      <p className="text-sm text-stone-700 font-medium leading-relaxed break-words">{l.text}</p>
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
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 sm:p-8">
            <h3 className="text-center text-stone-900 font-extrabold text-lg mb-5">촬영 전에 확인해 주세요</h3>
            <div className="space-y-3">
              <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3.5">
                <Sparkles className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-extrabold text-stone-900 text-[15px]">실제 발표하는 것처럼 진행해주세요!</p>
                  <p className="text-sm text-stone-600 mt-0.5 leading-relaxed">실수해도 괜찮아요. 재촬영 하지 말고 끝까지 진행해주세요.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3.5">
                <FileText className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-extrabold text-stone-900 text-[15px]">대본·PPT는 프린트물이나 패드로</p>
                  <p className="text-sm text-stone-600 mt-0.5 leading-relaxed">실제 대본이나 PPT가 있다면 프린트물이나 패드에 담아 읽는 것을 추천드려요!</p>
                </div>
              </div>
              <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3.5">
                <Camera className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-extrabold text-stone-900 text-[15px]">휴대폰은 가로로, 촬영 중엔 돌리지 않기</p>
                  <p className="text-sm text-stone-600 mt-0.5 leading-relaxed">휴대폰으로 찍는다면 가로로 세워 두고 촬영해주세요. 촬영 중에 방향을 바꾸면 영상이 어긋날 수 있어요.</p>
                </div>
              </div>
            </div>
            <button
              onClick={() => {
                setShowStartNotice(false);
                startRecording();
              }}
              className="w-full mt-5 bg-stone-900 text-white px-5 py-3 rounded-xl font-bold hover:bg-stone-700 shadow-sm transition-colors"
            >
              확인
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// useSearchParams 를 쓰는 화면은 Suspense 로 감싸야 운영 빌드(next build)가 통과한다.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <RecordPage />
    </Suspense>
  );
}
