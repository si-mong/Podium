"""HuggingFace transformers 형식 Whisper 모델 → CTranslate2 변환.

faster-whisper 는 **CTranslate2 형식**만 읽는다. HF 에 올라온 한국어 파인튜닝
모델 상당수는 transformers 형식이라 그대로는 못 쓰고 한 번 변환해야 함.
변환하면 `모델 비교` 화면의 «사용자 지정 모델» 칸에 로컬 경로를 넣어 비교 가능.

    # 1) 변환 (cwd = backend/)
    python -m stt_test.convert_model <HF_모델_ID>

    # 2) 변환 결과 경로가 출력됨 → UI 사용자 지정 모델 칸에 붙여넣기
    #    또는: python -m stt_test run <wav> --model stt_test/models/<이름>

이미 CT2 형식으로 올라온 모델(예: `deepdml/faster-whisper-large-v3-turbo-ct2`)은
변환 없이 UI 에 모델 ID 를 바로 넣으면 됨.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

MODELS_DIR = Path(__file__).parent / "models"


def convert(hf_id: str, quantization: str = "int8") -> Path:
    out = MODELS_DIR / hf_id.replace("/", "__")
    if out.exists():
        print(f"이미 변환됨: {out}")
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"변환 중: {hf_id} → {out}  (quantization={quantization})")
    subprocess.run([
        "ct2-transformers-converter",
        "--model", hf_id,
        "--output_dir", str(out),
        "--quantization", quantization,
        "--copy_files", "tokenizer.json", "preprocessor_config.json",
    ], check=True)
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    path = convert(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "int8")
    print(f"\n완료. UI «사용자 지정 모델» 칸에 아래 경로를 넣으세요:\n  {path}")
