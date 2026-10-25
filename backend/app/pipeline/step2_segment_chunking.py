"""STEP 2 구간 기준 청킹.

STEP 4 가 나눈 구간(segments)을 기준으로 영상을 잘라 VLM(Gemini)에 보낸다.
구간이 1분보다 길면 **같은 길이로** 여러 개로 나눈다 (청크 하나는 최대 1분).

    구간 20초      → 20초 1개
    구간 2분 20초  → 46.7초 3개   (1분/1분/20초 처럼 자르지 않음)
    구간 2분 1초   → 40.3초 3개   (1분/1분/1초 처럼 짧은 꼬리가 생기지 않게)

청크가 구간 경계를 넘지 않으므로 청크 하나의 분석 결과는 정확히 한 구간에만 속한다.

예전 스마트 청킹(step2_chunking.py)은 "동작이 시작되는 시점"부터 20초씩 잘랐다.
Gemini 성능이 좋아져서 1분 단위로도 분석할 수 있게 되어, 구간 기준으로 영상 전체를 보내는
방식으로 바꿨다.

외부 의존성: ffmpeg (시스템 설치).
"""
from __future__ import annotations

import logging
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

MAX_CHUNK_SEC = 60.0   # 청크 하나의 최대 길이 (초)


@dataclass
class SegmentChunk:
    """잘라낼 청크 하나. 어느 구간의 몇 초~몇 초인지."""
    segment_id: int
    start_sec: float
    end_sec: float

    @property
    def duration_sec(self) -> float:
        return self.end_sec - self.start_sec


def plan_chunks(segments: list[dict], max_sec: float = MAX_CHUNK_SEC) -> list[SegmentChunk]:
    """구간 목록 → 청크 계획.

    segments: [{"segment_id", "t_start", "t_end"}, ...] (시간 순)
    """
    chunks: list[SegmentChunk] = []
    for seg in segments:
        length = seg["t_end"] - seg["t_start"]
        if length <= 0:
            continue

        # 몇 개로 나눌지 정하고, 그 개수만큼 같은 길이로 나눈다
        n = math.ceil(length / max_sec)
        step = length / n
        for i in range(n):
            start = seg["t_start"] + step * i
            # 마지막 청크는 소수점 오차 없이 구간 끝에 딱 맞춘다
            end = seg["t_end"] if i == n - 1 else start + step
            chunks.append(SegmentChunk(segment_id=seg["segment_id"], start_sec=start, end_sec=end))
    return chunks


def extract_chunks(video_path: Path, plan: list[SegmentChunk], out_dir: Path) -> list[Path]:
    """청크 계획대로 ffmpeg 로 영상을 잘라 mp4 파일로 저장한다.

    원본은 브라우저 녹화(MediaRecorder) webm 이라 키프레임이 드물다. `-c copy`(인코딩 없이 자르기)로
    자르면 청크 앞부분이 깨지거나 검게 나와서 **재인코딩**한다(libx264 ultrafast).
    mp4 가 Gemini 업로드와도 더 잘 맞는다. (step2_chunking.extract_smart_chunks 와 같은 설정)

    출력 파일명은 chunk_001.mp4, chunk_002.mp4, ... (plan 순서 그대로).
    step2_video_analysis.run() 이 파일명을 정렬해서 쓰므로 0을 채운 번호가 시간 순서가 된다.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # 이전 분석 때 만든 청크가 섞이지 않게 지운다
    for old in out_dir.glob("chunk_*.mp4"):
        old.unlink()

    chunk_paths: list[Path] = []
    for i, chunk in enumerate(plan, start=1):
        out_path = out_dir / f"chunk_{i:03d}.mp4"
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(video_path),          # -i 를 먼저 둬야 -ss 가 정확한 시각에서 자른다
                "-ss", f"{chunk.start_sec:.3f}",
                "-t", f"{chunk.duration_sec:.3f}",
                "-c:v", "libx264", "-preset", "ultrafast",
                "-c:a", "aac",
                "-avoid_negative_ts", "make_zero",
                str(out_path),
            ],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            tail = result.stderr[-500:] if result.stderr else ""
            raise RuntimeError(
                f"청크 {i} 자르기 실패 ({chunk.start_sec:.1f}~{chunk.end_sec:.1f}초): {tail}"
            )
        chunk_paths.append(out_path)

    logger.info("구간 청킹: 구간 기준 청크 %d개 (%.1f초)",
                len(plan), sum(c.duration_sec for c in plan))
    return chunk_paths
