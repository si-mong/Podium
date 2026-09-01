"""STEP 3 오케스트레이션 — full_audio.wav → voice_raw dict.

    3-1 VAD      → 무음 구간            (STT 무관, 단독 검증 가능)
    3-2 STT      → 문장 + 단어 timestamp
    3-3 필러     → VAD ∧ ¬STT + 음향 필터  /  STT 필러 어휘 매칭
    3-4 발화속도 → 음절/분 (무음 포함 speaking rate, 제외 articulation rate)

출력 dict 는 DB 스키마(`voice_raws`, `stt_sentences`) 에 그대로 매핑되는 부분과,
튜닝/검증용 진단 정보(`diagnostics`) 로 나뉨. 파이프라인 통합 시 전자만 저장.

STT 가 파이프라인에서 압도적으로 느린 단계이므로 로딩·VAD·STT 를 `Context` 로
한 번만 계산해두고, 필러 검출만 옵션을 바꿔가며 여러 번 돌릴 수 있게 분리함
(어휘 경로 vs 음향 경로 비교 — `analyze_compare`).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from stt_test import stt as stt_mod
from stt_test import vad as vad_mod
from stt_test.audio import load_wav
from stt_test.filler import detect_fillers, merge_accepted, strip_filler_words


@dataclass
class Context:
    """비싼 전처리 결과 (로딩 + VAD + STT). 필러 검출을 반복해도 재계산 안 함."""

    wav_path: Path
    samples: np.ndarray
    sr: int
    total_duration: float
    speech: list = field(default_factory=list)
    silence: list = field(default_factory=list)
    stt: stt_mod.SttResult = field(default_factory=stt_mod.SttResult)
    verbatim_prompt: bool = False
    elapsed: dict = field(default_factory=dict)

    @property
    def speech_duration(self) -> float:
        return vad_mod.total_duration_of(self.speech)


def prepare_audio(wav_path: Path, on_progress=None) -> Context:
    """3-1 만 실행 (로딩 + VAD). STT 는 아직 안 돌림.

    모델 비교처럼 같은 오디오에 STT 만 여러 번 돌릴 때 이 결과를 공유함.
    """
    def note(stage: str, msg: str) -> None:
        if on_progress:
            on_progress(stage, msg)

    t0 = time.perf_counter()
    note("loading", f"오디오 로딩: {wav_path.name}")
    samples, sr = load_wav(wav_path)
    total_duration = len(samples) / sr

    note("vad", f"3-1 VAD 무음 검출 ({total_duration:.1f}초)")
    speech = vad_mod.speech_regions(samples, sr)
    silence = vad_mod.silence_regions(speech, total_duration)
    t_vad = time.perf_counter()
    note("vad_done", f"발화 {len(speech)}구간 / 무음 {len(silence)}구간 ({t_vad - t0:.1f}초)")

    return Context(
        wav_path=wav_path, samples=samples, sr=sr, total_duration=total_duration,
        speech=speech, silence=silence,
        stt=stt_mod.SttResult(model_size="(skipped)"),
        elapsed={"vad_sec": round(t_vad - t0, 2), "stt_sec": 0.0},
    )


def run_stt(
    ctx: Context,
    model_size: str = "large-v3",
    language: str = "ko",
    verbatim_prompt: bool = False,
    on_progress=None,
) -> Context:
    """3-2 실행. ctx 를 건드리지 않고 STT 가 채워진 사본을 반환."""
    if on_progress:
        on_progress("stt", f"3-2 STT 실행 (model={model_size}) — 오래 걸립니다")

    t0 = time.perf_counter()
    result = stt_mod.transcribe(
        ctx.wav_path, model_size=model_size, language=language,
        verbatim_prompt=verbatim_prompt,
    )
    elapsed = round(time.perf_counter() - t0, 2)

    if on_progress:
        extra = " — 모델 최초 다운로드 포함" if result.load_sec > 20 else ""
        on_progress("stt_done",
                    f"[{model_size}] 문장 {len(result.sentences)}개 / "
                    f"단어 {len(result.words)}개 · 디코딩 {result.decode_sec}초 "
                    f"(모델 로딩 {result.load_sec}초{extra})")

    return replace(ctx, stt=result, verbatim_prompt=verbatim_prompt,
                   elapsed={**ctx.elapsed, "stt_sec": elapsed,
                            "stt_load_sec": result.load_sec,
                            "stt_decode_sec": result.decode_sec})


def prepare(
    wav_path: Path,
    model_size: str = "large-v3",
    language: str = "ko",
    verbatim_prompt: bool = False,
    skip_stt: bool = False,
    on_progress=None,
) -> Context:
    """3-1 + 3-2 실행. on_progress(stage, message) 로 진행 상황 통지."""
    ctx = prepare_audio(wav_path, on_progress)
    if skip_stt:
        return ctx
    return run_stt(ctx, model_size, language, verbatim_prompt, on_progress)


def build_result(ctx: Context, ablate_lexical: bool = False) -> dict:
    """3-3 + 3-4 실행 후 결과 dict 조립. ctx 재사용 가능."""
    t0 = time.perf_counter()

    # ablate_lexical: STT 가 필러를 지우는 상황(클로바노트류)을 시뮬레이션해
    # 음향 경로(VAD ∧ ¬STT)만의 성능을 측정. → filler.strip_filler_words 참고
    words = strip_filler_words(ctx.stt.words) if ablate_lexical else ctx.stt.words
    filler_result = detect_fillers(
        ctx.samples, ctx.sr, ctx.speech, words, use_lexical=not ablate_lexical
    )
    fillers = merge_accepted(filler_result)

    syllables = stt_mod.count_syllables(ctx.stt.full_text)
    total, speech_dur = ctx.total_duration, ctx.speech_duration
    speaking_rate = syllables / (total / 60.0) if total > 0 else 0.0
    articulation_rate = syllables / (speech_dur / 60.0) if speech_dur > 0 else 0.0

    return {
        # ---- DB 저장 대상 (voice_raws) ----
        "voice_raw": {
            "total_duration": round(total, 3),
            "silence_segments": [r.to_dict() for r in ctx.silence],
            "filler_words": fillers,
        },
        # ---- DB 저장 대상 (stt_sentences) ----
        "stt_sentences": [s.to_dict() for s in ctx.stt.sentences],
        # ---- 집계 지표 (segment_analyses / session_summaries 용) ----
        "metrics": {
            "total_duration": round(total, 2),
            "speech_duration": round(speech_dur, 2),
            "silence_duration": round(total - speech_dur, 2),
            "silence_ratio": round(1.0 - speech_dur / total, 3) if total else 0.0,
            "silence_count": len(ctx.silence),
            "longest_silence": round(max((r.duration for r in ctx.silence), default=0.0), 2),
            "filler_count": len(fillers),
            "filler_per_min": round(len(fillers) / (total / 60.0), 2) if total else 0.0,
            "syllable_count": syllables,
            # 한국어는 WPM(어절/분) 대신 SPM(음절/분). 일반 발표 대략 300~400.
            "speaking_rate_spm": round(speaking_rate, 1),          # 무음 포함 — 전체 템포
            "articulation_rate_spm": round(articulation_rate, 1),  # 무음 제외 — 조음 속도
        },
        # ---- 튜닝/검증용 ----
        "diagnostics": {
            "source": str(ctx.wav_path),
            "model_size": ctx.stt.model_size,
            "verbatim_prompt": ctx.verbatim_prompt,
            "ablate_lexical": ablate_lexical,
            "speech_regions": [r.to_dict() for r in ctx.speech],
            # UI 슬라이더가 무음을 재계산할 때 쓰는 기준값 (vad.MIN_SILENCE_SEC)
            "min_silence_sec": vad_mod.MIN_SILENCE_SEC,
            "speech_reference_db": round(filler_result.speech_reference_db, 1),
            "candidates": [c.to_dict() for c in filler_result.candidates],
            "words": [w.to_dict() for w in ctx.stt.words],
            "full_text": ctx.stt.full_text,
            "elapsed": {**ctx.elapsed, "filler_sec": round(time.perf_counter() - t0, 2)},
        },
    }


def analyze(
    wav_path: Path,
    model_size: str = "large-v3",
    language: str = "ko",
    verbatim_prompt: bool = False,
    skip_stt: bool = False,
    ablate_lexical: bool = False,
    on_progress=None,
) -> dict:
    """전체 STEP 3 실행 (prepare + build_result)."""
    ctx = prepare(wav_path, model_size, language, verbatim_prompt, skip_stt, on_progress)
    return build_result(ctx, ablate_lexical)


def analyze_compare(
    wav_path: Path,
    model_size: str = "large-v3",
    language: str = "ko",
    verbatim_prompt: bool = False,
    on_progress=None,
) -> dict:
    """어휘 경로 포함 vs 음향 경로만 — STT 를 한 번만 돌려서 둘 다 산출.

    두 결과의 filler_count 차이가 곧 3-3(음향 경로)의 존재 가치.
    """
    ctx = prepare(wav_path, model_size, language, verbatim_prompt, False, on_progress)
    if on_progress:
        on_progress("filler", "3-3 필러 검출 — 두 경로 비교")
    return {
        "lexical": build_result(ctx, ablate_lexical=False),
        "acoustic": build_result(ctx, ablate_lexical=True),
    }


def analyze_models(
    wav_path: Path,
    models: list[str],
    language: str = "ko",
    verbatim_prompt: bool = False,
    on_progress=None,
) -> dict[str, dict]:
    """같은 오디오를 여러 STT 모델로 돌려 비교.

    로딩·VAD(3-1)는 한 번만 하고 STT 만 모델별로 반복하므로,
    **무음 관련 지표는 모든 모델에서 동일하게 나옴** (STT 무관한 값이라 정상).
    차이가 나는 건 전사문 / 음절수 / 발화속도 / 필러뿐.
    """
    base = prepare_audio(wav_path, on_progress)
    out: dict[str, dict] = {}
    for i, model in enumerate(models, 1):
        if on_progress:
            on_progress("model", f"[{i}/{len(models)}] {model} 시작")
        ctx = run_stt(base, model, language, verbatim_prompt, on_progress)
        out[model] = build_result(ctx, ablate_lexical=False)
    return out
