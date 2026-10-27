"""Modal 서버리스 GPU 에서 돌아가는 STT (STEP 3-2) 앱.

배포:  cd backend && modal deploy modal_stt.py
호출:  app/pipeline/voice/stt_remote.py (WHISPER_MODEL=modal:<모델 id> 일 때)

- 디코딩은 app/pipeline/voice/stt_hf.py 의 transcribe_samples 를 **그대로** 쓴다 → 로컬과 결과가 같다.
- 모델은 이미지 빌드 때 내려받아 둔다 → 컨테이너가 뜰 때 Hugging Face 에서 다시 받지 않는다.
- 요청이 없으면 scaledown_window 뒤에 컨테이너가 꺼지고, 쓴 시간만 과금된다.
"""
import modal

MODEL_ID = "rearleg/SeloWhisper-ko-disfluency"


def _download_model():
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL_ID)


image = (
    modal.Image.debian_slim(python_version="3.13")
    # 버전은 requirements-pipeline.txt 와 맞춘다 (CPU 결과와 같게 하려고)
    .pip_install("torch==2.14.0", "transformers==5.16.1", "numpy")
    .env({"HF_HOME": "/models"})
    .run_function(_download_model)
    .add_local_python_source("app")
)

app = modal.App("podium-stt", image=image)


# L4 재고가 없으면 몇 분~15분씩 배정 대기가 생겨서(2026-10-27 확인) A10G → T4 순으로 대체한다.
@app.cls(gpu=["L4", "A10G", "T4"], timeout=15 * 60, scaledown_window=120, max_containers=3)
class SeloWhisper:
    @modal.enter()
    def load(self):
        import time
        import torch
        from app.pipeline.voice.stt_hf import get_model
        t0 = time.perf_counter()
        get_model(MODEL_ID, "cuda")    # 컨테이너가 뜰 때 한 번만 GPU 에 올린다
        self.model_load_sec = round(time.perf_counter() - t0, 2)
        self.gpu = torch.cuda.get_device_name(0)
        self.calls = 0                 # 0 이면 이번 호출이 이 컨테이너의 첫 호출 = 콜드 스타트

    @modal.method()
    def transcribe(self, samples: bytes, sr: int, model_id: str, language: str = "ko") -> dict:
        """samples: 16kHz mono PCM16 (little-endian) 바이트."""
        import time
        import numpy as np
        started_at = time.time()       # 호출부가 "보낸 시각 → 여기 도착" 으로 GPU 배정 대기를 잰다
        cold = self.calls == 0
        self.calls += 1
        from app.pipeline.voice.stt_hf import transcribe_samples

        if model_id != MODEL_ID:
            raise ValueError(f"이 앱은 {MODEL_ID} 전용입니다 (요청: {model_id}). modal_stt.py 의 MODEL_ID 를 바꿔 다시 배포하세요.")
        audio = np.frombuffer(samples, dtype="<i2").astype(np.float32) / 32768.0   # load_wav 와 같은 정규화
        r = transcribe_samples(audio, sr, MODEL_ID, language=language, device="cuda")
        return {
            "words": [vars(w) for w in r.words],
            "sentences": [vars(s) for s in r.sentences],
            "decode_sec": r.decode_sec,
            "device": "cuda",
            "started_at": started_at,
            "gpu": self.gpu,
            "cold": cold,
            "model_load_sec": self.model_load_sec if cold else 0.0,
        }
