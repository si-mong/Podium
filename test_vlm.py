"""
VLM 분석 테스트 스크립트

사용법:
  1. VIDEO_PATH 에 분석할 영상 파일 경로 입력
  2. python test_vlm.py 실행

결과: output.json 파일로 저장
"""

import concurrent.futures
import json
import os
import subprocess
import time
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

# ── 설정 ──────────────────────────────────────────────────────────────────────

VIDEO_PATH = r"C:\Users\jinso\Downloads\YTDown_YouTube_Media_aRD1azmnfYs_002_720p.mp4"
CHUNK_SEC = 30
RETRY_WAIT_SEC = 10
OUTPUT_FILE = "output.json"

# ── 제스처 키 ─────────────────────────────────────────────────────────────────

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

# ── 프롬프트 ──────────────────────────────────────────────────────────────────

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


# ── ffmpeg로 영상을 30초 단위로 자르기 ────────────────────────────────────────

def split_video(video_path, output_dir):
    print("영상을 {}초 단위로 자르는 중...".format(CHUNK_SEC))
    output_dir.mkdir(exist_ok=True)
    pattern = str(output_dir / "chunk_%03d.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path),
         "-c", "copy", "-map", "0",
         "-segment_time", str(CHUNK_SEC),
         "-f", "segment",
         "-reset_timestamps", "1",
         pattern],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    chunks = sorted(output_dir.glob("chunk_*.mp4"))
    print("총 {}개 청크 생성 완료".format(len(chunks)))
    return chunks


# ── Gemini 파일 업로드 ────────────────────────────────────────────────────────

def _upload_and_wait(client, video_path):
    print("  업로드 중: {}".format(video_path.name))
    video_file = client.files.upload(file=str(video_path))
    while video_file.state.name == "PROCESSING":
        time.sleep(3)
        video_file = client.files.get(name=video_file.name)
    if video_file.state.name != "ACTIVE":
        raise RuntimeError("파일 업로드 실패 (state={}): {}".format(video_file.state.name, video_path.name))
    return video_file


# ── Gemini 분석 요청 ──────────────────────────────────────────────────────────

def _analyze_chunk(client, uploaded_file):
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[uploaded_file, _PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
        ),
    )
    return json.loads(response.text)


# ── 청크 1개 처리 (병렬 실행 단위) ───────────────────────────────────────────

def _process_one_chunk(client, i, chunk_path, total):
    print("[{}/{}] 분석 시작: {}".format(i + 1, total, chunk_path.name))

    result = None
    attempt = 0

    while result is None:
        attempt += 1
        uploaded_file = None
        try:
            uploaded_file = _upload_and_wait(client, chunk_path)
            raw = _analyze_chunk(client, uploaded_file)

            raw_counts = raw.get("gesture_counts", {})
            result = {
                "segment_id": i + 1,
                "segment_name": "chunk_{}".format(i + 1),
                "posture": raw.get("posture", "분석 불가"),
                "eye_contact": raw.get("eye_contact", "분석 불가"),
                "gesture": raw.get("gesture", "분석 불가"),
                "notes": raw.get("notes", ""),
                "gesture_counts": {k: int(raw_counts.get(k, 0)) for k in _GESTURE_KEYS},
            }
            print("  [{}/{}] 완료 (시도 {}회) → posture={}  eye={}  gesture={}".format(
                i + 1, total, attempt,
                result["posture"], result["eye_contact"], result["gesture"]
            ))

        except Exception as e:
            print("  [{}/{}] 시도 {}회 실패: {}".format(i + 1, total, attempt, e))
            print("  [{}/{}] {}초 후 재시도...".format(i + 1, total, RETRY_WAIT_SEC))
            time.sleep(RETRY_WAIT_SEC)

        finally:
            if uploaded_file is not None:
                try:
                    client.files.delete(name=uploaded_file.name)
                    print("  [{}/{}] 구글 서버 임시 파일 삭제 완료".format(i + 1, total))
                except Exception as del_err:
                    print("  임시 파일 삭제 실패: {}".format(del_err))

    return i, result


# ── 메인 ──────────────────────────────────────────────────────────────────────

def main():
    load_dotenv()
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        print("오류: GEMINI_API_KEY 환경변수가 없습니다. .env 파일을 만들어주세요.")
        return

    video_path = Path(VIDEO_PATH)
    if not video_path.exists():
        print("오류: 영상 파일을 찾을 수 없습니다: {}".format(VIDEO_PATH))
        return

    client = genai.Client(api_key=api_key)
    chunk_dir = Path("chunks")
    chunks = split_video(video_path, chunk_dir)

    total = len(chunks)
    results_map = {}

    with concurrent.futures.ThreadPoolExecutor() as executor:
        futures = {
            executor.submit(_process_one_chunk, client, i, chunk_path, total): i
            for i, chunk_path in enumerate(chunks)
        }
        for future in concurrent.futures.as_completed(futures):
            idx, result = future.result()
            results_map[idx] = result

    results = [results_map[i] for i in range(total)]
    output = {"VLM_segment_result": results}

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print("\n완료! 결과 저장: {}".format(OUTPUT_FILE))


if __name__ == "__main__":
    main()
