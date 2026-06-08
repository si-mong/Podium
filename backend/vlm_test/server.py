"""VLM 정적 테스트 서버 (포트 8001).

영상 파일을 업로드하면 30초 청크로 자르고 Gemini로 분석.
진행 상황은 SSE로 실시간 푸시.

실행 (cwd = backend/):
    uvicorn vlm_test.server:app --reload --port 8001
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import analyzer, scoring
from .analyzer import split_video

load_dotenv()

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
WORK_DIR = BASE_DIR / "work"
WORK_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Podium VLM Test")

# 업로드된 영상/청크 직접 재생용
app.mount("/media", StaticFiles(directory=str(WORK_DIR)), name="media")

# 공통 정적 자산 (nav.js 등)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# job_id -> {"queue": asyncio.Queue, "loop": asyncio.AbstractEventLoop}
_jobs: dict[str, dict] = {}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/history")
def history_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "history.html")


@app.get("/preview")
def preview_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "preview.html")


@app.get("/smart-preview")
def smart_preview_page() -> FileResponse:
    """v2 동적 청킹 PoC. 영상 전체 motion 시계열 + 청크 계획 시각화."""
    return FileResponse(STATIC_DIR / "smart-preview.html")


@app.get("/smart-analyze")
def smart_analyze_page() -> FileResponse:
    """스마트 청킹 + VLM 호출 통합 페이지. 청크 계획대로 잘라서 Gemini 분석."""
    return FileResponse(STATIC_DIR / "smart-analyze.html")


@app.post("/analyze")
async def analyze(file: UploadFile) -> dict:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GEMINI_API_KEY 환경변수가 비어있습니다. backend/.env 에 추가하세요.")

    job_id = uuid.uuid4().hex[:12]
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # 원본 확장자 보존 (ffmpeg 입력 컨테이너 자동 인식)
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = job_dir / f"input{suffix}"
    with video_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    meta = {
        "job_id": job_id,
        "original_name": file.filename or "unknown",
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "size_bytes": video_path.stat().st_size,
        "video_filename": video_path.name,
    }
    (job_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    _jobs[job_id] = {"queue": queue, "loop": loop}
    log_path = job_dir / "log.jsonl"

    def on_event(event_type: str, data: dict) -> None:
        # 백그라운드 스레드(ThreadPoolExecutor)에서도 호출되므로 thread-safe하게.
        record = {
            "ts": datetime.now().isoformat(timespec="milliseconds"),
            "type": event_type,
            "data": data,
        }
        try:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass
        loop.call_soon_threadsafe(queue.put_nowait, {"type": event_type, "data": data})

    async def runner() -> None:
        try:
            await asyncio.to_thread(
                analyzer.run_analysis, video_path, job_dir, api_key, on_event
            )
        except Exception as e:
            on_event("error", {"message": str(e)})

    asyncio.create_task(runner())
    return {"job_id": job_id, "size_bytes": video_path.stat().st_size}


@app.get("/events/{job_id}")
async def events(job_id: str) -> StreamingResponse:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"unknown job_id: {job_id}")

    queue: asyncio.Queue = job["queue"]

    async def gen():
        try:
            while True:
                event = await queue.get()
                payload = json.dumps(event["data"], ensure_ascii=False)
                yield f"event: {event['type']}\ndata: {payload}\n\n"
                if event["type"] in ("done", "error"):
                    break
        finally:
            _jobs.pop(job_id, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/history")
def api_history() -> list[dict]:
    """work/ 디렉터리 스캔. 분석 완료(result.json 있음) 건만 노출.
    최신 업로드가 위로 오도록 정렬."""
    items = []
    for job_dir in WORK_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        meta_path = job_dir / "meta.json"
        result_path = job_dir / "result.json"
        if not meta_path.exists() or not result_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        segments = result.get("VLM_segment_result", [])
        items.append({
            **meta,
            "chunk_count": len(segments),
            "success_count": sum(1 for s in segments if s is not None),
        })
    items.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return items


@app.get("/api/history/{job_id}")
def api_history_detail(job_id: str) -> dict:
    job_dir = WORK_DIR / job_id
    meta_path = job_dir / "meta.json"
    result_path = job_dir / "result.json"
    log_path = job_dir / "log.jsonl"
    if not meta_path.exists() or not result_path.exists():
        raise HTTPException(404, f"no completed job: {job_id}")

    log_events = []
    if log_path.exists():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                log_events.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    return {
        "meta": json.loads(meta_path.read_text(encoding="utf-8")),
        "result": json.loads(result_path.read_text(encoding="utf-8")),
        "log": log_events,
    }


@app.post("/preview/analyze")
async def preview_analyze(file: UploadFile) -> dict:
    """영상 업로드 → 청킹 → 청크별 motion/audio 스코어. VLM 호출 안 함."""
    job_id = "preview_" + uuid.uuid4().hex[:10]
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = job_dir / f"input{suffix}"
    with video_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    meta = {
        "job_id": job_id,
        "original_name": file.filename or "unknown",
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "size_bytes": video_path.stat().st_size,
        "video_filename": video_path.name,
        "kind": "preview",
    }
    (job_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 청킹 + 스코어링은 백그라운드 스레드에서 (CPU 바운드, 이벤트 루프 블로킹 방지)
    def _run() -> list[dict]:
        chunks = split_video(video_path, job_dir / "chunks")
        return [s.to_dict() for s in scoring.score_all(chunks)]

    try:
        scores = await asyncio.to_thread(_run)
    except Exception as e:
        raise HTTPException(500, f"preview failed: {e}")

    (job_dir / "preview.json").write_text(
        json.dumps({"chunks": scores}, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "job_id": job_id,
        "original_name": file.filename or "unknown",
        "size_bytes": video_path.stat().st_size,
        "chunks": scores,
    }


@app.get("/preview/history")
def preview_history_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "preview-history.html")


@app.get("/api/preview-history")
def api_preview_history() -> list[dict]:
    """preview.json 있는 job만 노출. 최신 업로드가 위로."""
    items = []
    for job_dir in WORK_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        meta_path = job_dir / "meta.json"
        preview_path = job_dir / "preview.json"
        if not meta_path.exists() or not preview_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            preview = json.loads(preview_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        items.append({
            **meta,
            "chunk_count": len(preview.get("chunks", [])),
        })
    items.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return items


@app.get("/api/preview-history/{job_id}")
def api_preview_detail(job_id: str) -> dict:
    job_dir = WORK_DIR / job_id
    meta_path = job_dir / "meta.json"
    preview_path = job_dir / "preview.json"
    if not meta_path.exists() or not preview_path.exists():
        raise HTTPException(404, f"no preview job: {job_id}")
    return {
        "meta": json.loads(meta_path.read_text(encoding="utf-8")),
        "preview": json.loads(preview_path.read_text(encoding="utf-8")),
    }


@app.post("/smart-preview/analyze")
async def smart_preview_analyze(file: UploadFile) -> dict:
    """영상 업로드 → 전체 motion 시계열 + duration 응답. VLM/청킹 안 함.

    실제 청크 계획은 클라이언트에서 임계값/hysteresis 슬라이더에 따라
    JS로 계산 (서버 왕복 없이 실시간 튜닝 가능).

    timeline + meta 는 work/<job_id>/ 에 저장되어 /smart-preview/history 에서 재현 가능.
    """
    job_id = "smart_" + uuid.uuid4().hex[:10]
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = job_dir / f"input{suffix}"
    with video_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    # CPU 바운드(영상 전체 디코딩) → 백그라운드 스레드
    def _run() -> tuple[list[tuple[float, float]], float]:
        timeline = scoring.video_motion_timeline(video_path)
        duration = scoring.chunk_duration(video_path)
        return timeline, duration

    try:
        timeline, duration = await asyncio.to_thread(_run)
    except Exception as e:
        raise HTTPException(500, f"smart preview failed: {e}")

    # 메타 + 시계열 저장 (history 재현용)
    meta = {
        "job_id": job_id,
        "original_name": file.filename or "unknown",
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "size_bytes": video_path.stat().st_size,
        "video_filename": video_path.name,
        "duration": duration,
        "kind": "smart-preview",
    }
    (job_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 응답 크기 절감 위해 소수점 자리수 줄여 저장 + 응답에 동일하게 사용
    compact_timeline = [{"t": round(t, 2), "m": round(m, 3)} for t, m in timeline]
    (job_dir / "smart.json").write_text(
        json.dumps({"timeline": compact_timeline, "duration": duration},
                   ensure_ascii=False),
        encoding="utf-8",
    )

    return {
        "job_id": job_id,
        "original_name": file.filename or "unknown",
        "video_filename": video_path.name,
        "duration": duration,
        "timeline": compact_timeline,
    }


@app.post("/smart-analyze")
async def smart_analyze(
    file: UploadFile,
    motion_thresh: float = 3.5,
    hysteresis_frames: int = 5,
    chunk_duration: float = 20.0,
) -> dict:
    """스마트 청킹 + VLM 분석. 기존 /analyze 와 동일하게 SSE 로 진행상황 푸시.

    Query 파라미터로 스마트 청킹 옵션 전달 가능:
      ?motion_thresh=3.5&hysteresis_frames=5&chunk_duration=20
    """
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "GEMINI_API_KEY 환경변수가 비어있습니다. backend/.env 에 추가하세요.")

    job_id = "smartA_" + uuid.uuid4().hex[:10]
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    video_path = job_dir / f"input{suffix}"
    with video_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    meta = {
        "job_id": job_id,
        "original_name": file.filename or "unknown",
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "size_bytes": video_path.stat().st_size,
        "video_filename": video_path.name,
        "kind": "smart-analyze",
        "params": {
            "motion_thresh": motion_thresh,
            "hysteresis_frames": hysteresis_frames,
            "chunk_duration": chunk_duration,
        },
    }
    (job_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    _jobs[job_id] = {"queue": queue, "loop": loop}
    log_path = job_dir / "log.jsonl"

    def on_event(event_type: str, data: dict) -> None:
        record = {
            "ts": datetime.now().isoformat(timespec="milliseconds"),
            "type": event_type,
            "data": data,
        }
        try:
            with log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass
        loop.call_soon_threadsafe(queue.put_nowait, {"type": event_type, "data": data})

    async def runner() -> None:
        try:
            await asyncio.to_thread(
                analyzer.run_smart_analysis,
                video_path, job_dir, api_key, on_event,
                motion_thresh, hysteresis_frames, chunk_duration,
            )
        except Exception as e:
            on_event("error", {"message": str(e)})

    asyncio.create_task(runner())
    return {
        "job_id": job_id,
        "size_bytes": video_path.stat().st_size,
        "params": meta["params"],
    }


@app.get("/smart-preview/history")
def smart_preview_history_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "smart-preview-history.html")


@app.get("/api/smart-history")
def api_smart_history() -> list[dict]:
    """smart.json 있는 job만 노출. 최신 업로드가 위로."""
    items = []
    for job_dir in WORK_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        meta_path = job_dir / "meta.json"
        smart_path = job_dir / "smart.json"
        if not meta_path.exists() or not smart_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        items.append(meta)
    items.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return items


@app.get("/api/smart-history/{job_id}")
def api_smart_detail(job_id: str) -> dict:
    job_dir = WORK_DIR / job_id
    meta_path = job_dir / "meta.json"
    smart_path = job_dir / "smart.json"
    if not meta_path.exists() or not smart_path.exists():
        raise HTTPException(404, f"no smart-preview job: {job_id}")
    return {
        "meta": json.loads(meta_path.read_text(encoding="utf-8")),
        "smart": json.loads(smart_path.read_text(encoding="utf-8")),
    }


@app.get("/smart-analyze/history")
def smart_analyze_history_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "smart-analyze-history.html")


@app.get("/api/smart-analyze-history")
def api_smart_analyze_history() -> list[dict]:
    """smart-analyze 완료 케이스 (kind=smart-analyze + result.json 있음). 최신순."""
    items = []
    for job_dir in WORK_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        meta_path = job_dir / "meta.json"
        result_path = job_dir / "result.json"
        if not meta_path.exists() or not result_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if meta.get("kind") != "smart-analyze":
            continue
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        segments = result.get("VLM_segment_result", [])
        items.append({
            **meta,
            "chunk_count": len(segments),
            "success_count": sum(1 for s in segments if s and s.get("vlm")),
        })
    items.sort(key=lambda x: x.get("uploaded_at", ""), reverse=True)
    return items


@app.get("/api/smart-analyze-history/{job_id}")
def api_smart_analyze_detail(job_id: str) -> dict:
    job_dir = WORK_DIR / job_id
    meta_path = job_dir / "meta.json"
    result_path = job_dir / "result.json"
    log_path = job_dir / "log.jsonl"
    if not meta_path.exists() or not result_path.exists():
        raise HTTPException(404, f"no smart-analyze job: {job_id}")

    log_events = []
    if log_path.exists():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                log_events.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    return {
        "meta": json.loads(meta_path.read_text(encoding="utf-8")),
        "result": json.loads(result_path.read_text(encoding="utf-8")),
        "log": log_events,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("vlm_test.server:app", host="127.0.0.1", port=8001, reload=True)
