"""STEP 2 VLM 임시 검증 스크립트.

사용법:
  1) backend/.env 에 GEMINI_API_KEY=... 설정
  2) 환경변수 STEP2_TEST_VIDEO 에 분석할 영상 파일 경로 지정
       export STEP2_TEST_VIDEO=/path/to/chunk_000.webm
  3) cd backend && python test_step2.py

이 파일은 임시 검증용으로 향후 정식 테스트 코드(tests/)로 옮겨갈 예정.
절대 API 키나 로컬 경로를 하드코딩하지 말 것.
"""
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app.pipeline.step2_video_analysis import run

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

video_env = os.environ.get("STEP2_TEST_VIDEO")
if not video_env:
    sys.exit(
        "환경변수 STEP2_TEST_VIDEO 가 설정되지 않았습니다.\n"
        "예: export STEP2_TEST_VIDEO=/path/to/chunk_000.webm"
    )

video_path = Path(video_env)
if not video_path.exists():
    sys.exit(f"영상 파일을 찾을 수 없음: {video_path}")

result = run(
    session_id=1,
    chunk_paths=[video_path],
)

print(json.dumps(result, ensure_ascii=False, indent=2))
