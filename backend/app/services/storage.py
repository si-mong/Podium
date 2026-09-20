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

import logging
import shutil
import time
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)


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
    """세션 파일 폴더를 지운다. 실패해도 예외를 던지지 않는다.

    호출 시점에는 DB 행이 이미 지워진 뒤다. Windows 는 다른 곳이 열어 둔 파일(예: 영상을 재생 중인
    브라우저 요청)을 못 지워서, 예외를 그대로 던지면 "DB 는 지워졌는데 삭제 실패(500)"로 보인다.
    그래서 잠깐 기다렸다 몇 번 다시 시도하고, 그래도 안 되면 경고만 남긴다. (세션이 이미 없어서
    남은 파일은 화면에 나오지 않는다.)
    """
    d = session_dir(session_id)
    error = None
    for _ in range(3):
        if not d.exists():
            return
        try:
            shutil.rmtree(d)
            return
        except OSError as e:
            error = e
            time.sleep(0.5)
    logger.warning("세션 %s 파일 폴더를 지우지 못했습니다: %s", session_id, error)
