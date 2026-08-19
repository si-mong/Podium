"""세션별 파일 저장 경로/IO 헬퍼.

uploads/<session_id>/
  ├── chunks/chunk_NNN.webm       업로드 청크 (30초 고정, 전송 단위)
  ├── audio/chunk_NNN.wav         청크별 오디오 (STEP 1)
  ├── vlm_chunks/chunk_NNN.mp4    스마트 청킹 산출물 (STEP 2, 재분석 시 덮어씀)
  ├── full_video.webm             연속 녹화본 — 스마트 청킹의 입력
  ├── full_audio.wav              concat 결과 (STEP 1)
  └── vlm_analysis.json           VLM 원본 응답

주의: `chunks/`(전송 단위)와 `vlm_chunks/`(영상분석 단위)는 서로 다른 개념이다.
자세한 층 분리는 docs/CLAUDE.md "청크의 세 가지 의미" 참고.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from app.core.config import settings


def session_dir(session_id: int) -> Path:
    return settings.upload_dir / str(session_id)


def init_session_dirs(session_id: int) -> Path:
    d = session_dir(session_id)
    (d / "chunks").mkdir(parents=True, exist_ok=True)
    (d / "audio").mkdir(parents=True, exist_ok=True)
    return d


def chunk_path(session_id: int, chunk_index: int) -> Path:
    return session_dir(session_id) / "chunks" / f"chunk_{chunk_index:03d}.webm"


def chunk_audio_path(session_id: int, chunk_index: int) -> Path:
    return session_dir(session_id) / "audio" / f"chunk_{chunk_index:03d}.wav"


def full_video_path(session_id: int) -> Path:
    return session_dir(session_id) / "full_video.webm"


def full_audio_path(session_id: int) -> Path:
    return session_dir(session_id) / "full_audio.wav"


def write_bytes(path: Path, data: bytes) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data)


def delete_session_files(session_id: int) -> None:
    d = session_dir(session_id)
    if d.exists():
        shutil.rmtree(d)
