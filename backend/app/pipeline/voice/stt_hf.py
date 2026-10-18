"""transformers 런타임 STT 백엔드 (비유창성 태그 모델용).

**왜 별도 백엔드가 필요한가**
faster-whisper(CTranslate2)는 `eot` 보다 큰 토큰 id 를 특수/타임스탬프로 해석한다.
파인튜닝으로 추가된 비유창성 토큰(SeloWhisper 의 경우 51866~51875)은 그 영역에
얹히므로 **토큰이 사라질 뿐 아니라 세그먼트 경계가 깨져 전사가 잘린다.**
그래서 이런 모델은 transformers 로 직접 돌리고 디코딩을 우리가 통제한다.

**단어 timestamp**
`generate(..., return_token_timestamps=True)` 로 토큰별 시각을 받는다
(모델 generation_config 에 `alignment_heads` 가 있어야 동작).
필러·반복·무음 매칭이 전부 단어 경계 위에 서 있어 이 값이 없으면 파이프라인이 성립하지 않는다.

**비유창성 태그 처리**
`<um>` 같은 태그는 앞 단어에 붙지 않고 **독립 Word 로 분리**해서 내보낸다.
그래야 (1) 필러 어휘 매칭이 태그를 바로 집을 수 있고
     (2) 반복 검출이 "제 <repeat> 제 <repeat> 제가" 에서 태그를 건너뛰고 인접 비교를 할 수 있다.
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path

import numpy as np

from app.pipeline.voice.audio import TARGET_SR, load_wav
from app.pipeline.voice.stt import Sentence, SttResult, Word

# 모델이 내보내는 비유창성 태그. 값은 대응하는 한국어 표기(필러 집계용).
DISFLUENCY_TAGS = {
    "<ah>": "아", "<uh>": "어", "<um>": "음", "<gue>": "그",
    "<jeo>": "저", "<mwo>": "뭐", "<mak>": "막",
    "<repeat>": None,   # 반복 표시 — 필러가 아님
    "<laugh>": None,
    "<other>": None,
}
TAG_RE = re.compile(r"<[a-z]+>")

# Whisper 인코더가 한 번에 보는 길이(초). 이 단위로 잘라 돌리고 시각을 보정한다.
WINDOW_SEC = 30.0


def is_tag(text: str) -> bool:
    return bool(TAG_RE.fullmatch(text.strip()))


def _load_model(model_id: str, device: str | None = None):
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    if device is None:
        # 애플 실리콘이면 MPS, NVIDIA GPU 면 CUDA (Modal 원격 실행), 그 외에는 cpu.
        if torch.backends.mps.is_available():
            device = "mps"
        elif torch.cuda.is_available():
            device = "cuda"
        else:
            device = "cpu"
    proc = WhisperProcessor.from_pretrained(model_id)
    model = WhisperForConditionalGeneration.from_pretrained(model_id).to(device).eval()
    return proc, model, device


# 모델(약 3GB)은 프로세스당 한 번만 올려서 재사용한다.
# 예전에는 분석마다 새로 올려서, 동시에 3건이 돌면 모델이 3개 올라가 8GB 서버가 죽을 수 있었다.
# 디코딩도 한 번에 1건만 돌린다 — CPU 2코어에서 동시에 돌리면 각각 느려질 뿐이고,
# 같은 모델 객체를 여러 스레드가 동시에 generate 하는 것도 피한다. 나머지 요청은 줄을 서서 기다린다.
_cache: dict[tuple[str, str | None], tuple] = {}
_cache_lock = threading.Lock()
_decode_lock = threading.Lock()


def get_model(model_id: str, device: str | None = None):
    """(proc, model, device) 를 캐시에서 꺼내거나 처음이면 올린다. 두 번째 값은 로딩 초."""
    key = (model_id, device)
    with _cache_lock:
        if key in _cache:
            return _cache[key], 0.0
        t0 = time.perf_counter()
        _cache[key] = _load_model(model_id, device)
        return _cache[key], round(time.perf_counter() - t0, 2)


def _decode_window(proc, model, device, chunk: np.ndarray, offset: float,
                   language: str) -> list[Word]:
    """30초 윈도우 하나를 디코딩해 Word 목록으로. 시각은 offset 만큼 이동.

    ⚠️ 윈도우 여러 개를 한 번에 묶어 generate 하면 GPU 에서 빨라질 것 같지만, 단어 시각용
       `return_token_timestamps` 가 인코더 attention 까지 전부 반환해서 묶음 4개만 돼도
       그것만 20GB 를 넘는다 (L4 24GB 에서 메모리 부족). 그래서 하나씩 돌린다.
    """
    import torch

    feats = proc(chunk, sampling_rate=TARGET_SR, return_tensors="pt").input_features
    feats = feats.to(device)
    with torch.no_grad():
        out = model.generate(
            feats, language=language, task="transcribe",
            return_token_timestamps=True, max_new_tokens=440,
        )
    ids = out["sequences"][0].tolist()
    stamps = out["token_timestamps"][0].tolist()

    tok = proc.tokenizer
    # ⚠️ 토큰을 하나씩 decode 하면 안 된다. Whisper 는 byte-level BPE 라 한글 한 글자가
    #    여러 토큰에 걸쳐 있고, 개별 디코딩하면 바이트열이 쪼개져 글자가 깨진다.
    #    → 경계는 토큰 문자열(`Ġ` = 공백)로 찾고, **디코딩은 단어 단위로 묶어서** 한다.
    pieces = tok.convert_ids_to_tokens(ids)

    # `token_timestamps` 는 각 토큰의 **시작 시각**이다. 따라서 단어의 끝은
    # 마지막 토큰의 시각이 아니라 **그 다음 토큰의 시각**으로 잡아야 한다.
    # 안 그러면 1토큰 단어가 길이 0 이 되고, 단어 사이에 가짜 틈이 생겨
    # 음향 필러 후보(VAD ∧ ¬STT)가 대량 오검출된다.
    entries: list[tuple[list[int] | str, int, int]] = []   # (ids 또는 태그, 시작idx, 끝idx)
    buf_ids: list[int] = []
    buf_i = None

    def flush(end_i: int) -> None:
        nonlocal buf_ids, buf_i
        if buf_ids:
            entries.append((buf_ids, buf_i, end_i))
        buf_ids, buf_i = [], None

    for k, (tid, piece) in enumerate(zip(ids, pieces)):
        if piece.startswith("<|") and piece.endswith("|>"):
            continue                                    # 표준 특수 토큰은 버림
        if piece in DISFLUENCY_TAGS:                    # 태그는 독립 항목으로
            flush(k - 1)
            entries.append((piece, k, k))
            continue
        if piece.startswith("\u0120") and buf_ids:      # Ġ = 새 단어 시작
            flush(k - 1)
        if buf_i is None:
            buf_i = k
        buf_ids.append(tid)
    flush(len(ids) - 1)

    last = len(stamps) - 1
    words: list[Word] = []
    for item, i0, i1 in entries:
        start = stamps[min(i0, last)]
        end = stamps[min(i1 + 1, last)]        # 다음 토큰 시각 = 이 단어의 끝
        if end < start:
            end = start
        text = item if isinstance(item, str) else tok.decode(
            item, skip_special_tokens=False).strip()
        if text:
            words.append(Word(text, offset + start, offset + end, 1.0))
    return words


def transcribe_hf(
    wav_path: Path,
    model_id: str,
    language: str = "ko",
    device: str | None = None,
) -> SttResult:
    """transformers 로 전사. faster-whisper 경로와 같은 SttResult 를 돌려준다."""
    samples, sr = load_wav(wav_path)
    return transcribe_samples(samples, sr, model_id, language=language, device=device)


def transcribe_samples(
    samples: np.ndarray,
    sr: int,
    model_id: str,
    language: str = "ko",
    device: str | None = None,
) -> SttResult:
    """이미 읽어 둔 오디오(16kHz mono float32)를 전사. Modal 원격 실행도 이 함수를 그대로 쓴다."""
    (proc, model, dev), load_sec = get_model(model_id, device)
    step = int(WINDOW_SEC * sr)

    with _decode_lock:
        t1 = time.perf_counter()
        words: list[Word] = []
        for i in range(0, len(samples), step):
            chunk = samples[i:i + step]
            if len(chunk) < sr * 0.5:      # 0.5초 미만 꼬리는 버림
                break
            words.extend(_decode_window(proc, model, dev, chunk, i / sr, language))
        decode_sec = round(time.perf_counter() - t1, 2)

    # 문장 분리: 종결 부호 기준. faster-whisper 의 세그먼트에 대응하는 근사치.
    # 문장 텍스트에서는 비유창성 태그를 뺀다 (→ stt_sentences.text 가 평문).
    # words 에는 그대로 남으므로 필러·반복 검출은 영향받지 않고,
    # 태그 포함본은 SttResult.tagged_text 로 따로 볼 수 있다.
    def _join(ws: list[Word]) -> str:
        return " ".join(w.text for w in ws if not is_tag(w.text)).strip()

    sentences: list[Sentence] = []
    cur: list[Word] = []
    for w in words:
        cur.append(w)
        if w.text.endswith((".", "?", "!")):
            sentences.append(Sentence(_join(cur), cur[0].t_start, cur[-1].t_end, 0.0))
            cur = []
    if cur:
        sentences.append(Sentence(_join(cur), cur[0].t_start, cur[-1].t_end, 0.0))

    return SttResult(sentences=sentences, words=words, language=language,
                     model_size=f"hf:{model_id} ({dev})",
                     load_sec=load_sec, decode_sec=decode_sec)
