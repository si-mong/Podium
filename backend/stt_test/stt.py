"""STEP 3-2 — faster-whisper STT (단어 단위 timestamp 포함).

openai-whisper 대신 faster-whisper 를 쓰는 이유:
  1) Python 3.13 에서 openai-whisper 가 빌드 실패 (pkg_resources) — 기존 알려진 이슈
  2) CTranslate2 기반이라 CPU 에서 수 배 빠름 (torch 불필요 → 설치 용량도 작음)
  3) `word_timestamps=True` 가 네이티브 지원 — STEP 3-3 이 단어 경계를 요구함

STT 결과 자체는 "필러가 걸러진 깨끗한 전사" 여도 괜찮음.
필러 검출은 이 결과의 **빈틈**(3-3) 에서 하기 때문.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# Whisper 가 필러를 뱉도록 유도하는 프롬프트. 디코더가 프롬프트의 문체를 따라가는
# 성질을 이용한 것으로, 효과가 **일관적이지 않음**. 3-3 의 보조 신호로만 쓰고
# 이것만 믿고 지표를 만들지 말 것. (--verbatim-prompt 로 켜서 A/B 비교용)
VERBATIM_PROMPT = "음... 어... 그... 저기, 뭐랄까... 어, 그러니까 이제, 음..."

# 한글 음절 블록 (가 ~ 힣). 한국어 발화 속도는 어절(WPM)이 아니라 음절 기준이
# 안정적임 — 띄어쓰기 정책에 따라 어절 수가 크게 흔들리기 때문.
_HANGUL_START, _HANGUL_END = 0xAC00, 0xD7A3


@dataclass
class Word:
    text: str
    t_start: float
    t_end: float
    probability: float

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "t_start": round(self.t_start, 3),
            "t_end": round(self.t_end, 3),
            "probability": round(self.probability, 3),
        }


@dataclass
class Sentence:
    text: str
    t_start: float
    t_end: float
    no_speech_prob: float

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "t_start": round(self.t_start, 3),
            "t_end": round(self.t_end, 3),
            "no_speech_prob": round(self.no_speech_prob, 3),
        }


@dataclass
class SttResult:
    sentences: list[Sentence] = field(default_factory=list)
    words: list[Word] = field(default_factory=list)
    language: str = "ko"
    model_size: str = ""

    @property
    def full_text(self) -> str:
        return " ".join(s.text.strip() for s in self.sentences).strip()


def count_syllables(text: str) -> int:
    """한글 음절 수 + 숫자/영문은 대략 2문자=1음절로 환산."""
    hangul = sum(1 for ch in text if _HANGUL_START <= ord(ch) <= _HANGUL_END)
    other = sum(1 for ch in text if ch.isalnum() and not (_HANGUL_START <= ord(ch) <= _HANGUL_END))
    return hangul + other // 2


def transcribe(
    wav_path: Path,
    model_size: str = "large-v3",
    language: str = "ko",
    compute_type: str = "int8",
    verbatim_prompt: bool = False,
) -> SttResult:
    """단어 timestamp 포함 전사.

    핵심 옵션 두 개:
      - vad_filter=False : **반드시 꺼야 함.** faster-whisper 내장 VAD 가 켜지면
        비어휘 발성 구간을 통째로 잘라버려서 3-3 의 차집합이 무너짐.
        VAD 는 3-1 에서 우리가 직접 통제한다.
      - condition_on_previous_text=False : 긴 무음이 많은 발표 영상에서
        Whisper 가 직전 문장을 반복 생성하는 환각을 줄임.
    """
    from faster_whisper import WhisperModel  # 무거우므로 lazy import

    model = WhisperModel(model_size, device="cpu", compute_type=compute_type)
    segments, _info = model.transcribe(
        str(wav_path),
        language=language,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
        beam_size=5,
        temperature=0.0,
        initial_prompt=VERBATIM_PROMPT if verbatim_prompt else None,
    )

    result = SttResult(language=language, model_size=model_size)
    for seg in segments:  # generator — 여기서 실제 디코딩이 진행됨
        result.sentences.append(
            Sentence(seg.text.strip(), seg.start, seg.end, seg.no_speech_prob)
        )
        for w in seg.words or []:
            result.words.append(
                Word(w.word.strip(), w.start, w.end, getattr(w, "probability", 1.0))
            )
    return result
