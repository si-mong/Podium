"""세션별 파일 저장 경로/IO 헬퍼.

uploads/<session_id>/
  ├── chunks/chunk_NNN.webm
  ├── audio/chunk_NNN.wav
  ├── full_video.webm
  └── full_audio.wav
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
