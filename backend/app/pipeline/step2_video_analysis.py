"""
Step 2: 영상 분석 (VLM)

전처리 단계(Step 1)에서 생성된 30초 단위 청크 영상을 Gemini API에 전송하여
발표자의 자세 / 시선 / 제스처를 분석하고 각 동작별 횟수를 카운팅합니다.

입력: 청크 영상 파일 목록 (step1 에서 생성)
출력: VLM 분석 결과 JSON 파일
"""

import json
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

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

# ── Gemini 파일 업로드 ────────────────────────────────────────────────────────

def _upload_and_wait(client, video_path):
    """청크 영상을 Gemini File API에 업로드하고 처리 완료까지 대기."""
    logger.info("업로드 중: %s", video_path.name)
    video_file = client.files.upload(file=str(video_path))

    while video_file.state.name == "PROCESSING":
        time.sleep(3)
        video_file = client.files.get(name=video_file.name)

    if video_file.state.name != "ACTIVE":
        raise RuntimeError("파일 업로드 실패 (state={}): {}".format(video_file.state.name, video_path.name))

    return video_file


# ── Gemini 분석 요청 ──────────────────────────────────────────────────────────

def _analyze_chunk(client, uploaded_file):
    """업로드된 Gemini 파일을 분석하고 결과 dict를 반환."""
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[uploaded_file, _PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
        ),
    )
    return json.loads(response.text)


# ── 공개 API ──────────────────────────────────────────────────────────────────

def run(session_id, chunk_paths, output_dir=None):
    """
    30초 단위 청크 영상 목록을 받아 Gemini로 분석하고 JSON 파일로 저장합니다.

    Args:
        session_id: 세션 ID (출력 파일명에 사용)
        chunk_paths: 전처리 단계에서 생성된 청크 영상 경로 목록
        output_dir: JSON 저장 디렉터리 (기본값: uploads/session_{id}/)

    Returns:
        {"VLM_segment_result": [...]} 형태의 분석 결과 dict
    """
    if not chunk_paths:
        raise ValueError("청크 영상이 없습니다. Step 1(전처리)이 완료됐는지 확인하세요.")

    load_dotenv()
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise EnvironmentError("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.")
    client = genai.Client(api_key=api_key)

    results = []
    chunk_paths_sorted = sorted(chunk_paths)
    total = len(chunk_paths_sorted)

    retry_wait = 30  # 실패 시 재시도 대기 시간 (초)

    for i, chunk_path in enumerate(chunk_paths_sorted):
        logger.info("[%d/%d] 분석 시작: %s", i + 1, total, chunk_path.name)

        result = None
        attempt = 0

        while result is None:
            attempt += 1
            uploaded_file = None
            try:
                uploaded_file = _upload_and_wait(client, chunk_path)
                raw = _analyze_chunk(client, uploaded_file)

                result = {
                    "segment_id": i + 1,
                    "segment_name": "chunk_{}".format(i + 1),
                    "posture": raw.get("posture", "분석 불가"),
                    "eye_contact": raw.get("eye_contact", "분석 불가"),
                    "gesture": raw.get("gesture", "분석 불가"),
                    "notes": raw.get("notes", ""),
                    "gesture_counts": {
                        "hand_movement": raw.get("gesture_counts", {}).get("hand_movement", 0),
                        "touching_face_or_hair": raw.get("gesture_counts", {}).get("touching_face_or_hair", 0),
                        "pointing": raw.get("gesture_counts", {}).get("pointing", 0),
                        "emphasizing_hand_movement": raw.get("gesture_counts", {}).get("emphasizing_hand_movement", 0),
                        "head_nodding": raw.get("gesture_counts", {}).get("head_nodding", 0),
                        "leaning_forward": raw.get("gesture_counts", {}).get("leaning_forward", 0),
                        "fidgeting_with_objects": raw.get("gesture_counts", {}).get("fidgeting_with_objects", 0),
                        "arms_crossed": raw.get("gesture_counts", {}).get("arms_crossed", 0),
                        "swaying_body": raw.get("gesture_counts", {}).get("swaying_body", 0),
                        "scratching": raw.get("gesture_counts", {}).get("scratching", 0),
                    },
                }
                logger.info(
                    "[%d/%d] 완료 → posture=%s  eye=%s  gesture=%s  counts=%s",
                    i + 1, total,
                    result["posture"], result["eye_contact"], result["gesture"],
                    result["gesture_counts"],
                )

            except Exception as e:
                logger.warning("[%d/%d] 시도 %d 실패: %s", i + 1, total, attempt, e)
                logger.info("[%d/%d] %d초 후 재시도합니다...", i + 1, total, retry_wait)
                time.sleep(retry_wait)

            finally:
                # 분석 완료 후 구글 서버에서 즉시 삭제하여 용량 확보
                if uploaded_file is not None:
                    try:
                        client.files.delete(name=uploaded_file.name)
                        logger.info("[%d/%d] 구글 서버 임시 파일 삭제 완료", i + 1, total)
                    except Exception as del_err:
                        logger.warning("임시 파일 삭제 실패: %s", del_err)

        results.append(result)

    output = {"VLM_segment_result": results}

    # JSON 파일 저장
    save_dir = output_dir or (Path("./uploads") / str(session_id))
    save_dir.mkdir(parents=True, exist_ok=True)
    output_path = save_dir / "vlm_analysis.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("결과 저장 완료 → %s", output_path)

    return output
