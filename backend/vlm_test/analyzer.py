"""VLM 분석 로직 (Gemini). 정적 영상 파일 → 30초 청크 → 청크별 동작 분석.

팀원의 test_vlm.py 를 모듈화. 진행 상황은 on_event 콜백으로 푸시 (SSE용).
"""
from __future__ import annotations

import concurrent.futures
import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from google import genai
from google.genai import types

CHUNK_SEC = 30
RETRY_WAIT_SEC = 10
MAX_RETRIES = 3

_GESTURE_KEYS = (
    "hand_movement",
    "touching_face_or_hair",
    "pointing",
    "emphasizing_hand_movement",
    "head_nodding",
    "leaning_forward",
    "fidgeting_with_objects",
    "arms_crossed",
    "swaying_body",
    "scratching",
)

_PROMPT = """\
이 영상에서 발표자의 자세와 동작과 시선처리를 분석해주고 각 동작별 횟수를 세줘.

아래 JSON 형식으로만 답해줘 (다른 텍스트 없이):
{
  "posture": "안정적 또는 구부정 또는 과도한 움직임 또는 기댐 중 하나",
  "eye_contact": "빈번 또는 간헐적 또는 드묾 중 하나",
  "gesture": "적극적 또는 보통 또는 소극적 또는 반복적 중 하나",
  "notes": "특이한 동작 습관이나 개선 포인트를 1~2문장으로 서술 (없으면 빈 문자열)",
  "gesture_counts": {
    "hand_movement": 손을 움직인 총 횟수 (정수),
    "touching_face_or_hair": 얼굴이나 머리카락을 만진 횟수 (정수),
    "pointing": 손가락으로 무언가를 가리킨 횟수 (정수),
    "emphasizing_hand_movement": 강조하듯 손을 움직인 횟수 (정수),
    "head_nodding": 고개를 끄덕인 횟수 (정수),
    "leaning_forward": 몸을 앞으로 기울인 횟수 (정수),
    "fidgeting_with_objects": 물건을 만지작거린 횟수 (정수),
    "arms_crossed": 팔짱을 낀 횟수 (정수),
    "swaying_body": 몸을 좌우로 흔든 횟수 (정수),
    "scratching": 긁은 횟수 (정수)
  }
}
"""


EventCallback = Callable[[str, dict], None]


@dataclass
class ChunkResult:
    segment_id: int
    segment_name: str
    posture: str
    eye_contact: str
    gesture: str
    notes: str
    gesture_counts: dict[str, int]

    def to_dict(self) -> dict:
        return {
            "segment_id": self.segment_id,
            "segment_name": self.segment_name,
            "posture": self.posture,
            "eye_contact": self.eye_contact,
            "gesture": self.gesture,
            "notes": self.notes,
            "gesture_counts": self.gesture_counts,
        }


def split_video(video_path: Path, out_dir: Path) -> list[Path]:
    """ffmpeg로 CHUNK_SEC 단위로 분할. -c copy로 빠르게."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # 기존 청크가 남아있으면 정리
    for old in out_dir.glob("chunk_*.mp4"):
        old.unlink()

    pattern = str(out_dir / "chunk_%03d.mp4")
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(video_path),
            "-c", "copy", "-map", "0",
            "-segment_time", str(CHUNK_SEC),
            "-f", "segment",
            "-reset_timestamps", "1",
            pattern,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        tail = result.stderr[-800:] if result.stderr else ""
        raise RuntimeError(f"ffmpeg split failed: {tail}")
    return sorted(out_dir.glob("chunk_*.mp4"))


def _upload_and_wait(client: genai.Client, video_path: Path):
    f = client.files.upload(file=str(video_path))
    while f.state.name == "PROCESSING":
        time.sleep(3)
        f = client.files.get(name=f.name)
    if f.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini upload state={f.state.name}: {video_path.name}")
    return f


def _analyze_chunk(client: genai.Client, uploaded_file) -> dict:
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[uploaded_file, _PROMPT],
        config=types.GenerateContentConfig(response_mime_type="application/json"),
    )
    return json.loads(response.text)


def _process_one_chunk(
    client: genai.Client,
    idx: int,
    chunk_path: Path,
    on_event: EventCallback,
) -> tuple[int, ChunkResult | None]:
    on_event("chunk_start", {"segment_id": idx + 1, "name": chunk_path.name})

    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        uploaded = None
        try:
            uploaded = _upload_and_wait(client, chunk_path)
            raw = _analyze_chunk(client, uploaded)
            counts = raw.get("gesture_counts", {})
            result = ChunkResult(
                segment_id=idx + 1,
                segment_name=f"chunk_{idx + 1}",
                posture=raw.get("posture", "분석 불가"),
                eye_contact=raw.get("eye_contact", "분석 불가"),
                gesture=raw.get("gesture", "분석 불가"),
                notes=raw.get("notes", ""),
                gesture_counts={k: int(counts.get(k, 0)) for k in _GESTURE_KEYS},
            )
            on_event("chunk_done", {"attempt": attempt, "result": result.to_dict()})
            return idx, result
        except Exception as e:
            last_err = e
            on_event("chunk_retry", {
                "segment_id": idx + 1,
                "attempt": attempt,
                "error": str(e),
            })
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_WAIT_SEC)
        finally:
            if uploaded is not None:
                try:
                    client.files.delete(name=uploaded.name)
                except Exception:
                    pass

    on_event("chunk_failed", {
        "segment_id": idx + 1,
        "error": str(last_err),
    })
    return idx, None


def run_analysis(
    video_path: Path,
    work_dir: Path,
    api_key: str,
    on_event: EventCallback,
    max_workers: int | None = None,
) -> dict:
    """전체 흐름. on_event로 진행상황을 푸시하고, 끝나면 최종 dict 반환."""
    client = genai.Client(api_key=api_key)

    on_event("splitting", {"video": video_path.name})
    chunks = split_video(video_path, work_dir / "chunks")
    total = len(chunks)
    on_event("split_done", {"total": total})

    if total == 0:
        result = {"VLM_segment_result": []}
        on_event("done", result)
        return result

    results_map: dict[int, ChunkResult | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as exe:
        futures = {
            exe.submit(_process_one_chunk, client, i, path, on_event): i
            for i, path in enumerate(chunks)
        }
        for fut in concurrent.futures.as_completed(futures):
            i, res = fut.result()
            results_map[i] = res

    ordered = [
        results_map[i].to_dict() if results_map[i] is not None else None
        for i in range(total)
    ]
    output = {"VLM_segment_result": ordered}
    (work_dir / "result.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    on_event("done", output)
    return output
