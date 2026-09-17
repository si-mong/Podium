"""
Step 2: 영상 분석 (VLM)

step2_chunking 이 잘라낸 스마트 청크 영상을 Gemini API에 전송하여
발표자의 자세 / 시선 / 제스처를 분석하고 각 동작별 횟수를 카운팅합니다.

입력: 청크 영상 파일 목록 (step2_chunking.plan_and_extract 가 생성)
출력: VLM 분석 결과 JSON 파일

청킹 정책 자체는 step2_chunking 이 책임진다. 이 모듈은 "주어진 청크를 분석"만 한다.
"""

import concurrent.futures
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
# Gemini API 일시 오류 대비. 성공할 때까지 무제한 재시도.
RETRY_WAIT_SEC = 10

_GESTURE_KEYS = (
    "explanatory_gesture",
    "distracting_gesture",
    "touching_face_or_hair",
    "pointing",
    "fidgeting_with_objects",
    "closed_posture",
    "body_movement",
)

# ── 프롬프트 ──────────────────────────────────────────────────────────────────
# vlm_test PoC 에서 다듬어진 7종 키셋. 이전 9종에서 아래처럼 정리됐다:
#   hand_movement → explanatory_gesture / negative_hand_movement → distracting_gesture
#   arms_crossed  → closed_posture
#   head_nodding, leaning_forward → 제거 (VLM 판정이 불안정하고 피드백 가치가 낮았음)

_PROMPT = """\
이 영상에서 발표자의 자세와 동작과 시선처리를 분석해 줘.

[분석 규칙]
1. 사람마다 고유한 습관이 있으므로, 아래 JSON에 명시된 '유의미한 제스처 항목'에 정확히 부합하는 동작만 엄격하게 분류해.
2. 각 제스처는 상호 배타적이야. 하나의 동작을 중복 카운트하지 마.
3. 부정적 습관(얼굴 만지기, 산만한 움직임, 물건 만지기 등)을 최우선으로 탐지하고, 순수한 설명 목적의 제스처와 완벽히 분리해.
4. 임계값 적용: 무의식적인 0.5초 미만의 찰나의 움직임은 카운트하지 마. 최소 1초 이상 지속되거나 동작의 크기가 뚜렷한 '유의미한 제스처'만 카운트해.
5. 각 제스처가 발생할 때마다 시작 타임라인("MM:SS")을 배열에 저장해 줘. (발생하지 않으면 빈 배열 [])

아래 JSON 형식으로만 답해줘 (다른 텍스트 없이):
{
  "posture": "안정적 또는 구부정 또는 과도한 움직임 또는 기댐 중 하나",
  "eye_contact": "빈번 또는 보통 또는 드묾 중 하나",
  "gesture": "적극적 또는 보통 또는 소극적 중 하나",
  "notes": "특이한 동작 습관이나 개선 포인트를 1~2문장으로 서술 (없으면 빈 문자열)",

  "gesture_counts": {
    "explanatory_gesture": "설명을 돕기 위해 의도적으로 사용한 긍정적 손/몸짓 총 횟수 (주의: 머리/얼굴 만지기, 옷 만지기는 절대 포함 금지) (정수)",
    "distracting_gesture": "옷깃을 만지거나 의미 없이 허공을 휘젓는 산만한 동작 횟수 (정수)",
    "touching_face_or_hair": "얼굴이나 머리카락을 만진 횟수 (정수)",
    "pointing": "손가락으로 무언가를 가리킨 횟수 (정수)",
    "fidgeting_with_objects": "물건(펜 등)을 만지작거린 횟수 (정수)",
    "closed_posture": "팔짱을 낀 횟수 (정수)",
    "body_movement": "발표 중 위치(동선)를 뚜렷하게 이동한 횟수 (정수)"
  },

  "gesture_timelines": {
    "explanatory_gesture": ["MM:SS", "MM:SS"],
    "distracting_gesture": [],
    "touching_face_or_hair": [],
    "pointing": [],
    "fidgeting_with_objects": [],
    "closed_posture": [],
    "body_movement": []
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


# ── 청크 1개 처리 (병렬 실행 단위) ───────────────────────────────────────────

def _process_one_chunk(client, i, chunk_path, total):
    """청크 하나를 분석하고 (인덱스, 결과dict) 를 반환. ThreadPoolExecutor에서 호출됨."""
    logger.info("[%d/%d] 분석 시작: %s", i + 1, total, chunk_path.name)

    result = None
    attempt = 0

    while result is None:
        attempt += 1
        uploaded_file = None
        try:
            uploaded_file = _upload_and_wait(client, chunk_path)
            raw = _analyze_chunk(client, uploaded_file)

            raw_counts = raw.get("gesture_counts", {})
            raw_timelines = raw.get("gesture_timelines", {})
            result = {
                "segment_id": i + 1,
                "segment_name": "chunk_{}".format(i + 1),
                "posture": raw.get("posture", "분석 불가"),
                "eye_contact": raw.get("eye_contact", "분석 불가"),
                "gesture": raw.get("gesture", "분석 불가"),
                "notes": raw.get("notes", ""),
                "gesture_counts": {k: int(raw_counts.get(k, 0)) for k in _GESTURE_KEYS},
                "gesture_timelines": {k: raw_timelines.get(k, []) for k in _GESTURE_KEYS},
            }
            logger.info(
                "[%d/%d] 완료 (시도 %d회) → posture=%s  eye=%s  gesture=%s  counts=%s",
                i + 1, total, attempt,
                result["posture"], result["eye_contact"], result["gesture"],
                result["gesture_counts"],
            )

        except Exception as e:
            logger.warning(
                "[%d/%d] 시도 %d회 실패: %s",
                i + 1, total, attempt, e,
            )
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

    return i, result


# ── 공개 API ──────────────────────────────────────────────────────────────────

def run(session_id, chunk_paths, output_dir=None):
    """
    청크 영상 목록을 받아 Gemini로 병렬 분석하고 JSON 파일로 저장합니다.

    Args:
        session_id: 세션 ID (출력 파일명에 사용)
        chunk_paths: 분석할 청크 영상 경로 목록 (step2_chunking 이 생성)
        output_dir: JSON 저장 디렉터리 (기본값: uploads/session_{id}/)

    Returns:
        {"VLM_segment_result": [...]} 형태의 분석 결과 dict.
        결과 순서는 정렬된 chunk_paths 순서와 대응한다 (파일명이 0패딩 1-based라
        사전순 = 시간순). 호출부가 청크 계획과 zip 할 수 있도록 보장된 계약.
    """
    if not chunk_paths:
        raise ValueError("분석할 청크 영상이 없습니다.")

    load_dotenv()
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise EnvironmentError("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.")
    client = genai.Client(api_key=api_key)

    chunk_paths_sorted = sorted(chunk_paths)
    total = len(chunk_paths_sorted)

    # 결과를 인덱스 → 결과dict 로 저장 (병렬 완료 순서가 뒤섞이므로)
    results_map = {}

    with concurrent.futures.ThreadPoolExecutor() as executor:
        # 모든 청크를 동시에 제출
        futures = {
            executor.submit(_process_one_chunk, client, i, chunk_path, total): i
            for i, chunk_path in enumerate(chunk_paths_sorted)
        }

        # 완료되는 순서대로 결과 수집
        for future in concurrent.futures.as_completed(futures):
            idx, result = future.result()
            results_map[idx] = result

    # 청크 번호 순서대로 정렬해서 최종 목록 생성
    results = [results_map[i] for i in range(total)]

    output = {"VLM_segment_result": results}

    # JSON 파일 저장
    save_dir = output_dir or (Path("./uploads") / str(session_id))
    save_dir.mkdir(parents=True, exist_ok=True)
    output_path = save_dir / "vlm_analysis.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("결과 저장 완료 → %s", output_path)

    return output
