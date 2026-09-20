"""
Step 5: 구간별 LLM 분석

STEP2(영상)·STEP3(음성 타임라인)·STEP4(구간분리+집계) 결과를 구간마다 Gemini 에게 보내
구간별 잘한 점·개선점을 받는다. (발표 전체를 한 번에 보는 "종합분석"은 2026-09-20 에 제거함)

STEP1(전처리)은 안 보낸다 — 그 결과물(전체 길이)은 voice_timeline.total_duration 에 이미 있다.
STEP3는 요약이 아니라 **원본 타임라인**(silence_segments/filler_words/repetitions)을 보낸다.
시각 근거가 가장 중요해서, 시각 변환·보장·검증은 전부 코드가 한다
(_add_time_labels / _ensure_timestamps / _generate_validated).
"""
from __future__ import annotations

import json
import logging
import re
import time

logger = logging.getLogger(__name__)

MODEL = "gemini-2.5-flash"
MAX_ATTEMPTS = 3
RETRY_WAIT_SEC = 5


def _mmss(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 60}:{sec % 60:02d}"


def _add_time_labels(obj):
    """복사본을 돌려준다. t_start/t_end 가 있는 모든 dict 에 time_label("M:SS~M:SS")을 붙인다.

    데이터의 시각은 12.48 같은 소수 초라, Gemini 에게 "M:SS 로 바꿔 쓰라"고 하면 계산을
    틀릴 수 있다. 변환은 코드가 하고 Gemini 는 time_label 을 그대로 옮기게 한다.
    """
    if isinstance(obj, list):
        return [_add_time_labels(x) for x in obj]
    if isinstance(obj, dict):
        out = {k: _add_time_labels(v) for k, v in obj.items()}
        t0, t1 = obj.get("t_start"), obj.get("t_end")
        if isinstance(t0, (int, float)) and isinstance(t1, (int, float)):
            a, b = _mmss(t0), _mmss(t1)
            out["time_label"] = a if a == b else f"{a}~{b}"
        return out
    return obj


_TIME_RE = re.compile(r"\d+:\d\d")


def _collect_time_tokens(obj) -> set[str]:
    """데이터의 모든 time_label 에 들어 있는 M:SS 조각의 집합 (= Gemini 가 써도 되는 시각)."""
    tokens: set[str] = set()

    def walk(o):
        if isinstance(o, dict):
            tl = o.get("time_label")
            if isinstance(tl, str):
                tokens.update(_TIME_RE.findall(tl))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(obj)
    return tokens


def _bad_times(text: str, allowed: set[str]) -> list[str]:
    return [t for t in _TIME_RE.findall(text) if t not in allowed]


def _all_bad_times(obj, allowed: set[str]) -> list[str]:
    """결과(dict/list/str) 안의 모든 문자열에서 데이터에 없는 시각을 찾는다."""
    if isinstance(obj, str):
        return _bad_times(obj, allowed)
    if isinstance(obj, list):
        return sorted({b for x in obj for b in _all_bad_times(x, allowed)})
    if isinstance(obj, dict):
        return sorted({b for v in obj.values() for b in _all_bad_times(v, allowed)})
    return []


def _sanitize(obj, allowed: set[str]):
    """마지막 수단: 데이터에 없는 시각이 든 목록 항목은 통째로, 문장은 그 문장만 지운다."""
    if isinstance(obj, list):
        return [_sanitize(x, allowed) for x in obj
                if not (isinstance(x, str) and _bad_times(x, allowed))]
    if isinstance(obj, dict):
        return {k: _sanitize(v, allowed) for k, v in obj.items()}
    if isinstance(obj, str) and _bad_times(obj, allowed):
        sentences = re.split(r"(?<=[.!?])\s+", obj)
        return " ".join(x for x in sentences if not _bad_times(x, allowed))
    return obj


def _generate_validated(client, types, prompt: str, allowed: set[str], tag: str) -> dict:
    """Gemini 를 호출하고, 결과의 **모든 시각이 데이터의 time_label 에 있는 시각인지** 검증한다.

    time_label 을 붙여 보내도 Gemini 가 시각을 지어내거나 바꿔 쓸 수 있어서, 결과를 코드가 확인한다.
      1) 데이터에 없는 시각이 있으면 그 시각을 알려주고 다시 요청 (최대 MAX_ATTEMPTS 회)
      2) 그래도 남으면 그 항목·문장을 제거 — 잘못된 시각이 사용자에게 나가지 않게 한다.
    """
    last_err = None
    last_parsed = None
    hint = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = client.models.generate_content(
                model=MODEL,
                contents=prompt + hint,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.4,
                ),
            )
            parsed = json.loads(resp.text)
        except Exception as exc:  # noqa: BLE001 — 재시도 대상
            last_err = exc
            logger.warning("%s 시도 %d 실패: %s", tag, attempt, exc)
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_WAIT_SEC)
            continue

        bad = _all_bad_times(parsed, allowed)
        if not bad:
            return parsed
        last_parsed = parsed
        logger.warning("%s 시도 %d: 데이터에 없는 시각 %s → 다시 요청", tag, attempt, bad)
        hint = ("\n\n## 정정 요청\n이전 답변에 데이터에 없는 시각(" + ", ".join(bad) + ")이 있었습니다. "
                "데이터의 time_label 에 있는 시각만 그대로 사용해서 처음부터 다시 작성하세요.")

    if last_parsed is not None:
        logger.warning("%s: 재시도 후에도 잘못된 시각이 남아 해당 항목을 제거함", tag)
        return _sanitize(last_parsed, allowed)
    raise RuntimeError(f"{tag} 실패 ({MAX_ATTEMPTS}회): {last_err}")


# ═══════════════════════════════════════════════════════════════════════════
# 구간별 분석
#
# **구간 하나씩** Gemini 에 맡긴다.
# 구간마다 따로 호출하는 이유: 한 번에 다 맡기면 뒤쪽 구간 분석이 짧아지고
# 구간별 근거(시각·횟수)가 흐려진다. 대신 호출이 구간 수만큼 나간다.
#
# 구간 하나에 보내는 것:
#   - outline        : 발표 전체 구간 목록(라벨·제목·시각) — 흐름 안에서의 위치 파악용
#   - segment        : 이 구간의 라벨·제목·시각·전사문·지표
#   - video_analysis : 이 구간과 시간이 겹치는 영상 조각 (STEP4 집계와 같은 기준.
#                      경계에 걸친 조각은 양쪽 구간에 다 들어간다)
#   - voice_timeline : 이 구간 안에서 **시작하는** 무음·필러·반복 (STEP4 집계와 같은 기준)
# 결과(strengths / improvements 목록)는 feedbacks 테이블의 같은 이름 JSONB 칸에 저장한다.
# ═══════════════════════════════════════════════════════════════════════════

SEGMENT_PROMPT = """당신은 발표 코칭 전문가입니다.
아래는 발표 전체 중 **한 구간**을 분석한 데이터입니다. 이 구간의 **잘한 점**과 **개선점**을 작성하세요.

## 지침
1. 이 구간의 데이터(segment, video_analysis, voice_timeline)를 근거로 삼으세요.
   outline 은 발표 전체 흐름 속에서 이 구간이 어디쯤인지 파악하는 참고용입니다.
2. **모든 항목에는 근거가 된 시각을 넣으세요.** 데이터의 time_label(예: 3:45~3:52)을
   문장 안에 그대로 쓰고, 그 시각에 무슨 일이 있었는지(필러 몇 번, 무음 몇 초, 어떤 제스처 등)를
   함께 적으세요. 시각 없이 일반론만 쓰지 마세요. 특정 시각이 없는 내용(예: 내용 구성)은
   이 구간의 time_label 을 근거로 쓰세요. 시각은 계산하거나 바꾸지 말고 time_label 을 그대로 옮기세요.
   "12.48초"처럼 초 단위 숫자로 쓰지 말고 반드시 "0:12~0:16"처럼 M:SS 로 쓰고,
   시각이나 용어를 따옴표·백틱(`)으로 감싸지 마세요. time_label 이 하나의 시각이면
   (예: 2:22) "2:22~2:22"로 늘리지 말고 그대로 쓰세요.
3. 수치를 나열하지 말고 **그 장면이 왜 잘한 점/개선점인지** 설명하세요.
   예: "0:12~0:16에 4초간 침묵이 있었고 그 직후 필러가 2번 나와 흐름이 끊겼습니다."
4. 영상과 음성의 시간이 겹치는 지점을 찾아 교차 분석하세요.
5. 잘한 점과 개선점은 각각 2~4개로 쓰고, 억지로 채우지 마세요. 정말 없으면 빈 배열로 두세요.
6. 전사문(stt_text)은 음성인식 결과라 고유명사나 단어가 잘못 적혀 있을 수 있습니다.
   철자·단어 오류는 지적하지 말고 말하는 방식과 내용의 흐름만 평가하세요.
7. video_analysis 가 "정보 없음"·"분석 불가"이거나 비어 있으면 자세·시선·제스처는
   추측하지 말고 언급하지 마세요.
8. speaking_rate_spm 은 단어가 아니라 **분당 음절 수(SPM)** 입니다.
   speaking_rate_label(느림/보통/빠름)은 코드가 미리 판정한 값이니 **그대로 따르세요.**
   "보통"이면 발화 속도를 문제로 지적하지 마세요(오히려 적절하다고 평가해도 됩니다).
   "판정되었다"처럼 라벨이 있다는 사실을 언급하지 말고 자연스러운 문장으로 쓰세요.
   silence_ratio 는 구간 시간 중 무음이 차지하는 비율(0~1)입니다.
9. filler_count·repetition_count·silence_ratio·speaking_rate_label·pointing·explanatory_gesture·
   video_analysis·voice_timeline 처럼 **영문 소문자와 _ 로 된 데이터 이름은 하나도 쓰지 마세요.**
   "필러 횟수", "무음 비율", "발화 속도", "가리키기 제스처", "영상 분석 결과"처럼 발표자가 읽는 말로 쓰세요.

## 출력 형식 (JSON, 다른 텍스트 없이)
{{
  "strengths": ["근거 시각(time_label)을 포함한 잘한 점", "..."],
  "improvements": ["근거 시각(time_label)을 포함한 개선점과 제안", "..."]
}}

## outline (발표 전체 구간 목록)
{outline}

## segment (분석할 구간)
{segment}

## video_analysis (이 구간과 겹치는 영상 조각)
{video_analysis}

## voice_timeline (이 구간에서 시작한 무음·필러·반복)
{voice_timeline}
"""

# 한국어 발표의 일반적인 속도는 300~400 SPM (voice/analyze.py 주석 기준).
# LLM 에게 기준을 글로 알려줘도 350 SPM 을 "매우 빠름"이라 평가해서, 판정은 코드가 하고
# 결과 라벨만 넘긴다.
SPM_SLOW = 250
SPM_FAST = 450


def _speaking_rate_label(spm: float | None) -> str | None:
    if spm is None:
        return None
    if spm < SPM_SLOW:
        return "느림"
    if spm > SPM_FAST:
        return "빠름"
    return "보통"


SEGMENT_MAX_WORKERS = 4   # 동시 호출 상한 — 많이 열면 SSL 연결이 끊긴 적이 있음(STEP2)


def _overlaps(a0: float, a1: float, b0: float, b1: float) -> bool:
    return min(a1, b1) > max(a0, b0)


def _slice_for_segment(seg: dict, video_analysis: list[dict], voice_timeline: dict) -> tuple[list, dict]:
    """구간 하나에 해당하는 영상 조각·음성 이벤트만 잘라낸다 (STEP4 집계와 같은 기준)."""
    t0, t1 = seg["t_start"], seg["t_end"]
    videos = [v for v in video_analysis if _overlaps(t0, t1, v["t_start"], v["t_end"])]
    voice = {
        key: [x for x in (voice_timeline.get(key) or []) if t0 <= x["t_start"] < t1]
        for key in ("silence_segments", "filler_words", "repetitions")
    }
    return videos, voice


def _ensure_timestamps(fb: dict, seg_time_label: str) -> dict:
    """시각(M:SS)이 없는 항목 앞에 이 구간의 시각 범위를 붙인다.

    "반복이 없었다", "구성이 명확하다"처럼 특정 시각이 없는 문장은 지침을 줘도 Gemini 가
    시각을 빼먹는다 (29개 중 2개). 항상 시각 근거가 있게 하려고 코드가 보장한다.
    """
    for key in ("strengths", "improvements"):
        items = fb.get(key)
        if isinstance(items, list):
            fb[key] = [t if _TIME_RE.search(t) else f"{seg_time_label} 구간 전체: {t}"
                       for t in items if isinstance(t, str)]
    return fb


def _run_one_segment(client, types, seg: dict, outline: list[dict],
                     video_analysis: list[dict], voice_timeline: dict) -> dict:
    videos, voice = _slice_for_segment(seg, video_analysis, voice_timeline)
    seg_view = {**{k: v for k, v in seg.items() if k != "segment_id"},
                "speaking_rate_label": _speaking_rate_label(seg.get("speaking_rate_spm"))}
    labeled = {"outline": _add_time_labels(outline), "segment": _add_time_labels(seg_view),
               "video": _add_time_labels(videos), "voice": _add_time_labels(voice)}
    prompt = SEGMENT_PROMPT.format(
        outline=json.dumps(labeled["outline"], ensure_ascii=False, indent=2),
        segment=json.dumps(labeled["segment"], ensure_ascii=False, indent=2),
        video_analysis=json.dumps(labeled["video"], ensure_ascii=False, indent=2),
        voice_timeline=json.dumps(labeled["voice"], ensure_ascii=False, indent=2),
    )

    try:
        fb = _generate_validated(client, types, prompt, _collect_time_tokens(labeled),
                                 f"STEP 5 구간 {seg['segment_id']}")
    except RuntimeError as exc:
        return {"segment_id": seg["segment_id"], "error": str(exc)}
    fb = _ensure_timestamps(fb, labeled["segment"]["time_label"])
    return {"segment_id": seg["segment_id"], "feedback": fb}


def run_segments(segments: list[dict], video_analysis: list[dict],
                 voice_timeline: dict) -> list[dict]:
    """구간마다 Gemini 를 호출해 구간별 피드백을 받는다.

    segments: segment_id / label / title / t_start / t_end / stt_text / 지표 를 가진 dict 목록
    반환: 구간 순서대로 {"segment_id", "feedback"} 또는 {"segment_id", "error"}.
          일부 구간이 실패해도 나머지는 그대로 돌려준다.
    """
    import concurrent.futures

    from google import genai
    from google.genai import types

    from app.core.config import settings

    api_key = settings.gemini_api_key
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY 없음 (.env 확인)")
    client = genai.Client(api_key=api_key)

    outline = [{"label": s["label"], "title": s["title"],
                "t_start": s["t_start"], "t_end": s["t_end"]} for s in segments]

    with concurrent.futures.ThreadPoolExecutor(max_workers=SEGMENT_MAX_WORKERS) as pool:
        futures = [pool.submit(_run_one_segment, client, types, s, outline,
                               video_analysis, voice_timeline) for s in segments]
        results = [f.result() for f in futures]

    ok = sum(1 for r in results if "feedback" in r)
    logger.info("STEP 5 구간별 분석: %d/%d 성공", ok, len(results))
    return results
