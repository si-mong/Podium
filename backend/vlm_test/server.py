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

from . import analyzer

load_dotenv()

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
WORK_DIR = BASE_DIR / "work"
WORK_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Podium VLM Test")

# 업로드된 영상/청크 직접 재생용
app.mount("/media", StaticFiles(directory=str(WORK_DIR)), name="media")

# job_id -> {"queue": asyncio.Queue, "loop": asyncio.AbstractEventLoop}
_jobs: dict[str, dict] = {}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/history")
def history_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "history.html")


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("vlm_test.server:app", host="127.0.0.1", port=8001, reload=True)
