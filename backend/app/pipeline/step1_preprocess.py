"""STEP 1. 전처리: 청크별 오디오 추출 + full_audio.wav 생성.

VLM/Whisper 호출 직전 단계. 외부 의존성: ffmpeg, ffprobe (시스템에 설치돼 있어야 함).
"""
from __future__ import annotations

import subprocess
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def _run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else ""
        raise FFmpegError(f"{args[0]} failed ({' '.join(args[:3])}): {tail}")


def extract_chunk_audio(chunk_webm: Path, out_wav: Path) -> Path:
    """webm 청크에서 오디오만 뽑아 16kHz mono pcm_s16le wav로 저장 (Whisper 표준)."""
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-y", "-i", str(chunk_webm),
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        str(out_wav),
    ])
    return out_wav


def concat_audio(wav_paths: list[Path], out_wav: Path) -> Path:
    """여러 wav를 concat 데먹서로 합쳐 단일 wav 생성. 모든 입력은 같은 포맷이어야 함."""
    if not wav_paths:
        raise ValueError("wav_paths is empty")
    out_wav.parent.mkdir(parents=True, exist_ok=True)

    # concat 데먹서는 "file '<path>'" 형식의 텍스트 파일을 입력으로 받음.
    list_file = out_wav.parent / "concat_list.txt"
    list_file.write_text("\n".join(f"file '{p.resolve()}'" for p in wav_paths))

    _run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        str(out_wav),
    ])
    return out_wav


def probe_duration(media: Path) -> float | None:
    """ffprobe로 미디어 길이(초)를 얻음. 실패 시 None."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(media),
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None
