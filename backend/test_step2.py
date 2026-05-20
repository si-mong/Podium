import os
import sys
from pathlib import Path

os.environ["GEMINI_API_KEY"] = "AIzaSyCny9Z9c18Ti1B6gsIoPP7PmV2ficshzbQ"

sys.path.insert(0, str(Path(__file__).parent))

from app.pipeline.step2_video_analysis import run

video_path = Path(r"C:\Users\jinso\Desktop\KakaoTalk_20260326_192607461.mp4")

result = run(
    session_id=1,
    chunk_paths=[video_path],
)

import json
print(json.dumps(result, ensure_ascii=False, indent=2))
