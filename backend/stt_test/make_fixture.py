"""3-3 판별기 검증용 합성 오디오 생성 (정답 라벨 포함).

실제 발표 녹음이 준비되기 전에도 "필러 판별 원리가 작동하는가" 를 정량 측정하기
위한 픽스처. macOS `say` 로 만든 한국어 TTS 문장 사이에 아래를 **정확한 시각에**
끼워넣고, 그 시각을 ground truth 로 저장함.

    filler   TTS 로 발음한 필러("음","으으음","어어")  → 채택되어야 함
    breath   저레벨/고레벨 무성 잡음                    → 기각되어야 함 (숨소리 모사)

⚠️ 개발 중 발견 — 합성 모음을 쓰면 안 되는 이유
    처음엔 성문파+포먼트로 합성한 지속 모음을 필러로 썼는데, Silero VAD 가 이걸
    **발화로 전혀 인정하지 않음(0%)**. 반면 TTS 로 발음한 필러는 85~96% 인정.
    즉 합성 모음은 VAD 단계에서 탈락해 3-3 을 시험조차 못 함.
    → 픽스처의 필러는 반드시 실제 발성(TTS 또는 사람) 기반이어야 함.

한계: TTS 는 사람 발화가 아니고 필러 지속시간도 짧음. 이건 **판별 원리의
      sanity check** 이지 실제 성능 근거가 아님. 실제 성능은 사람 녹음 +
      report.html 라벨링으로 재야 함 (→ evaluate.py).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from stt_test.audio import TARGET_SR, load_wav, rms_db, write_wav

VOICE = "Yuna"

SENTENCES = [
    "안녕하세요 오늘 발표를 맡은 김은재입니다",
    "저희 팀이 개발한 서비스는 발표 연습을 도와주는 인공지능 코치입니다",
    "영상을 업로드하면 음성과 동작을 함께 분석합니다",
    "구간별로 어떤 습관이 있었는지 알려드립니다",
    "발표를 반복할수록 성장 추이가 데이터로 쌓입니다",
    "지금까지 발표를 들어주셔서 감사합니다",
]

# 문장 뒤에 끼워넣을 항목.
#   ("filler", 발음할 텍스트, say 속도)      → 채택되어야 함
#   ("breath", 길이초, 발화레벨 대비 dB)     → 기각되어야 함
INJECTIONS = [
    ("filler", "음", 120),
    ("filler", "으으음", 80),
    ("filler", "어어", 90),
    ("breath", 0.50, -25.0),   # 조용한 숨소리 → too_quiet 로 걸려야 함
    ("breath", 0.45, -8.0),    # 큰 숨소리    → unvoiced 로 걸려야 함
]

GAP_SEC = 0.9        # 문장 사이 기본 무음
BUFFER_SEC = 0.05    # 주입 구간 앞뒤 최소 버퍼


def _tts(text: str, tmp: Path, rate: int | None = None) -> np.ndarray:
    aiff, wav = tmp / "t.aiff", tmp / "t.wav"
    cmd = ["say", "-v", VOICE, "-o", str(aiff)]
    if rate:
        cmd += ["-r", str(rate)]
    subprocess.run(cmd + [text], check=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(aiff),
         "-ac", "1", "-ar", str(TARGET_SR), "-c:a", "pcm_s16le", str(wav)],
        check=True,
    )
    return load_wav(wav)[0]


def _breath(duration: float, sr: int = TARGET_SR) -> np.ndarray:
    """저역이 깎인 무성 잡음 — 숨소리/입소리 모사."""
    n = int(duration * sr)
    rng = np.random.default_rng(7)
    noise = rng.standard_normal(n)
    noise = np.diff(noise, prepend=noise[0])  # 1차 하이패스
    sig = noise * np.hanning(n)
    peak = float(np.max(np.abs(sig))) or 1.0
    return (sig / peak).astype(np.float32)


def _scaled_to(sig: np.ndarray, target_db: float) -> np.ndarray:
    cur = rms_db(sig)
    if cur <= -119:
        return sig
    return (sig * (10 ** ((target_db - cur) / 20.0))).astype(np.float32)


def build(out_wav: Path) -> dict:
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sr = TARGET_SR

    with tempfile.TemporaryDirectory() as tmpname:
        tmp = Path(tmpname)
        speech = [_tts(s, tmp) for s in SENTENCES]
        speech_db = float(np.median([rms_db(s) for s in speech]))

        injected: list[tuple[str, np.ndarray, str | None]] = []
        for item in INJECTIONS:
            if item[0] == "filler":
                _, text, rate = item
                injected.append(("filler", _scaled_to(_tts(text, tmp, rate), speech_db), text))
            else:
                _, dur, rel_db = item
                injected.append(("breath", _scaled_to(_breath(dur), speech_db + rel_db), None))

    track: list[np.ndarray] = []
    truth: list[dict] = []
    cursor = 0.0

    def push(sig: np.ndarray) -> float:
        nonlocal cursor
        track.append(sig)
        start = cursor
        cursor += len(sig) / sr
        return start

    def silence(sec: float) -> None:
        push(np.zeros(int(sec * sr), dtype=np.float32))

    silence(0.6)
    for i, sent in enumerate(speech):
        push(sent)
        if i >= len(injected):
            silence(GAP_SEC)
            continue

        kind, sig, text = injected[i]
        silence(BUFFER_SEC)
        t0 = push(sig)
        truth.append({
            "kind": kind,
            "text": text,
            "t_start": round(t0, 3),
            "t_end": round(t0 + len(sig) / sr, 3),
            "expect_filler": kind == "filler",
        })
        silence(BUFFER_SEC)
        silence(GAP_SEC)

    silence(1.5)

    full = np.concatenate(track)
    write_wav(out_wav, full, sr)

    meta = {
        "wav": str(out_wav),
        "duration": round(len(full) / sr, 3),
        "speech_reference_db": round(speech_db, 1),
        "injections": truth,
        "sentences": SENTENCES,
    }
    out_wav.with_suffix(".truth.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return meta


if __name__ == "__main__":
    import sys
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("stt_test/fixtures/synthetic_ko.wav")
    print(json.dumps(build(target), ensure_ascii=False, indent=2))
