"""STEP 3-2 — faster-whisper STT (단어 단위 timestamp 포함).

openai-whisper 대신 faster-whisper 를 쓰는 이유:
  1) Python 3.13 에서 openai-whisper 가 빌드 실패 (pkg_resources) — 기존 알려진 이슈
  2) CTranslate2 기반이라 CPU 에서 수 배 빠름 (torch 불필요 → 설치 용량도 작음)
  3) `word_timestamps=True` 가 네이티브 지원 — STEP 3-3 이 단어 경계를 요구함

STT 결과 자체는 "필러가 걸러진 깨끗한 전사" 여도 괜찮음.
필러 검출은 이 결과의 **빈틈**(3-3) 에서 하기 때문.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

# Whisper 가 필러를 뱉도록 유도하는 프롬프트. 디코더가 프롬프트의 문체를 따라가는
# 성질을 이용한 것으로, 효과가 **일관적이지 않음**. 3-3 의 보조 신호로만 쓰고
# 이것만 믿고 지표를 만들지 말 것. (--verbatim-prompt 로 켜서 A/B 비교용)
#
# ⚠️ 적용 범위 주의 — initial_prompt vs hotwords
#   faster-whisper 소스(transcribe.py) 기준:
#     initial_prompt : all_tokens 맨 앞에 삽입되는데, condition_on_previous_text=False
#                      (우리 설정)이면 윈도우마다 prompt_reset_since 가 밀려서
#                      **첫 30초 윈도우에만** 영향을 주고 이후엔 사라짐.
#     hotwords       : TranscriptionOptions 에 실려 **매 윈도우 get_prompt() 에서
#                      다시 주입**됨. 긴 녹음 전체에 일관되게 적용.
#   → 문체 유도(필러)는 initial_prompt, 도메인 어휘 편향은 hotwords 가 맞음.
#   둘은 같은 <|startofprev|> 블록에 hotwords → previous_tokens 순으로 이어 붙으므로
#   동시에 써도 충돌하지 않음 (각각 max_length//2 토큰으로 잘림).
VERBATIM_PROMPT = "음... 어... 그... 저기, 뭐랄까... 어, 그러니까 이제, 음..."

# Whisper 기본 vocab 상한. 파인튜닝으로 추가된 토큰은 이 위에 얹히는데,
# 그 영역은 faster-whisper 가 타임스탬프로 해석한다(timestamp 범위 50365~51865).
# 모델이 추가 토큰을 생성하면 타임스탬프로 오해돼 **세그먼트가 조기 종료되고 전사가 잘린다.**
# → 생성 자체를 억제하면 CT2 경로에서도 정상 동작한다. 태그 정보는 잃지만
#   파인튜닝된 한국어 인식 품질과 verbatim 전사(필러가 평문으로 남음)는 그대로 유지된다.
_WHISPER_VOCAB_MAX = 51866


def _extra_token_ids(model_size: str) -> list[int]:
    """로컬 CT2 모델의 확장 vocab 토큰 id 목록 (억제 대상)."""
    vocab = Path(model_size) / "vocabulary.json"
    if not vocab.exists():
        return []
    try:
        n = len(json.loads(vocab.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, OSError):
        return []
    return list(range(_WHISPER_VOCAB_MAX, n)) if n > _WHISPER_VOCAB_MAX else []


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
    keywords: str = ""
    # 모델 비교 시 속도를 공정하게 재려면 둘을 반드시 분리해야 함:
    # load_sec 은 **처음 쓰는 모델이면 다운로드 시간까지 포함**하므로 속도 지표가 못 됨.
    load_sec: float = 0.0
    decode_sec: float = 0.0

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
    keywords: str | None = None,
) -> SttResult:
    """단어 timestamp 포함 전사.

    keywords: 발표 주제·고유명사·전문용어를 쉼표나 공백으로 나열하면 `hotwords` 로
      전달돼 해당 어휘의 인식률이 올라감. 모델을 바꾸지 않고 정확도를 올리는
      가장 값싼 수단. 위 VERBATIM_PROMPT 주석의 적용 범위 차이 참고.

    핵심 옵션 두 개:
      - vad_filter=False : **반드시 꺼야 함.** faster-whisper 내장 VAD 가 켜지면
        비어휘 발성 구간을 통째로 잘라버려서 3-3 의 차집합이 무너짐.
        VAD 는 3-1 에서 우리가 직접 통제한다.
      - condition_on_previous_text=False : 긴 무음이 많은 발표 영상에서
        Whisper 가 직전 문장을 반복 생성하는 환각을 줄임.
    """
    # `hf:` 접두사면 transformers 런타임으로 위임.
    # 비유창성 토큰을 추가한 파인튜닝 모델은 CTranslate2 에서 토큰이 소실되고
    # 세그먼트가 깨지기 때문 — 자세한 이유는 stt_hf.py 상단 참고.
    if model_size.startswith("hf:"):
        from app.pipeline.voice.stt_hf import transcribe_hf
        return transcribe_hf(wav_path, model_size[3:], language=language)

    from faster_whisper import WhisperModel  # 무거우므로 lazy import

    t0 = time.perf_counter()
    # 캐시에 없으면 여기서 모델을 내려받음 → 이 구간이 load_sec
    model = WhisperModel(model_size, device="cpu", compute_type=compute_type)
    t_load = time.perf_counter()

    # 확장 vocab 모델이면 추가 토큰 생성을 억제 (위 _extra_token_ids 주석 참고)
    suppress = [-1] + _extra_token_ids(model_size)

    segments, _info = model.transcribe(
        str(wav_path),
        language=language,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=False,
        beam_size=5,
        # ⚠️ temperature 를 단일값으로 고정하면 Whisper 의 **반복 루프 방어 기제가 꺼진다.**
        #    라이브러리 기본 사다리를 쓰면 compression_ratio_threshold(2.4)가 반복 출력을
        #    감지해 더 높은 온도로 재시도한다. 다만 실측 결과 **사다리만으로는 부족**했고
        #    ("네. 네. 네…" 25회 연속 유지), no_repeat_ngram_size 를 함께 켜야 사라졌다.
        #
        # ⚠️ repetition_penalty 는 쓰지 않는다. 같은 토큰 재생성 전반에 페널티를 주어
        #    **진짜 말더듬까지 억누른다** ("제 제 제가" → "제제 제가" 로 붙어버려 3-5
        #    반복 검출이 2/3 로 떨어짐). no_repeat_ngram_size 는 4-gram 단위만 막으므로
        #    짧은 말더듬 반복은 통과시키면서 할루시네이션 루프만 끊는다.
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        no_repeat_ngram_size=4,     # 4-gram 반복 금지 (할루시네이션 루프 차단)
        initial_prompt=VERBATIM_PROMPT if verbatim_prompt else None,
        hotwords=keywords.strip() if keywords and keywords.strip() else None,
        suppress_tokens=suppress,
    )

    result = SttResult(language=language, model_size=model_size,
                       keywords=keywords or "",
                       load_sec=round(t_load - t0, 2))
    for seg in segments:  # generator — 여기서 실제 디코딩이 진행됨
        result.sentences.append(
            Sentence(seg.text.strip(), seg.start, seg.end, seg.no_speech_prob)
        )
        for w in seg.words or []:
            result.words.append(
                Word(w.word.strip(), w.start, w.end, getattr(w, "probability", 1.0))
            )
    result.decode_sec = round(time.perf_counter() - t_load, 2)
    return result
