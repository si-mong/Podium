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

import httpx
import requests
from dotenv import load_dotenv
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

logger = logging.getLogger(__name__)

# ── 재시도 정책 ───────────────────────────────────────────────────────────────
# 다시 하면 성공할 수도 있는 오류(요청 과다 429, 구글 서버 오류 5xx, 네트워크 끊김)만 재시도한다.
# 그 외(잘못된 요청 400, API 키 문제 401/403, 모델 없음 404, 코드/라이브러리 버전 오류 등)는
# 몇 번을 다시 해도 똑같이 실패하므로 바로 멈추고 에러를 올린다.
MAX_RETRY = 3        # 최대 시도 횟수 (첫 시도 포함)
RETRY_WAIT_SEC = 10  # 재시도 전 대기 시간 (고정)

# 네트워크 끊김 / 시간 초과 오류 (google-genai 버전에 따라 requests 또는 httpx 를 씀)
_NETWORK_ERRORS = (
    ConnectionError,
    TimeoutError,
    requests.exceptions.ConnectionError,
    requests.exceptions.Timeout,
    httpx.TransportError,
)

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
6. notes 는 위 posture/eye_contact/gesture 라벨을 그대로 반복하지 말고, **이 영상 구간 동안
   실제로 어떻게 움직이고 어디를 봤는지**를 2~3줄로 구체적으로 서술해. 자세·동작·시선처리를
   전부 다뤄야 하고(하나만 쓰지 마), "설명 제스처가 잦았지만 후반부에 시선이 화면 아래로
   자주 향했다"처럼 이 구간만의 특징을 담아. 이 데이터가 나중에 발표 코칭 피드백의 근거로
   그대로 쓰이니, "특이사항 없음" 같은 형식적인 문장 대신 관찰한 그대로를 적어.

아래 JSON 형식으로만 답해줘 (다른 텍스트 없이):
{
  "posture": "안정적 또는 구부정 또는 과도한 움직임 또는 기댐 중 하나",
  "eye_contact": "빈번 또는 보통 또는 드묾 중 하나",
  "gesture": "적극적 또는 보통 또는 소극적 중 하나",
  "notes": "이 구간의 자세·동작·시선처리를 2~3줄로 구체적으로 서술 (지침 6 참고, 정말 아무 특징도 없으면 빈 문자열)",

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
    video_file = client.files.upload(path=str(video_path))

    while video_file.state == "PROCESSING":
        time.sleep(3)
        video_file = client.files.get(name=video_file.name)

    if video_file.state != "ACTIVE":
        raise RuntimeError("파일 업로드 실패 (state={}): {}".format(video_file.state, video_path.name))

    return video_file


# ── Gemini 분석 요청 ──────────────────────────────────────────────────────────

def _analyze_chunk(client, uploaded_file):
    """업로드된 Gemini 파일을 분석하고 결과 dict를 반환."""
    # google-genai 0.3.0 은 File 객체를 contents 에 그대로 넣으면 빈 part 로 바뀌어
    # 영상이 모델에 전달되지 않는다 ("영상을 볼 수 없다"는 답이 옴) → Part.from_uri 로 감싼다.
    video_part = types.Part.from_uri(file_uri=uploaded_file.uri, mime_type=uploaded_file.mime_type)
    response = client.models.generate_content(
        model="gemini-3.8-flash",
        contents=[video_part, _PROMPT],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
        ),
    )
    return json.loads(response.text)


# ── 청크 1개 처리 (병렬 실행 단위) ───────────────────────────────────────────

def _is_retryable(e):
    """다시 시도하면 성공할 수도 있는 오류인지 판단."""
    # Gemini API 가 돌려준 오류 → 상태 코드로 판단
    if isinstance(e, genai_errors.APIError):
        return e.code == 429 or e.code >= 500
    return isinstance(e, _NETWORK_ERRORS)


def _process_one_chunk(client, i, chunk_path, total):
    """청크 하나를 분석하고 (인덱스, 결과dict) 를 반환. ThreadPoolExecutor에서 호출됨."""
    logger.info("[%d/%d] 분석 시작: %s", i + 1, total, chunk_path.name)

    for attempt in range(1, MAX_RETRY + 1):
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
            return i, result

        except Exception as e:
            if not _is_retryable(e):
                logger.error("[%d/%d] 재시도로 해결되지 않는 오류라 중단: %r", i + 1, total, e)
                raise
            if attempt == MAX_RETRY:
                logger.error("[%d/%d] %d회 모두 실패해서 중단: %r", i + 1, total, MAX_RETRY, e)
                raise

            logger.warning(
                "[%d/%d] 시도 %d회 실패: %r → %d초 후 재시도",
                i + 1, total, attempt, e, RETRY_WAIT_SEC,
            )
            time.sleep(RETRY_WAIT_SEC)

        finally:
            # 분석 완료 후 구글 서버에서 즉시 삭제하여 용량 확보
            if uploaded_file is not None:
                try:
                    client.files.delete(name=uploaded_file.name)
                    logger.info("[%d/%d] 구글 서버 임시 파일 삭제 완료", i + 1, total)
                except Exception as del_err:
                    logger.warning("임시 파일 삭제 실패: %s", del_err)


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
