"""오디오 로딩 + 경량 음향 특징 추출 (순수 numpy).

librosa 를 쓰지 않는 이유:
  - librosa 는 numba 의존 → Python 3.13 + numpy 2.x 조합에서 휠 호환이 자주 깨짐
    (backend 는 이미 Python 3.13 + numpy 2.5)
  - 우리가 필요한 건 "필러 후보 구간(0.2~2초)의 음높이가 평탄한가" 판정뿐이라
    정밀한 F0 추정기가 필요 없음. 자기상관 기반 40줄로 충분.

입력은 STEP 1 이 만든 full_audio.wav (16kHz mono PCM16) 를 가정하되,
포맷이 다르면 ffmpeg 으로 변환해서 읽음.
"""
from __future__ import annotations

import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

TARGET_SR = 16000

# F0 탐색 범위. 성인 남성 저음 ~75Hz, 성인 여성 고음 ~330Hz 를 커버.
F0_MIN = 70.0
F0_MAX = 350.0

# 자기상관 프레임. F0_MIN(70Hz) 주기가 14.3ms 이므로 최소 2주기(28.6ms)는 필요 → 40ms.
F0_FRAME_MS = 40
F0_HOP_MS = 10

# 자기상관 피크가 이 값 이상이면 "유성음(voiced)" 으로 간주.
VOICED_PEAK_THRESHOLD = 0.35


# ---------------------------------------------------------------------------
# 로딩 / 저장
# ---------------------------------------------------------------------------

def load_wav(path: Path, target_sr: int = TARGET_SR) -> tuple[np.ndarray, int]:
    """wav 를 float32 mono [-1, 1] 로 읽음.

    16kHz mono PCM16 이면 stdlib `wave` 로 바로 읽고(의존성 0),
    아니면 ffmpeg 으로 변환 후 읽음.
    """
    try:
        with wave.open(str(path), "rb") as w:
            if (
                w.getnchannels() == 1
                and w.getsampwidth() == 2
                and w.getframerate() == target_sr
            ):
                raw = w.readframes(w.getnframes())
                samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
                return samples, target_sr
    except (wave.Error, EOFError):
        pass  # ffmpeg 경로로 폴백

    return _load_via_ffmpeg(path, target_sr)


def _load_via_ffmpeg(path: Path, target_sr: int) -> tuple[np.ndarray, int]:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "conv.wav"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(path),
             "-ac", "1", "-ar", str(target_sr), "-c:a", "pcm_s16le", str(out)],
            check=True,
        )
        with wave.open(str(out), "rb") as w:
            raw = w.readframes(w.getnframes())
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return samples, target_sr


def write_wav(path: Path, samples: np.ndarray, sr: int = TARGET_SR) -> None:
    """float32 [-1,1] 를 PCM16 wav 로 저장 (후보 구간 클립 추출용)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def slice_samples(samples: np.ndarray, sr: int, t_start: float, t_end: float) -> np.ndarray:
    i0 = max(0, int(t_start * sr))
    i1 = min(len(samples), int(t_end * sr))
    if i1 <= i0:
        return np.zeros(0, dtype=np.float32)
    return samples[i0:i1]


# ---------------------------------------------------------------------------
# 에너지
# ---------------------------------------------------------------------------

def rms_db(samples: np.ndarray) -> float:
    """구간 전체의 RMS 를 dBFS 로. 무음이면 -120 반환."""
    if samples.size == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    if rms < 1e-9:
        return -120.0
    return 20.0 * float(np.log10(rms))


# ---------------------------------------------------------------------------
# F0 (자기상관)
# ---------------------------------------------------------------------------

def _frame_f0(frame: np.ndarray, sr: int, fmin: float, fmax: float) -> tuple[float, float]:
    """한 프레임의 (F0, 자기상관 피크값). 무성음/무음이면 (0.0, 0.0).

    한계: 순수 자기상관이라 옥타브 오류가 가끔 남. 우리는 F0 절대값이 아니라
    '구간 내 F0 변동폭' 만 보므로 허용 가능. (옥타브 점프는 voiced_ratio 와
    median 기반 semitone 편차에서 이상치로 드러남)
    """
    n = frame.size
    if n == 0:
        return 0.0, 0.0
    frame = frame - float(frame.mean())
    if float(np.dot(frame, frame)) < 1e-10:
        return 0.0, 0.0

    nfft = 1 << (2 * n - 1).bit_length()
    spec = np.fft.rfft(frame, nfft)
    ac = np.fft.irfft(spec * np.conj(spec), nfft)[:n]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac = ac / ac[0]

    lag_min = max(2, int(sr / fmax))
    lag_max = min(n - 1, int(sr / fmin))
    if lag_max <= lag_min:
        return 0.0, 0.0

    seg = ac[lag_min:lag_max + 1]
    i = int(np.argmax(seg))
    peak = float(seg[i])
    lag = lag_min + i
    if peak < VOICED_PEAK_THRESHOLD or lag <= 0:
        return 0.0, peak
    return sr / float(lag), peak


def f0_contour(
    samples: np.ndarray,
    sr: int,
    fmin: float = F0_MIN,
    fmax: float = F0_MAX,
) -> np.ndarray:
    """10ms 간격 F0 배열. 무성음 프레임은 0.0."""
    frame_len = int(sr * F0_FRAME_MS / 1000)
    hop = int(sr * F0_HOP_MS / 1000)
    if samples.size < frame_len:
        return np.zeros(0, dtype=np.float32)

    out = []
    for start in range(0, samples.size - frame_len + 1, hop):
        f0, _peak = _frame_f0(samples[start:start + frame_len], sr, fmin, fmax)
        out.append(f0)
    return np.asarray(out, dtype=np.float32)


@dataclass
class PitchStats:
    """구간의 음높이 안정성 요약. 필러 판정의 핵심 특징."""

    voiced_ratio: float      # 유성음 프레임 비율. 숨소리/입소리는 낮음
    f0_median: float         # Hz. 0 이면 유성음 없음
    f0_std_semitone: float   # 반음 단위 표준편차. 필러는 평탄 → 작음

    def to_dict(self) -> dict:
        return {
            "voiced_ratio": round(self.voiced_ratio, 3),
            "f0_median": round(self.f0_median, 1),
            "f0_std_semitone": round(self.f0_std_semitone, 2),
        }


def pitch_stats(samples: np.ndarray, sr: int) -> PitchStats:
    """구간의 F0 안정성.

    표준편차를 Hz 가 아니라 **반음(semitone)** 으로 재는 이유:
    Hz 편차는 화자의 기본 음높이에 비례해서 커짐(저음 남성 vs 고음 여성).
    반음은 로그 스케일이라 화자 무관하게 같은 임계값을 쓸 수 있음.
    """
    f0 = f0_contour(samples, sr)
    if f0.size == 0:
        return PitchStats(0.0, 0.0, 0.0)

    voiced = f0[f0 > 0]
    voiced_ratio = float(voiced.size) / float(f0.size)
    if voiced.size < 3:
        return PitchStats(voiced_ratio, 0.0, 0.0)

    median = float(np.median(voiced))
    semitones = 12.0 * np.log2(voiced / median)
    return PitchStats(voiced_ratio, median, float(np.std(semitones)))
