"""GPU 서버용 STEP 3 음성 분석 서버.

노트북 백엔드(app.main)는 DB·프론트를 그대로 맡고, 무거운 STEP 3(SeloWhisper)만
학교 GPU 서버에 맡긴다. 노트북 `.env` 에 `STT_REMOTE_URL` 을 넣으면
`step3_voice_analysis.run()` 이 wav 를 이 서버의 /step3 로 보낸다.

GPU 서버에서 실행 (backend 폴더에서):

    uvicorn gpu_server.stt_server:app --host 0.0.0.0 --port 8002

- 포트 8002 는 외부 18002 로 매핑돼 있다 → 노트북에서는 http://10.198.138.104:18002
- DB 는 쓰지 않는다. 결과 dict 를 돌려주기만 하고 저장은 노트북 백엔드가 한다.
- 이 서버의 `.env` 에는 STT_REMOTE_URL 을 넣지 말 것 (자기 자신에게 보내게 됨).
  → 그래서 여기서는 run() 대신 analyze() 를 직접 부른다.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile

from app.core.config import settings
from app.pipeline.voice.analyze import analyze

app = FastAPI(title="Podium STEP3 GPU 서버")


@app.get("/health")
def health():
    """연결 확인용. GPU 를 제대로 잡았는지(cuda: true) 여기서 본다."""
    import torch

    cuda = torch.cuda.is_available()
    return {
        "cuda": cuda,
        "gpu": torch.cuda.get_device_name(0) if cuda else None,
        "model": settings.whisper_model,
    }


@app.post("/step3")
def step3(file: UploadFile = File(...), keywords: str = Form("")):
    """wav 를 받아 STEP 3 전체(VAD + STT + 필러 + 반복 + 발화속도)를 실행.

    반환값은 로컬 실행 때의 analyze() 결과와 같은 dict.
    """
    # 분석이 끝나면 임시 폴더째 지워진다 (GPU 서버에 음성 파일이 남지 않음).
    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "full_audio.wav"
        with open(wav_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        return analyze(wav_path, model_size=settings.whisper_model, keywords=keywords)
