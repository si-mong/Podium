"""STEP 3 음성분석 테스트 서버 (포트 8002).

음성/영상 파일을 올리면 STEP 3 를 돌리고 결과를 브라우저에서 확인·라벨링.
DB 연결 안 함. `vlm_test` 서버(8001)와 같은 패턴.

실행 (cwd = backend/):
    uvicorn stt_test.server:app --reload --port 8002

핵심 화면 두 가지:
  - 분석      업로드 → 지표 + 필러 후보 청취/라벨링
  - 경로 비교 어휘 경로 vs 음향 경로를 한 번의 STT 로 나란히 비교
              (= 3-3 을 유지할지 폐기할지 판단하는 화면)
"""
from __future__ import annotations

import asyncio
import difflib
import json
import shutil
import subprocess
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from stt_test.audio import TARGET_SR
from stt_test.report import write_clips

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
WORK_DIR = BASE_DIR / "work"
WORK_DIR.mkdir(exist_ok=True)

# 서버가 목록에 띄워줄 기존 녹음 위치 (backend/uploads/<session>/full_audio.wav)
UPLOADS_DIR = BASE_DIR.parent / "uploads"

# 로컬로 변환해 둔 CTranslate2 모델 위치 (convert_model.py 산출물)
MODELS_DIR = BASE_DIR / "models"

# faster-whisper 가 이름만으로 내려받는 내장 모델
BUILTIN_MODELS = ["tiny", "base", "small", "medium",
                  "large-v2", "large-v3-turbo", "large-v3"]

# transformers 런타임으로 돌려야 하는 모델 (`hf:` 접두사).
# 비유창성 토큰을 추가한 파인튜닝은 CTranslate2 에서 깨진다 — stt_hf.py 참고.
HF_MODELS = [
    {"id": "hf:rearleg/SeloWhisper-ko-disfluency",
     "label": "SeloWhisper (비유창성 태그)",
     "note": "transformers 런타임. 필러를 <um>/<uh>/<gue> 등으로 직접 태깅.",
     "license": "MIT"},
]

app = FastAPI(title="Podium STEP 3 Test")

# 후보 클립 재생용
app.mount("/media", StaticFiles(directory=str(WORK_DIR)), name="media")

# job_id -> {"queue": asyncio.Queue, "loop": asyncio.AbstractEventLoop}
_jobs: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------

def _to_wav(src: Path, dst: Path) -> Path:
    """어떤 포맷이든 16kHz mono PCM16 wav 로 통일 (webm/mp4/m4a/mp3 모두 허용)."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src),
         "-vn", "-ac", "1", "-ar", str(TARGET_SR), "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )
    return dst


def _transcript_diff(a: str, b: str) -> list[dict]:
    """두 전사문의 어절 단위 차이. UI 에서 색으로 칠하기 위한 opcode 목록.

    tag: equal | replace | delete(a 에만) | insert(b 에만)
    """
    aw, bw = a.split(), b.split()
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, aw, bw).get_opcodes():
        out.append({"tag": tag, "a": " ".join(aw[i1:i2]), "b": " ".join(bw[j1:j2])})
    return out


def _emit(job_id: str, event: dict) -> None:
    """작업 스레드 → SSE 큐. 이벤트 루프 스레드로 안전하게 넘김."""
    job = _jobs.get(job_id)
    if not job:
        return
    job["loop"].call_soon_threadsafe(job["queue"].put_nowait, event)


def _run_job(job_id: str, job_dir: Path, wav: Path, mode: str,
             model: str, verbatim: bool, models: list[str] | None = None,
             keywords: str = "") -> None:
    """실제 분석 (별도 스레드에서 실행 — STT 가 블로킹이라)."""
    from stt_test.analyze import (  # 무거우므로 lazy
        analyze, analyze_compare, analyze_keywords, analyze_models,
    )

    def progress(stage: str, message: str) -> None:
        _emit(job_id, {"type": "progress", "stage": stage, "message": message})

    try:
        if mode == "compare":
            both = analyze_compare(wav, model_size=model, verbatim_prompt=verbatim,
                                   keywords=keywords, on_progress=progress)
            progress("clips", "후보 클립 추출 중")
            write_clips(both["lexical"], wav, job_dir, prefix="lex")
            write_clips(both["acoustic"], wav, job_dir, prefix="aco")
            payload = {"mode": "compare", **both}
        elif mode == "models":
            picked = models or ["small", "large-v3"]
            results = analyze_models(wav, picked, verbatim_prompt=verbatim,
                                     keywords=keywords, on_progress=progress)
            progress("clips", "후보 클립 추출 중")
            for i, name in enumerate(picked):
                write_clips(results[name], wav, job_dir, prefix=f"m{i}")
            # 전사문 차이 (첫 모델 기준)
            base = picked[0]
            diffs = {
                name: _transcript_diff(results[base]["diagnostics"]["full_text"],
                                       results[name]["diagnostics"]["full_text"])
                for name in picked[1:]
            }
            payload = {"mode": "models", "models": picked,
                       "results": results, "diffs": diffs}
        elif mode == "kwcompare":
            labels = ["키워드 없음", "키워드 적용"]
            results = analyze_keywords(wav, model_size=model, keywords=keywords,
                                       verbatim_prompt=verbatim, on_progress=progress)
            progress("clips", "후보 클립 추출 중")
            for i, name in enumerate(labels):
                write_clips(results[name], wav, job_dir, prefix=f"m{i}")
            diffs = {labels[1]: _transcript_diff(
                results[labels[0]]["diagnostics"]["full_text"],
                results[labels[1]]["diagnostics"]["full_text"])}
            payload = {"mode": "models", "models": labels, "results": results,
                       "diffs": diffs,
                       "title": f"키워드 비교 — hotwords «{keywords}»"}
        else:
            result = analyze(wav, model_size=model, verbatim_prompt=verbatim,
                             skip_stt=(mode == "silence"), keywords=keywords,
                             on_progress=progress)
            if mode != "silence":
                progress("clips", "후보 클립 추출 중")
                write_clips(result, wav, job_dir)
            payload = {"mode": mode, "result": result}

        (job_dir / "result.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        meta = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
        meta["status"] = "done"
        meta["finished_at"] = datetime.now().isoformat(timespec="seconds")
        (job_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

        _emit(job_id, {"type": "done", "job_id": job_id})
    except Exception as exc:  # noqa: BLE001 — 어떤 실패든 UI 로 전달해야 함
        _emit(job_id, {"type": "error", "message": f"{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------------------
# 페이지
# ---------------------------------------------------------------------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.api_route("/audio/{job_id}", methods=["GET", "HEAD"])
def audio(job_id: str, range: str | None = Header(default=None)) -> Response:
    """원본 오디오를 **Range 요청 지원**으로 서빙 (타임라인 seek 용).

    `/media` 마운트(StaticFiles)는 Range 를 지원하지 않아 항상 200 + 전체 파일을
    돌려준다. 그러면 브라우저가 탐색을 못 해 `currentTime` 을 설정해도 무시하고
    0초부터 재생한다. 필러 클립은 구간별 개별 파일이라 seek 이 필요 없어 증상이
    안 보였고, 전체 오디오 타임라인에서만 드러났다.
    """
    path = WORK_DIR / job_id / "audio.wav"
    if not path.exists():
        raise HTTPException(404, "오디오 없음")

    size = path.stat().st_size
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache"}

    if not range or not range.startswith("bytes="):
        return FileResponse(path, media_type="audio/wav", headers=headers)

    spec = range.removeprefix("bytes=").split(",")[0].strip()
    start_s, _, end_s = spec.partition("-")
    try:
        if start_s:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        else:  # "bytes=-N" — 마지막 N 바이트
            start, end = max(0, size - int(end_s)), size - 1
    except ValueError:
        raise HTTPException(416, "잘못된 Range") from None

    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(status_code=416,
                        headers={**headers, "Content-Range": f"bytes */{size}"})

    with path.open("rb") as f:
        f.seek(start)
        chunk = f.read(end - start + 1)

    return Response(
        chunk,
        status_code=206,
        media_type="audio/wav",
        headers={**headers,
                 "Content-Range": f"bytes {start}-{end}/{size}",
                 "Content-Length": str(len(chunk))},
    )


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/sources")
def api_sources() -> list[dict]:
    """backend/uploads/ 에 이미 있는 녹음 목록 — 업로드 없이 바로 선택."""
    out = []
    if UPLOADS_DIR.exists():
        for wav in sorted(UPLOADS_DIR.glob("*/full_audio.wav")):
            out.append({
                "session": wav.parent.name,
                "path": str(wav),
                "size_mb": round(wav.stat().st_size / 1e6, 1),
            })
    # fixtures/ 에 직접 녹음한 파일을 넣어두면 형식 무관하게 목록에 뜸.
    # 같은 파일로 반복 실험하려면 여기에 두는 게 업로드보다 편함.
    fixtures = BASE_DIR / "fixtures"
    if fixtures.exists():
        for f in sorted(fixtures.iterdir()):
            if f.suffix.lower() in {".wav", ".webm", ".mp4", ".m4a", ".mp3", ".flac", ".ogg"}:
                out.append({"session": f"fixture:{f.name}", "path": str(f),
                            "size_mb": round(f.stat().st_size / 1e6, 1)})
    return out


# Whisper 기본 vocab 상한. 이보다 큰 토큰 id 는 faster-whisper 가
# 특수/타임스탬프 토큰으로 해석한다 (timestamp 영역이 50365~51865).
_WHISPER_VOCAB_MAX = 51866


def _vocab_warning(model_dir: Path) -> str | None:
    """확장 vocab 모델을 감지해 경고 문구를 돌려준다.

    파인튜닝으로 특수 토큰을 추가한 모델(예: 비유창성 태그)은 토큰 id 가
    Whisper 기본 vocab 위에 얹힌다. 그 영역은 faster-whisper 가 타임스탬프로
    해석하므로 **토큰이 사라질 뿐 아니라 세그먼트 경계가 깨져 전사가 잘린다.**
    조용히 잘못된 결과를 내는 것보다 UI 에서 미리 알리는 편이 안전하다.
    → 이런 모델은 transformers 런타임이 필요하다.
    """
    vocab_path = model_dir / "vocabulary.json"
    if not vocab_path.exists():
        return None
    try:
        n = len(json.loads(vocab_path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, OSError):
        return None
    if n <= _WHISPER_VOCAB_MAX:
        return None
    extra = n - _WHISPER_VOCAB_MAX
    # 정적 추정일 뿐이다 — 추가 토큰이 있어도 모델이 실제로 그 토큰을 생성하지
    # 않으면 문제가 없다(crisper-ko 가 그런 경우). 실측 결과가 `_note.json` 에
    # 있으면 그쪽이 우선한다.
    return (f"추가 토큰 {extra}개가 타임스탬프 영역과 겹칩니다. 모델이 이 토큰을 "
            f"실제로 생성하면 토큰 소실·전사 잘림이 발생할 수 있습니다. "
            f"(실측 전 · 결과를 확인하세요)")


@app.get("/api/models")
def api_models() -> list[dict]:
    """UI 모델 목록 — 내장 프리셋 + `stt_test/models/` 의 로컬 변환 모델.

    로컬 모델은 디렉터리를 스캔해서 자동으로 뜬다. 새 모델을 변환하면
    (`python -m stt_test.convert_model <HF_ID>`) 코드 수정 없이 목록에 나타남.
    """
    out = [{"id": m, "label": m, "kind": "builtin"} for m in BUILTIN_MODELS]
    out += [{**m, "kind": "hf", "status": "ok"} for m in HF_MODELS]
    if MODELS_DIR.exists():
        for d in sorted(MODELS_DIR.iterdir()):
            if not (d / "model.bin").exists():
                continue  # 변환 중이거나 실패한 디렉터리는 제외
            size = sum(f.stat().st_size for f in d.iterdir() if f.is_file())
            row = {"id": str(d), "label": d.name, "kind": "local",
                   "size_mb": round(size / 1e6)}
            note_path = d / "_note.json"
            if note_path.exists() and json.loads(
                    note_path.read_text(encoding="utf-8")).get("hidden"):
                continue   # 사용 불가로 판명된 변환본은 목록에서 숨김
            if note_path.exists():
                # 실측으로 확인된 내용 — 정적 추정보다 우선
                try:
                    note = json.loads(note_path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    note = {}
                row["label"] = note.get("label", d.name)
                row["status"] = note.get("status")
                row["note"] = note.get("note")
                row["license"] = note.get("license")
                if note.get("status") == "broken":
                    row["warn"] = note.get("note")
            else:
                warn = _vocab_warning(d)
                if warn:
                    row["warn"] = warn
            out.append(row)
    return out


@app.post("/analyze")
async def start_analyze(
    file: UploadFile | None = None,
    source_path: str = Form(""),
    mode: str = Form("full"),          # full | silence | compare | models | kwcompare
    model: str = Form("small"),
    models: str = Form("small,large-v3"),   # mode=models 일 때 비교할 모델들
    verbatim: str = Form("false"),
    keywords: str = Form(""),               # 발표 주제·고유명사 → hotwords
) -> dict:
    if not file and not source_path:
        raise HTTPException(400, "파일을 업로드하거나 기존 녹음을 선택하세요.")

    job_id = uuid.uuid4().hex[:12]
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True)

    if file:
        src = job_dir / f"source{Path(file.filename or 'in.webm').suffix or '.webm'}"
        with src.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        display = file.filename or src.name
    else:
        src = Path(source_path)
        if not src.exists():
            raise HTTPException(404, f"없는 경로: {source_path}")
        display = str(src)

    wav = job_dir / "audio.wav"
    try:
        _to_wav(src, wav)
    except subprocess.CalledProcessError as exc:
        raise HTTPException(400, f"오디오 추출 실패 (ffmpeg): {exc}") from exc

    (job_dir / "meta.json").write_text(json.dumps({
        "job_id": job_id, "source": display, "mode": mode,
        "model": models if mode == "models" else model,
        "verbatim": verbatim == "true", "keywords": keywords, "status": "running",
        "started_at": datetime.now().isoformat(timespec="seconds"),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    _jobs[job_id] = {"queue": asyncio.Queue(), "loop": asyncio.get_running_loop()}
    picked = [m.strip() for m in models.split(",") if m.strip()]
    asyncio.get_running_loop().run_in_executor(
        None, _run_job, job_id, job_dir, wav, mode, model, verbatim == "true",
        picked, keywords)

    return {"job_id": job_id}


@app.get("/events/{job_id}")
async def events(job_id: str) -> StreamingResponse:
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "없는 job")

    async def stream():
        while True:
            event = await job["queue"].get()
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


@app.get("/api/jobs")
def api_jobs() -> list[dict]:
    out = []
    for job_dir in WORK_DIR.iterdir():
        meta_path = job_dir / "meta.json"
        if not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["has_labels"] = (job_dir / "labels.json").exists()
        out.append(meta)
    return sorted(out, key=lambda m: m.get("started_at", ""), reverse=True)


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict:
    path = WORK_DIR / job_id / "result.json"
    if not path.exists():
        raise HTTPException(404, "결과 없음 (아직 실행 중이거나 실패)")
    data = json.loads(path.read_text(encoding="utf-8"))
    labels_path = WORK_DIR / job_id / "labels.json"
    data["labels"] = (
        json.loads(labels_path.read_text(encoding="utf-8")) if labels_path.exists() else {}
    )
    return data


@app.post("/api/jobs/{job_id}/labels")
async def save_labels(job_id: str, labels: str = Form(...)) -> dict:
    """청취 라벨을 서버에 저장 — CLI 처럼 내려받아 옮길 필요 없음."""
    job_dir = WORK_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(404, "없는 job")
    (job_dir / "labels.json").write_text(labels, encoding="utf-8")
    return {"saved": len(json.loads(labels))}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    job_dir = WORK_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(404, "없는 job")
    shutil.rmtree(job_dir)
    _jobs.pop(job_id, None)
    return {"deleted": job_id}
