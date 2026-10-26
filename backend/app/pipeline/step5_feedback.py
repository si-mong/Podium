"""
Step 5: 구간별 LLM 분석 + 종합 피드백

STEP2(영상)·STEP3(음성 타임라인)·STEP4(구간분리+집계) 결과를 구간마다 GPT 에게 보내
구간별 잘한 점·개선점을 받는다(run_segments). 발표 전체를 한 번에 보는 총평(run_overall)도
따로 제공한다 — 2026-09-20에 한 번 제거했다가 2026-09-22에 "4~5줄 총평" 형태로 다시 추가함.

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

MODEL = "gpt-4.1"
MAX_ATTEMPTS = 3
RETRY_WAIT_SEC = 5


def _make_client():
    """OpenAI 클라이언트를 만든다. 키는 .env 의 OPENAI_API_KEY."""
    from openai import OpenAI

    from app.core.config import settings

    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY 없음 (.env 확인)")
    return OpenAI(api_key=settings.openai_api_key)


def _mmss(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 60}:{sec % 60:02d}"


def _add_time_labels(obj):
    """복사본을 돌려준다. t_start/t_end 가 있는 모든 dict 에 time_label("M:SS~M:SS")을 붙인다.

    데이터의 시각은 12.48 같은 소수 초라, GPT 에게 "M:SS 로 바꿔 쓰라"고 하면 계산을
    틀릴 수 있다. 변환은 코드가 하고 GPT 는 time_label 을 그대로 옮기게 한다.
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
    """GPT 가 써도 되는 시각(M:SS)의 집합.

    두 군데서 모은다: ① 모든 time_label 값 ② gesture_timelines 처럼 "MM:SS" 문자열만
    담긴 리스트의 각 항목. 후자는 time_label 로 안 감싸여 있어서 따로 챙기지 않으면
    GPT 가 그 시각을 인용해도 "데이터에 없는 시각"으로 오판해 지워버린다.
    """
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
                if isinstance(x, str):
                    tokens.update(_TIME_RE.findall(x))
                else:
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


def _generate_validated(client, prompt: str, allowed: set[str], tag: str) -> dict:
    """GPT 를 호출하고, 결과의 **모든 시각이 데이터의 time_label 에 있는 시각인지** 검증한다.

    time_label 을 붙여 보내도 GPT 가 시각을 지어내거나 바꿔 쓸 수 있어서, 결과를 코드가 확인한다.
      1) 데이터에 없는 시각이 있으면 그 시각을 알려주고 다시 요청 (최대 MAX_ATTEMPTS 회)
      2) 그래도 남으면 그 항목·문장을 제거 — 잘못된 시각이 사용자에게 나가지 않게 한다.
    """
    last_err = None
    last_parsed = None
    hint = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            # response_format=json_object: 답을 JSON 으로만 받는다 (프롬프트에 "JSON" 단어가 있어야 함)
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt + hint}],
                response_format={"type": "json_object"},
                temperature=0.4,
            )
            parsed = json.loads(resp.choices[0].message.content)
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
# **구간 하나씩** GPT 에 맡긴다.
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
# 구간 등급(rating: 잘함/보통/개선필요)은 feedbacks.rating 칸에 저장한다 — 화면의 스티커용.
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
5. 잘한 점은 1~2개, 개선점은 2~3개로 쓰고, 억지로 채우지 마세요. 정말 없으면 빈 배열로 두세요.
   길이는 항목마다 다음을 지키세요 — 잘한 점: 1줄(대략 20~30자) 이내로 간결하게.
   개선점: 1~2줄(한두 문장, 대략 30~60자) 이내로, 무엇이 문제였는지와 어떻게 고치면 좋을지를
   함께 담으세요. 둘 다 화면에 표시되는 UI라 길게 늘어지면 안 됩니다.
   개선점은 이 구간에서 발표 전달력에 가장 큰 영향을 준 것부터 중요도 순으로 고르고,
   사소한 것(필러 1회 등)은 더 큰 문제가 있으면 빼세요. 시간 순서가 아니라 중요도 순으로 나열하세요.
6. 전사문(stt_text)은 음성인식 결과라 고유명사나 단어가 잘못 적혀 있을 수 있습니다.
   철자·단어 오류는 지적하지 말고 말하는 방식과 내용의 흐름만 평가하세요.
7. video_analysis 가 "정보 없음"·"분석 불가"이거나 비어 있으면 자세·시선·제스처는
   추측하지 말고 언급하지 마세요.
8. video_analysis 의 notes 는 그 영상 조각을 실제로 보고 자세·동작·시선처리를 서술한
   글입니다. gesture_counts(횟수)만 보지 말고 **notes 의 내용을 근거로 적극 활용**하세요 —
   숫자보다 notes 가 "왜 그런지"에 대한 진짜 근거입니다. gesture_timelines 는 각 제스처가
   발생한 시각(예: "0:14") 배열이니, 특정 제스처를 언급할 때는 gesture_counts 의 총 횟수만
   나열하지 말고 gesture_timelines 에서 그 시각을 하나 골라 함께 쓰세요
   (예: "0:14에 나온 산만한 제스처를 포함해 이 구간에서 3번 있었습니다"). gesture_timelines
   의 시각도 다른 time_label 과 동일하게, 데이터에 있는 그대로만 쓰고 지어내지 마세요.
9. speaking_rate_spm 은 단어가 아니라 **분당 음절 수(SPM)** 입니다.
   speaking_rate_label(느림/보통/빠름)은 코드가 미리 판정한 값이니 **그대로 따르세요.**
   "보통"이면 발화 속도를 문제로 지적하지 마세요(오히려 적절하다고 평가해도 됩니다).
   "판정되었다"처럼 라벨이 있다는 사실을 언급하지 말고 자연스러운 문장으로 쓰세요.
   silence_ratio 는 구간 시간 중 무음이 차지하는 비율(0~1)입니다.
10. filler_count·repetition_count·silence_ratio·speaking_rate_label·pointing·explanatory_gesture·
    video_analysis·voice_timeline 처럼 **영문 소문자와 _ 로 된 데이터 이름은 하나도 쓰지 마세요.**
    "필러 횟수", "무음 비율", "발화 속도", "가리키기 제스처", "영상 분석 결과"처럼 발표자가 읽는 말로 쓰세요.
11. 이 구간의 전체 등급(rating)을 "잘함", "보통", "개선필요" 중 **하나만** 고르세요.
    화면에 스티커로 표시되어 발표자가 구간을 한눈에 비교하는 용도입니다.
    - 잘함: 개선점이 없거나 사소한 것(필러 1~2회 등)뿐이고, 전달에 방해가 없었다.
    - 보통: 전달은 되었지만 고치면 좋아질 문제가 한두 개 있었다.
    - 개선필요: 긴 침묵, 연속된 필러·반복, 산만한 동작처럼 흐름이 끊길 정도의 문제가 있었다.
    잘한 점·개선점 내용과 등급이 서로 맞게 고르세요(개선점이 크면 "잘함"을 주지 마세요).
12. 느낌·감상 표현을 쓰지 마세요 (신뢰감, 인상적, 듣기 편한, 생동감, 자연스러운, 적극적인 등).
    대신 관찰된 사실(언제·몇 번·몇 초)과, 개선점이라면 다음 발표에서 할 **구체적인 행동**을 쓰세요.
    나쁜 예: "자연스러운 손짓을 더해 전달력을 높이세요."
    좋은 예: "1:20~1:45에 설명 제스처가 없었습니다. 핵심 단어를 말할 때 손으로 화면을 가리키세요."

## 출력 형식 (JSON, 다른 텍스트 없이)
{{
  "rating": "잘함 / 보통 / 개선필요 중 하나",
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

    "반복이 없었다", "구성이 명확하다"처럼 특정 시각이 없는 문장은 지침을 줘도 GPT 가
    시각을 빼먹는다 (29개 중 2개). 항상 시각 근거가 있게 하려고 코드가 보장한다.
    """
    for key in ("strengths", "improvements"):
        items = fb.get(key)
        if isinstance(items, list):
            fb[key] = [t if _TIME_RE.search(t) else f"{seg_time_label} 구간 전체: {t}"
                       for t in items if isinstance(t, str)]
    return fb


RATINGS = ("잘함", "보통", "개선필요")


def _ensure_rating(fb: dict) -> dict:
    """rating 이 세 값 중 하나가 아니면 "보통"으로 바꾼다.

    GPT 가 "좋음"처럼 다른 말을 쓰거나 빼먹으면 화면에서 스티커 색을 못 고르므로 코드가 보장한다.
    """
    if fb.get("rating") not in RATINGS:
        logger.warning("STEP 5 등급 값이 이상함(%r) → 보통으로 바꿈", fb.get("rating"))
        fb["rating"] = "보통"
    return fb


def _run_one_segment(client, seg: dict, outline: list[dict],
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
        fb = _generate_validated(client, prompt, _collect_time_tokens(labeled),
                                 f"STEP 5 구간 {seg['segment_id']}")
    except RuntimeError as exc:
        return {"segment_id": seg["segment_id"], "error": str(exc)}
    fb = _ensure_timestamps(fb, labeled["segment"]["time_label"])
    fb = _ensure_rating(fb)
    return {"segment_id": seg["segment_id"], "feedback": fb}


def run_segments(segments: list[dict], video_analysis: list[dict],
                 voice_timeline: dict) -> list[dict]:
    """구간마다 GPT 를 호출해 구간별 피드백을 받는다.

    segments: segment_id / label / title / t_start / t_end / stt_text / 지표 를 가진 dict 목록
    반환: 구간 순서대로 {"segment_id", "feedback"} 또는 {"segment_id", "error"}.
          일부 구간이 실패해도 나머지는 그대로 돌려준다.
    """
    import concurrent.futures

    client = _make_client()

    outline = [{"label": s["label"], "title": s["title"],
                "t_start": s["t_start"], "t_end": s["t_end"]} for s in segments]

    with concurrent.futures.ThreadPoolExecutor(max_workers=SEGMENT_MAX_WORKERS) as pool:
        futures = [pool.submit(_run_one_segment, client, s, outline,
                               video_analysis, voice_timeline) for s in segments]
        results = [f.result() for f in futures]

    ok = sum(1 for r in results if "feedback" in r)
    logger.info("STEP 5 구간별 분석: %d/%d 성공", ok, len(results))
    return results


# ═══════════════════════════════════════════════════════════════════════════
# 종합 피드백 (발표 전체 총평)
#
# 구간별 분석과 달리 GPT 를 **한 번만** 호출해서 발표 전체를 요약한다.
# 2026-10-18: 긴 문단은 한눈에 안 읽혀서 "핵심 한 줄(headline) + 짧은 부가 설명(overall_summary)"
# 으로 바꿨다. 부가 설명 키 이름은 예전 세션과 맞추려고 overall_summary 그대로 둔다.
# 2026-10-25: 부가 설명을 2~3문장 → 3~4문장으로 늘리고 "말하기 1문장 이상 + 몸짓 1문장 이상"을 강제했다.
# 10-18 이후 총평이 전부 시선·제스처 얘기만 하고 필러가 29회인 세션(#107)에서도 말하기를 안 짚었기 때문.
# (고칠 점 자리가 하나뿐인데 motion_notes 는 글이라 눈에 띄고, 말하기 지표는 숫자라 밀렸다)
# 단, 말하기에 문제가 없으면 억지로 지적하지 않고 잘한 점으로 쓰게 했다(#104 에서 무음을 억지로 지적함).
# "문제가 있는지"는 LLM 이 아니라 코드가 기준으로 판정해서 speech_issues 로 보낸다(_speech_issues).
# 발화 속도는 구간별 피드백과 같은 느림/보통/빠름 라벨을 같이 보낸다.
# 구간별처럼 항목마다 시각을 강제하지 않는다 — 총평은 짧아야 해서 문장마다
# 시각을 넣으면 오히려 읽기 어려워진다. 다만 시각을 언급하는 경우엔 구간별과 같은 검증
# (_generate_validated) 을 거쳐 데이터에 없는 시각을 지어내지 못하게 막는다.
# ═══════════════════════════════════════════════════════════════════════════

OVERALL_PROMPT = """당신은 발표 코칭 전문가입니다.
아래는 발표 전체를 구간별로 나눠 분석한 데이터입니다. 발표 전체를 한 번에 보고 총평을 작성하세요.

## 지침
1. outline(구간별 라벨·제목·시각)과 segments(구간별 전사문·지표)를 종합해서 발표 전체의
   흐름과 특징을 파악하세요. 특정 구간 하나만 보지 말고 전체를 아우르세요.
2. 총평은 **말하기와 몸짓을 둘 다** 다뤄야 합니다. 한쪽만 쓰지 마세요.
   - 말하기: segments 의 발화 속도·필러 횟수·무음 비율·반복 횟수와 전사문. 구간끼리 비교해서
     눈에 띄게 많거나 빠른/느린 구간이 있으면 그 구간과 숫자를 짚으세요.
     발화 속도가 빠른지 느린지는 speaking_rate_label(느림/보통/빠름)을 **그대로 따르세요** — 코드가 미리 판정한
     값입니다. "보통"이면 발화 속도를 문제로 지적하지 마세요. 숫자를 쓸 때는 "spm" 대신
     "분당 ○○음절"처럼 쓰세요.
   - 몸짓: segments 의 motion_notes 는 그 구간 영상을 실제로 보고 자세·동작·시선처리를 서술한
     글입니다(구간마다 있음). 구간마다 반복되거나 눈에 띄는 동작·시선 습관을 짚으세요.
     gesture_timelines 는 그 습관이 발생한 시각(예: "0:14") 배열이니, 특정 동작을 짚고
     싶으면 대표로 한 시각을 골라 함께 써도 됩니다(지침 5의 시각 규칙을 그대로 따르세요).
   motion_notes 는 글로 길게 적혀 있고 말하기 지표는 숫자라서 몸짓 쪽으로 치우치기 쉬우니,
   말하기 숫자도 똑같이 꼼꼼히 보세요.
3. 결과는 **핵심 한 줄(headline)** 과 **부가 설명(overall_summary)** 두 부분으로 나눠 쓰세요.
   - headline: 발표 전체에서 가장 잘한 점 하나와 가장 고칠 점 하나를 묶은 한 문장
     (약 20~35자, 시각 없이). 예: "말 속도는 안정적이지만, 손 제스처와 시선 처리를 고쳐봐요"
     잘한 점과 고칠 점은 **서로 다른 항목**이어야 합니다. 같은 항목(예: 시선)을 앞에서
     칭찬하고 뒤에서 고치라고 쓰지 마세요.
     나쁜 예: "자세와 시선은 안정적이지만, 손 제스처와 시선 분배를 개선하세요"
   - overall_summary: headline 의 근거와 고치는 방법을 담은 **문단** (목록이 아니라
     이어지는 글, 3~4문장, 약 150~250자). 잘한 점의 근거 1개, 고칠 점마다 근거와 구체적인 행동을 쓰세요.
     이 문단에는 **말하기(발화 속도·필러·무음·반복)에 대한 문장 1개 이상**과
     **몸짓(자세·제스처·시선)에 대한 문장 1개 이상**이 반드시 들어가야 합니다(지침 2).
     headline 에 한쪽만 들어갔다면 다른 쪽을 이 문단에서 다루세요.
     **4문장을 넘기지 마세요.** 말하기와 몸짓의 고치는 행동은 한 문장에 묶어도 됩니다.
     고치는 행동에는 **말하기 행동 1개와 몸짓 행동 1개가 모두** 들어가야 합니다.
     말하기를 고칠 점으로 쓸지는 segments 의 speech_issues 로 정하세요. speech_issues 는 코드가 기준
     (필러 2회 이상, 반복 2회 이상, 무음 30% 이상)으로 미리 골라 둔 그 구간의 말하기 문제입니다.
     - 어느 한 구간이라도 speech_issues 가 있으면: 말하기를 **반드시 고칠 점으로** 쓰고 말하기 행동을 넣으세요.
       "과도하지 않다", "비교적 안정적"처럼 넘기지 마세요. speech_issues 가 있는 구간과 그 숫자를 짚으세요.
     - 모든 구간의 speech_issues 가 비어 있으면: 말하기는 **잘한 점으로** 쓰고, 고치는 행동은 몸짓만 써도 됩니다.
       문제가 없는 항목을 억지로 지적하지 마세요.
     headline 에서 칭찬한 항목을 부가 설명에서 다시 지적하지 마세요(지침 3의 "서로 다른 항목").
     말하기 행동은 아래처럼 "무엇을 줄이려고 + 어떻게 연습할지"를 구체적으로 쓰세요.
     예: "핵심 문장마다 미리 끊어 읽고, 불필요한 '이제' 같은 필러를 줄이기 위해 문장 끝에서 잠시 멈추는 연습을 하세요."
     이 예시를 그대로 베끼지 말고 이 발표에 맞게 쓰세요. 필러 단어를 예로 들 때는 segments 의
     filler_words(그 구간에서 실제로 필러로 잡힌 단어와 횟수)에 있는 단어만 쓰세요. 전사문에 있어도
     filler_words 에 없는 단어('그리고' 같은 접속사 등)는 필러가 아닙니다. 예시의 '이제'도 filler_words 에
     없으면 쓰지 마세요. filler_words 가 비어 있으면 단어를 들지 말고 "필러"라고만 쓰세요.
     몸짓 행동도 이 발표의 motion_notes 에 적힌 **구체적인 장면**(어느 구간에서, 무엇을 설명할 때
     시선이 내려갔는지·손이 멈췄는지 등)을 근거로 쓰세요. "대본을 외워 핵심 문장마다 카메라를 바라보세요"처럼
     어느 발표에나 쓸 수 있는 일반적인 조언만 쓰지 마세요.
     무음 비율(silence_ratio)은 데이터에 이미 "30%"처럼 % 로 들어 있으니 그 값을 그대로 쓰세요.
     speech_issues·speaking_rate_label 은 코드가 미리 판정한 값입니다. "기준 이하", "기준을 넘었다", "판정"처럼
     기준이나 판정이 있다는 사실을 문장에 쓰지 마세요. 라벨 단어도 "느림으로"처럼 그대로 붙이지 말고
     "느린 편", "보통 속도"처럼 자연스럽게 풀어 쓰세요.
4. 느낌·감상 표현을 쓰지 마세요 (신뢰감, 인상적, 듣기 편한, 생동감, 자연스러운, 적극적인 등).
   대신 관찰된 사실(어느 구간·몇 번·몇 초)과 다음 발표에서 할 **구체적인 행동**을 쓰세요.
   "대부분의 구간", "후반부"처럼 흐리게 쓰지 말고 구간 라벨이나 시각으로 짚으세요.
   나쁜 예: "자연스러운 손짓을 더해 전달력을 높이면 더욱 생동감 있는 발표가 될 것입니다."
   좋은 예: "본론(1:20~3:40)에서 설명 제스처가 0번이었으니, 핵심 단어를 말할 때 손으로 화면을 가리키세요."
5. 시각을 언급해도 되지만 강제는 아닙니다. 언급할 경우 반드시 데이터의 time_label 이나
   gesture_timelines 의 값을 "0:12~0:16" 또는 "0:14"처럼 그대로 쓰고, 계산하거나 지어내지 마세요.
6. filler_count·silence_ratio·speaking_rate_label 같은 영문 소문자와 _ 로 된 데이터
   이름은 하나도 쓰지 말고, "필러 횟수", "무음 비율", "발화 속도"처럼 발표자가 읽는
   말로 쓰세요.
7. 전사문(stt_text)은 음성인식 결과라 고유명사나 단어가 잘못 적혀 있을 수 있습니다.
   철자·단어 오류는 지적하지 말고 말하는 방식과 내용의 흐름만 평가하세요.

## 출력 형식 (JSON, 다른 텍스트 없이)
{{
  "headline": "핵심 한 줄",
  "overall_summary": "3~4문장의 부가 설명 문단 — 4문장을 넘기지 말 것 (말하기 1문장 이상 + 몸짓 1문장 이상)"
}}

## outline (발표 전체 구간 목록)
{outline}

## segments (구간별 전사문·지표)
{segments}
"""


# 종합 피드백에서 "말하기 고칠 점"이 있는지 코드가 판정하는 기준 (구간 하나라도 넘으면 있음).
# LLM 에게 "뚜렷한 문제가 없으면 칭찬하라"고만 하면 필러 15회도 "과도하지 않다"고 넘겼다(#105).
# 발화 속도는 넣지 않는다 — 지금 기준(250 SPM 미만 = 느림)이면 거의 모든 발표가 느림이 된다.
SPEECH_FILLER_MIN = 2       # 필러 횟수
SPEECH_REPEAT_MIN = 2       # 반복(말더듬) 횟수
SPEECH_SILENCE_MIN = 0.30   # 무음 비율


def _speech_issues(seg: dict) -> list[str]:
    """구간 하나에서 기준을 넘은 말하기 문제를 "필러 5회"처럼 사람이 읽는 글로 돌려준다. 없으면 []."""
    issues = []
    if (seg.get("filler_count") or 0) >= SPEECH_FILLER_MIN:
        issues.append(f"필러 {seg['filler_count']}회")
    if (seg.get("repetition_count") or 0) >= SPEECH_REPEAT_MIN:
        issues.append(f"반복 {seg['repetition_count']}회")
    if (seg.get("silence_ratio") or 0) >= SPEECH_SILENCE_MIN:
        issues.append(f"무음 {_to_percent(seg['silence_ratio'])}")
    return issues


# 음성인식 모델이 군소리를 표시하는 태그 → 사람이 읽는 소리 (voice/filler.py 의 MODEL_FILLER_TAGS)
_FILLER_TAG_SOUND = {"<ah>": "아", "<uh>": "어", "<um>": "음", "<gue>": "그",
                     "<jeo>": "저", "<mwo>": "뭐", "<mak>": "막"}


def _filler_words(seg: dict, voice_timeline: dict) -> list[str]:
    """그 구간에서 실제로 필러로 잡힌 단어를 많은 순으로 ["어 9회", "이제 6회"] 처럼 돌려준다.

    전사문만 보고 고르게 하면 '그리고' 같은 접속사를 필러라고 불렀다(#106) → 실제 목록을 준다.
    모델 태그(<uh> 등)는 전사문에 글자로 안 남으니 "어" 같은 소리로 바꾼다. 알 수 없는 것(?)은 뺀다.
    """
    counts: dict[str, int] = {}
    for f in voice_timeline.get("filler_words") or []:
        if not (seg["t_start"] <= f["t_start"] < seg["t_end"]):
            continue
        word = _FILLER_TAG_SOUND.get(f.get("text") or "", f.get("text") or "")
        if not word or word.startswith("<") or word == "?":
            continue
        counts[word] = counts.get(word, 0) + 1
    return [f"{w} {n}회" for w, n in sorted(counts.items(), key=lambda x: -x[1])]


def _to_percent(ratio):
    """0~1 비율 → "30%" 글자. 값이 없으면 그대로 둔다."""
    return f"{round(ratio * 100)}%" if isinstance(ratio, (int, float)) else ratio


def run_overall(segments: list[dict], video_analysis: list[dict], voice_timeline: dict) -> dict:
    """발표 전체를 한 번 호출해서 핵심 한 줄(headline)과 부가 설명(overall_summary)을 받는다.

    segments: run_segments 와 같은 입력(segment_id 포함, 구간 순서). video_analysis·voice_timeline 은
    인자로는 받지만 이번엔 프롬프트에 넣지 않는다 — 총평은 구간별 지표(segments 안에 이미 집계돼
    있음)만으로 충분하고, 원본 이벤트까지 다 보내면 총평치고 너무 장황해진다.
    반환: {"headline": "...", "overall_summary": "..."}
    """
    client = _make_client()

    outline = [{"label": s["label"], "title": s["title"],
                "t_start": s["t_start"], "t_end": s["t_end"]} for s in segments]
    # 숫자는 LLM 이 그대로 옮겨 쓸 수 있는 모양으로 바꿔서 보낸다.
    #   무음 비율: 0~1 소수 → "30%" (소수로 보내면 %로 바꾸며 끝자리를 틀렸다: 0.296 → "29%")
    #   발화 속도: 소수 → 정수 (171.9 를 "171"로 버림해서 썼다) + 구간별 피드백과 같은
    #   느림/보통/빠름 라벨 (라벨 없이 숫자만 주면 144~211 을 "일정하다"고 판단했다)
    segs_view = []
    for s in segments:
        view = {k: (_to_percent(v) if k == "silence_ratio" else v) for k, v in s.items() if k != "segment_id"}
        spm = s.get("speaking_rate_spm")
        if isinstance(spm, (int, float)):
            view["speaking_rate_spm"] = round(spm)
        view["speaking_rate_label"] = _speaking_rate_label(spm)
        view["speech_issues"] = _speech_issues(s)   # 원래 숫자(소수 무음 비율)로 판정
        view["filler_words"] = _filler_words(s, voice_timeline)
        segs_view.append(view)
    labeled = {"outline": _add_time_labels(outline), "segments": _add_time_labels(segs_view)}

    prompt = OVERALL_PROMPT.format(
        outline=json.dumps(labeled["outline"], ensure_ascii=False, indent=2),
        segments=json.dumps(labeled["segments"], ensure_ascii=False, indent=2),
    )

    return _generate_validated(client, prompt, _collect_time_tokens(labeled), "STEP 5 종합")
