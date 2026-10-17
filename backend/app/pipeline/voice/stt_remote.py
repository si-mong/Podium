"""STEP 3-2 STT 를 Modal 서버리스 GPU 에서 실행하는 클라이언트.

**왜 원격인가**
SeloWhisper(약 3GB)를 CPU 2코어 서버에서 돌리면 5분 33초 음성에 약 10분이 걸렸다.
CPU 용 변환(faster-whisper)은 비유창성 태그가 사라져서 못 쓴다 (stt_hf.py 상단 참고).
그래서 **같은 모델, 같은 디코딩 코드(stt_hf.transcribe_samples)** 를 GPU 에서 돌리고
결과(단어·시각·태그)만 받아 온다. 무음·필러·반복 계산은 지금처럼 이 서버에서 한다.

**켜는 법**
`WHISPER_MODEL=modal:<HF 모델 id>` — 예: `modal:rearleg/SeloWhisper-ko-disfluency`
Modal 인증은 환경변수 `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` (로컬은 ~/.modal.toml).
원격 쪽 코드는 backend/modal_stt.py — 코드를 바꾸면 `modal deploy modal_stt.py` 로 다시 배포.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from app.pipeline.voice.audio import load_wav
from app.pipeline.voice.stt import Sentence, SttResult, Word

APP_NAME = "podium-stt"
CLASS_NAME = "SeloWhisper"


def transcribe_modal(wav_path: Path, model_id: str, language: str = "ko") -> SttResult:
    import modal

    samples, sr = load_wav(wav_path)
    t0 = time.perf_counter()
    try:
        stt = modal.Cls.from_name(APP_NAME, CLASS_NAME)()
        # load_wav 는 PCM16 을 32768 로 나눈 값이라 PCM16 으로 되돌려 보내도 손실이 없다 (float32 대비 전송량 절반).
        pcm16 = np.round(samples * 32768.0).clip(-32768, 32767).astype("<i2").tobytes()
        out = stt.transcribe.remote(pcm16, sr, model_id, language)
    except Exception as e:   # 인증 실패, 미배포, 사용 한도 초과 등은 Modal 예외 종류가 제각각이라 묶어서 알린다
        raise RuntimeError(
            f"STT 원격 실행 실패 (Modal {APP_NAME}): {type(e).__name__}: {e}. "
            "토큰 설정, `modal deploy modal_stt.py` 배포 여부, Modal 사용 한도를 확인하세요."
        ) from e
    total = round(time.perf_counter() - t0, 2)

    words = [Word(**w) for w in out["words"]]
    sentences = [Sentence(**s) for s in out["sentences"]]
    # load_sec 자리에는 "원격 왕복 시간 - 디코딩 시간" 을 넣는다
    # (콜드 스타트·모델 로딩·업로드가 여기 다 들어간다).
    return SttResult(
        sentences=sentences, words=words, language=language,
        model_size=f"modal:{model_id} ({out['device']})",
        load_sec=round(total - out["decode_sec"], 2), decode_sec=out["decode_sec"],
    )
