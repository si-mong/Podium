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

# ── 재시도 정책 ───────────────────────────────────────────────────────────────
# Gemini API 일시 오류 대비. 청크 1개당 최대 MAX_ATTEMPTS 회 시도.
# 모두 실패하면 placeholder 결과로 진행 (전체 파이프라인은 멈추지 않음).
MAX_ATTEMPTS = 3
RETRY_WAIT_SEC = 30

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

    for i, chunk_path in enumerate(chunk_paths_sorted):
        logger.info("[%d/%d] 분석 시작: %s", i + 1, total, chunk_path.name)

        result = None
        last_error = None

        for attempt in range(1, MAX_ATTEMPTS + 1):
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
                logger.info(
                    "[%d/%d] 완료 → posture=%s  eye=%s  gesture=%s  counts=%s",
                    i + 1, total,
                    result["posture"], result["eye_contact"], result["gesture"],
                    result["gesture_counts"],
                )
                break  # 성공 → 재시도 루프 탈출

            except Exception as e:
                last_error = e
                logger.warning(
                    "[%d/%d] 시도 %d/%d 실패: %s",
                    i + 1, total, attempt, MAX_ATTEMPTS, e,
                )
                if attempt < MAX_ATTEMPTS:
                    logger.info("[%d/%d] %d초 후 재시도...", i + 1, total, RETRY_WAIT_SEC)
                    time.sleep(RETRY_WAIT_SEC)

            finally:
                # 분석 완료 후 구글 서버에서 즉시 삭제하여 용량 확보
                if uploaded_file is not None:
                    try:
                        client.files.delete(name=uploaded_file.name)
                        logger.info("[%d/%d] 구글 서버 임시 파일 삭제 완료", i + 1, total)
                    except Exception as del_err:
                        logger.warning("임시 파일 삭제 실패: %s", del_err)

        if result is None:
            # MAX_ATTEMPTS 회 모두 실패 — placeholder 로 진행, 키셋은 동일 유지
            logger.error(
                "[%d/%d] %d회 모두 실패. placeholder 로 진행. 마지막 오류: %s",
                i + 1, total, MAX_ATTEMPTS, last_error,
            )
            result = {
                "segment_id": i + 1,
                "segment_name": "chunk_{}".format(i + 1),
                "posture": "분석 실패",
                "eye_contact": "분석 실패",
                "gesture": "분석 실패",
                "notes": "VLM 분석 {}회 실패: {}".format(MAX_ATTEMPTS, last_error),
                "gesture_counts": {k: 0 for k in _GESTURE_KEYS},
            }

        results.append(result)

    output = {"VLM_segment_result": results}

    # JSON 파일 저장
    save_dir = output_dir or (Path("./uploads") / str(session_id))
    save_dir.mkdir(parents=True, exist_ok=True)
    output_path = save_dir / "vlm_analysis.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("결과 저장 완료 → %s", output_path)

    return output
