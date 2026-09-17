"""STEP 3-1 — VAD 기반 발화/무음 구간 검출.

STT 를 전혀 쓰지 않음. 무음은 신호처리 문제이고, STT 세그먼트 timestamp 는
디코더가 만든 근사치라 경계가 뭉개지기 때문. 이 모듈만으로
`voice_raws.silence_segments` 가 완성되고 독립 검증이 가능함.

VAD 모델은 faster-whisper 에 번들된 Silero VAD(ONNX) 를 재사용 —
별도 설치도, torch 도 필요 없음.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from faster_whisper.vad import VadOptions, get_speech_timestamps

# 무음으로 집계할 최소 길이(초). 이보다 짧은 침묵은 음절 사이 자연스러운
# 끊김(폐쇄음 등)이라 "발표에서의 멈춤" 으로 볼 수 없음.
MIN_SILENCE_SEC = 0.7

# --- VAD 파라미터 (faster-whisper 기본값을 그대로 쓰면 안 되는 이유) ---
# faster-whisper 의 기본값은 min_silence_duration_ms=2000, speech_pad_ms=400 인데
# 이건 "Whisper 에 넣을 덩어리를 자르는" 용도로 튜닝된 값임. 우리 목적에는 치명적:
#   - speech_pad=400ms : 발화 구간을 앞뒤로 부풀림 → 무음 구간이 0.8초씩 짧아지고
#                        STEP 3-3 의 차집합(발화 ∧ ¬단어)에 가짜 구간이 대량 생김
#   - min_silence=2000ms: 2초 미만 침묵을 발화로 흡수 → 우리가 세려는 멈춤이 사라짐
# → 패딩 0, 최소 침묵 100ms 로 "경계를 있는 그대로" 받아서 후처리는 우리가 함.
VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 100
VAD_SPEECH_PAD_MS = 0
VAD_MIN_SPEECH_MS = 0


@dataclass
class Region:
    """시간 구간 (초)."""

    t_start: float
    t_end: float

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start

    def to_dict(self) -> dict:
        return {
            "t_start": round(self.t_start, 3),
            "t_end": round(self.t_end, 3),
            "duration": round(self.duration, 3),
        }


def speech_regions(
    samples: np.ndarray,
    sr: int,
    threshold: float = VAD_THRESHOLD,
    min_silence_ms: int = VAD_MIN_SILENCE_MS,
    speech_pad_ms: int = VAD_SPEECH_PAD_MS,
) -> list[Region]:
    """사람 목소리가 있는 구간 목록."""
    opts = VadOptions(
        threshold=threshold,
        min_speech_duration_ms=VAD_MIN_SPEECH_MS,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=speech_pad_ms,
    )
    raw = get_speech_timestamps(samples, opts, sampling_rate=sr)
    # get_speech_timestamps 는 '샘플 인덱스' 를 돌려줌 → 초로 변환
    return [Region(r["start"] / sr, r["end"] / sr) for r in raw]


def silence_regions(
    speech: list[Region],
    total_duration: float,
    min_silence_sec: float = MIN_SILENCE_SEC,
) -> list[Region]:
    """발화 구간의 여집합 중 `min_silence_sec` 이상인 것 = 무음 구간."""
    gaps: list[Region] = []
    cursor = 0.0
    for r in speech:
        if r.t_start - cursor >= min_silence_sec:
            gaps.append(Region(cursor, r.t_start))
        cursor = max(cursor, r.t_end)
    if total_duration - cursor >= min_silence_sec:
        gaps.append(Region(cursor, total_duration))
    return gaps


def total_duration_of(regions: list[Region]) -> float:
    return float(sum(r.duration for r in regions))
