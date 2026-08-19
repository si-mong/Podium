"""STEP 3 오케스트레이션 — full_audio.wav → voice_raw dict.

    3-1 VAD      → 무음 구간            (STT 무관, 단독 검증 가능)
    3-2 STT      → 문장 + 단어 timestamp
    3-3 필러     → VAD ∧ ¬STT + 음향 필터
    3-4 발화속도 → 음절/분 (무음 포함 speaking rate, 제외 articulation rate)

출력 dict 는 DB 스키마(`voice_raws`, `stt_sentences`) 에 그대로 매핑되는 부분과,
튜닝/검증용 진단 정보(`diagnostics`) 로 나뉨. 파이프라인 통합 시 전자만 저장.
"""
from __future__ import annotations

import time
from pathlib import Path

from stt_test import stt as stt_mod
from stt_test import vad as vad_mod
from stt_test.audio import load_wav
from stt_test.filler import FillerResult, detect_fillers, merge_accepted, strip_filler_words


def analyze(
    wav_path: Path,
    model_size: str = "large-v3",
    language: str = "ko",
    verbatim_prompt: bool = False,
    skip_stt: bool = False,
    ablate_lexical: bool = False,
) -> dict:
    """전체 STEP 3 실행.

    skip_stt=True 면 3-1(무음)만 수행 — STT 없이 무음 지표만 빠르게 볼 때 사용.
    """
    t0 = time.perf_counter()
    samples, sr = load_wav(wav_path)
    total_duration = len(samples) / sr

    # --- 3-1 VAD -----------------------------------------------------------
    speech = vad_mod.speech_regions(samples, sr)
    silence = vad_mod.silence_regions(speech, total_duration)
    speech_duration = vad_mod.total_duration_of(speech)
    t_vad = time.perf_counter()

    if skip_stt:
        stt_result = stt_mod.SttResult(language=language, model_size="(skipped)")
        filler_result = FillerResult()
    else:
        # --- 3-2 STT -------------------------------------------------------
        stt_result = stt_mod.transcribe(
            wav_path,
            model_size=model_size,
            language=language,
            verbatim_prompt=verbatim_prompt,
        )
        # --- 3-3 필러 ------------------------------------------------------
        # ablate_lexical: STT 가 필러를 지우는 상황을 시뮬레이션해
        # 음향 경로(VAD∧¬STT)만의 성능을 측정 (filler.strip_filler_words 참고)
        words = strip_filler_words(stt_result.words) if ablate_lexical else stt_result.words
        filler_result = detect_fillers(
            samples, sr, speech, words, use_lexical=not ablate_lexical
        )
    t_stt = time.perf_counter()

    # --- 3-4 발화 속도 ------------------------------------------------------
    syllables = stt_mod.count_syllables(stt_result.full_text)
    speaking_rate = syllables / (total_duration / 60.0) if total_duration > 0 else 0.0
    articulation_rate = syllables / (speech_duration / 60.0) if speech_duration > 0 else 0.0

    fillers = merge_accepted(filler_result)

    return {
        # ---- DB 저장 대상 (voice_raws) ----
        "voice_raw": {
            "total_duration": round(total_duration, 3),
            "silence_segments": [r.to_dict() for r in silence],
            "filler_words": fillers,
        },
        # ---- DB 저장 대상 (stt_sentences) ----
        "stt_sentences": [s.to_dict() for s in stt_result.sentences],
        # ---- 집계 지표 (segment_analyses / session_summaries 용) ----
        "metrics": {
            "total_duration": round(total_duration, 2),
            "speech_duration": round(speech_duration, 2),
            "silence_duration": round(total_duration - speech_duration, 2),
            "silence_ratio": round(1.0 - speech_duration / total_duration, 3) if total_duration else 0.0,
            "silence_count": len(silence),
            "longest_silence": round(max((r.duration for r in silence), default=0.0), 2),
            "filler_count": len(fillers),
            "filler_per_min": round(len(fillers) / (total_duration / 60.0), 2) if total_duration else 0.0,
            "syllable_count": syllables,
            # 한국어는 WPM(어절/분) 대신 SPM(음절/분). 일반 발표 대략 300~400.
            "speaking_rate_spm": round(speaking_rate, 1),      # 무음 포함 — 전체 템포
            "articulation_rate_spm": round(articulation_rate, 1),  # 무음 제외 — 조음 속도
        },
        # ---- 튜닝/검증용 ----
        "diagnostics": {
            "source": str(wav_path),
            "model_size": stt_result.model_size,
            "verbatim_prompt": verbatim_prompt,
            "ablate_lexical": ablate_lexical,
            "speech_regions": [r.to_dict() for r in speech],
            "speech_reference_db": round(filler_result.speech_reference_db, 1),
            "candidates": [c.to_dict() for c in filler_result.candidates],
            "words": [w.to_dict() for w in stt_result.words],
            "elapsed": {
                "vad_sec": round(t_vad - t0, 2),
                "stt_and_filler_sec": round(t_stt - t_vad, 2),
            },
        },
    }
