'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Video, StopCircle, RotateCcw, Check, ArrowLeft, Mic, MicOff, BarChart2 } from 'lucide-react';

type RecordingStatus = 'idle' | 'requesting' | 'ready' | 'recording' | 'preview';

export default function RecordingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const topicId = searchParams.get('topicId') || '';

  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [recordingTime, setRecordingTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCamera = useCallback(async () => {
    setStatus('requesting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setStatus('ready');
    } catch {
      setError('카메라 접근 권한이 필요합니다. 브라우저 주소창 옆 카메라 아이콘을 클릭하여 허용해주세요.');
      setStatus('idle');
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    chunksRef.current = [];

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const mr = new MediaRecorder(streamRef.current, { mimeType });

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      if (playbackRef.current) {
        playbackRef.current.src = url;
      }
      setStatus('preview');
    };

    mr.start(1000);
    mediaRecorderRef.current = mr;
    setRecordingTime(0);
    timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    setStatus('recording');
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const retake = useCallback(async () => {
    setRecordingTime(0);
    await startCamera();
  }, [startCamera]);

  const confirmRecording = useCallback(() => {
    router.push(`/?videoRecorded=${topicId}`);
  }, [router, topicId]);

  const toggleMute = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
      setIsMuted(m => !m);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const formatTime = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">

      {/* 헤더 */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-700/60">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors font-medium"
        >
          <ArrowLeft className="w-5 h-5" />
          돌아가기
        </button>
        <div className="flex items-center gap-2.5">
          <div className="bg-blue-600 p-1.5 rounded-lg">
            <BarChart2 className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-white font-extrabold text-lg">발표 영상 촬영</h1>
        </div>
        <div className="w-24" />
      </header>

      <div className="flex-1 flex flex-col items-center justify-center p-8 gap-8">

        {/* 영상 영역 */}
        <div className="w-full max-w-3xl">
          <div className="relative bg-slate-800 rounded-2xl overflow-hidden aspect-video shadow-2xl border border-slate-700/50">

            {/* 대기 상태 */}
            {(status === 'idle' || status === 'requesting') && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                <div className="w-20 h-20 rounded-full bg-slate-700 flex items-center justify-center">
                  <Video className="w-10 h-10 text-slate-400" />
                </div>
                <p className="text-slate-400 font-medium">
                  {status === 'requesting' ? '카메라 접근 요청 중...' : '카메라를 시작하면 미리보기가 표시됩니다'}
                </p>
              </div>
            )}

            {/* 라이브 카메라 미리보기 */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover scale-x-[-1] ${status === 'ready' || status === 'recording' ? 'block' : 'hidden'}`}
            />

            {/* 녹화 완료 재생 */}
            <video
              ref={playbackRef}
              controls
              className={`w-full h-full object-cover ${status === 'preview' ? 'block' : 'hidden'}`}
            />

            {/* 녹화 중 표시 */}
            {status === 'recording' && (
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-full border border-red-500/30">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                <span className="text-white font-bold text-sm tabular-nums">{formatTime(recordingTime)}</span>
              </div>
            )}

            {/* 미리보기 라벨 */}
            {status === 'preview' && (
              <div className="absolute top-4 left-4 bg-blue-600/80 backdrop-blur-sm px-3 py-1.5 rounded-full">
                <span className="text-white font-bold text-sm">녹화 완료 · 미리보기</span>
              </div>
            )}

            {/* 음소거 버튼 */}
            {(status === 'ready' || status === 'recording') && (
              <button
                onClick={toggleMute}
                className="absolute bottom-4 right-4 bg-black/50 backdrop-blur-sm p-2.5 rounded-full hover:bg-black/70 transition border border-white/10"
                title={isMuted ? '마이크 켜기' : '마이크 끄기'}
              >
                {isMuted
                  ? <MicOff className="w-5 h-5 text-red-400" />
                  : <Mic className="w-5 h-5 text-white" />}
              </button>
            )}
          </div>

          {/* 오류 메시지 */}
          {error && (
            <div className="mt-3 bg-red-900/40 border border-red-700/60 rounded-xl p-3 text-red-300 text-sm text-center">
              {error}
            </div>
          )}
        </div>

        {/* 컨트롤 버튼 */}
        <div className="flex items-center gap-4">

          {status === 'idle' && (
            <button
              onClick={startCamera}
              className="flex items-center gap-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold px-8 py-4 rounded-2xl text-lg transition-colors shadow-lg shadow-blue-900/40"
            >
              <Video className="w-6 h-6" />
              카메라 시작
            </button>
          )}

          {status === 'ready' && (
            <button
              onClick={startRecording}
              className="flex items-center gap-2.5 bg-red-500 hover:bg-red-600 text-white font-bold px-8 py-4 rounded-2xl text-lg transition-colors shadow-lg shadow-red-900/40"
            >
              <div className="w-5 h-5 rounded-full bg-white" />
              녹화 시작
            </button>
          )}

          {status === 'recording' && (
            <button
              onClick={stopRecording}
              className="flex items-center gap-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold px-8 py-4 rounded-2xl text-lg transition-colors"
            >
              <StopCircle className="w-6 h-6 text-red-400" />
              녹화 중지
            </button>
          )}

          {status === 'preview' && (
            <>
              <button
                onClick={retake}
                className="flex items-center gap-2.5 bg-slate-700 hover:bg-slate-600 text-white font-bold px-6 py-4 rounded-2xl text-lg transition-colors"
              >
                <RotateCcw className="w-5 h-5" />
                다시 촬영
              </button>
              <button
                onClick={confirmRecording}
                className="flex items-center gap-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold px-8 py-4 rounded-2xl text-lg transition-colors shadow-lg shadow-blue-900/40"
              >
                <Check className="w-5 h-5" />
                분석 시작
              </button>
            </>
          )}

        </div>

        {/* 안내 텍스트 */}
        <p className="text-slate-500 text-sm text-center max-w-md leading-relaxed">
          {status === 'idle' && '카메라를 시작하여 발표 연습을 촬영하세요. 촬영이 완료되면 AI가 자동으로 분석합니다.'}
          {status === 'requesting' && '브라우저 상단에 카메라 권한 요청 팝업이 표시됩니다. 허용을 클릭해주세요.'}
          {status === 'ready' && '준비가 완료되었습니다. 녹화 시작 버튼을 눌러 발표를 시작하세요.'}
          {status === 'recording' && '발표 중입니다. 완료 후 녹화 중지 버튼을 누르세요.'}
          {status === 'preview' && '녹화된 영상을 확인하세요. 만족스러우면 분석 시작을 눌러주세요.'}
        </p>

      </div>
    </div>
  );
}
