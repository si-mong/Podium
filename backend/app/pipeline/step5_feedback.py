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
#   - speech_issues·motion_issues·filler_words : 종합 피드백과 같은 코드 판정값
# 결과(strengths / improvements 목록)는 feedbacks 테이블의 같은 이름 JSONB 칸에 저장한다.
# 구간 등급(rating: 잘함/보통/개선필요)은 feedbacks.rating 칸에 저장한다 — 화면의 스티커용.
# 2026-11-08: 종합 피드백과 같은 판정값(speech_issues·motion_issues·filler_words)을 넘기고
#   "개선점은 판정값에 있는 것만" 쓰게 했다. 그전엔 LLM 이 원본을 보고 문제를 따로 찾아서
#   종합 피드백과 말이 엇갈렸다(구간 카드에서만 "설명 제스처를 늘리세요" 등).
#   등급도 LLM 이 아니라 코드가 판정 개수로 매긴다(_segment_rating) — LLM 등급은 15구간 중 13개가
#   "개선필요"일 만큼 엄격했고, 종합 피드백의 headline 비중(_headline_mode)이 이 등급을 쓴다.
# ═══════════════════════════════════════════════════════════════════════════

SEGMENT_PROMPT = """당신은 발표 코칭 전문가입니다.
아래는 발표 전체 중 **한 구간**을 분석한 데이터입니다. 이 구간의 **잘한 점**과 **개선점**을 작성하세요.
outline 은 발표 전체 흐름 속에서 이 구간이 어디쯤인지 파악하는 참고용입니다.

## 0. 코드가 미리 판정한 값 — 가장 먼저 보세요
- speech_issues (이 구간의 말하기 문제, 비어 있으면 없음): {speech_issues}
- motion_issues (이 구간의 몸짓 문제, 비어 있으면 없음): {motion_issues}
- minor_motion_issues (이 구간의 가벼운 몸짓 문제, 비어 있으면 없음): {minor_motion_issues}
  — 설명 제스처를 더 많이 쓴 발표라 얼굴 만지기 같은 동작을 가볍게 보는 항목입니다.
- filler_words (이 구간에서 실제로 필러로 잡힌 단어와 횟수, 비어 있으면 없음): {filler_words}
- segment 의 speaking_rate_label: 발화 속도 (느림 / 보통 / 빠름)
**개선점은 speech_issues·motion_issues·minor_motion_issues 에 있는 것만 쓰세요.** 데이터의 다른 숫자나 notes 를 보고
따로 문제를 찾아내지 마세요. video_analysis·voice_timeline 은 판정값의 근거(시각·장면)를 찾을 때 쓰세요.

## 1. 무엇을 쓸지
개선점
- speech_issues·motion_issues·minor_motion_issues 에 있는 항목만, 0~3개 쓰세요. 셋 다 비어 있으면 개선점은 빈 배열로 두세요.
- 항목이 3개보다 많으면 발표 전달력에 영향이 큰 것부터 3개만, 중요도 순으로 쓰세요(시간 순서 아님).
  비슷한 항목(예: "얼굴·머리 만지기"와 "물건 만지작거리기")은 하나로 묶어도 됩니다.
- minor_motion_issues 의 항목은 개선점의 **맨 뒤**에 짧게 쓰세요.
- 판정값에 없는 것(speech_issues 에 없는 필러 2회, notes 에 한 번 적힌 손동작 등)은 개선점으로 쓰지 마세요.
잘한 점
- 1~2개. 판정값에 문제가 없는 쪽(말하기 또는 몸짓)에서 데이터로 확인되는 것을 쓰세요.
  억지로 채우지 말고, 정말 없으면 빈 배열로 두세요.
- 발화 속도는 speaking_rate_label 을 그대로 따르세요. "보통"이면 문제로 쓰지 말고, 잘한 점으로 써도 됩니다.
설명 제스처
- 설명 제스처(손으로 설명하기·가리키기)의 많고 적음은 사람마다 다른 발표 스타일입니다.
  많으면 잘한 점으로 쓸 수 있지만, 적거나 없다는 이유로 개선점에 쓰지 마세요
  ("제스처를 추가하세요", "손으로 화면을 가리키세요" 같은 조언 금지).
  notes 에 "제스처가 거의 없다"고 적혀 있어도 개선점이 아닙니다.

## 2. 근거와 시각
- **모든 항목에는 근거가 된 시각을 넣으세요.** 데이터의 time_label(예: 3:45~3:52)을 문장 안에 그대로 쓰고,
  그 시각에 무슨 일이 있었는지(필러 몇 번, 무음 몇 초, 어떤 동작 등)를 함께 적으세요.
  특정 시각이 없는 내용은 이 구간의 time_label 을 근거로 쓰세요.
  시각은 계산하거나 바꾸지 말고 time_label 을 그대로 옮기세요. "12.48초"처럼 초 단위 숫자로 쓰지 말고
  반드시 "0:12~0:16"처럼 M:SS 로 쓰고, 시각이나 용어를 따옴표·백틱(`)으로 감싸지 마세요.
  time_label 이 하나의 시각이면(예: 2:22) "2:22~2:22"로 늘리지 말고 그대로 쓰세요.
- 수치를 나열하지 말고 **그 장면이 왜 잘한 점/개선점인지** 설명하세요.
  예: "0:12~0:16에 4초간 침묵이 있었고 그 직후 필러가 2번 나와 흐름이 끊겼습니다."
- 영상과 음성의 시간이 겹치는 지점을 찾아 교차 분석하세요.
- video_analysis 의 notes 는 그 영상 조각을 실제로 보고 쓴 글입니다. 판정값의 **장면 근거**
  (그때 무엇을 하고 있었는지, 예: 대본을 내려다보며 말함)로 쓰세요.
  gesture_timelines 는 각 동작이 발생한 시각(예: "0:14") 배열이니, 동작을 짚을 때는 횟수만 쓰지 말고
  그 시각을 하나 골라 함께 쓰세요(예: "0:14에 얼굴을 만지는 동작을 포함해 이 구간에서 3번 있었습니다").
  gesture_timelines 의 시각도 데이터에 있는 그대로만 쓰고 지어내지 마세요.
- video_analysis 가 "정보 없음"·"분석 불가"이거나 비어 있으면 자세·시선·제스처는 추측하지 말고 언급하지 마세요.

## 3. 길이 (화면에 카드로 표시됩니다)
- 잘한 점: 항목마다 1줄(대략 20~30자) 이내로 간결하게.
- 개선점: 항목마다 1~2줄(한두 문장, 대략 30~60자) 이내로, 무엇이 문제였는지와 어떻게 고치면 좋을지를 함께.
  고치는 행동은 구체적으로 쓰세요.
  좋은 예: "0:12~0:20에 얼굴을 2번 만졌으니, 말하는 동안 손을 허리 높이에 모아 두세요."

## 4. 표현 규칙
- 판정이 있다는 사실을 쓰지 마세요: "기준 이하", "기준을 넘었다", "판정되었다", "가벼운 문제" 같은 표현 금지.
  라벨 단어도 "느림으로"처럼 그대로 붙이지 말고 "느린 편", "보통 속도"처럼 풀어 쓰세요.
- 느낌·감상 표현을 쓰지 마세요: 신뢰감, 인상적, 듣기 편한, 생동감, 자연스러운, 적극적인, 긍정적 등.
  대신 관찰된 사실(언제·몇 번·몇 초)과 행동을 쓰세요.
  나쁜 예: "자연스러운 손짓을 더해 전달력을 높이세요."
- filler_count·repetition_count·silence_ratio·speaking_rate_label·speech_issues·motion_issues·minor_motion_issues·filler_words·
  pointing·explanatory_gesture·video_analysis·voice_timeline 처럼 **영문 소문자와 _ 로 된 데이터 이름은
  하나도 쓰지 마세요.** "필러 횟수", "무음 비율", "발화 속도", "가리키기 제스처", "영상 분석 결과"처럼
  발표자가 읽는 말로 쓰세요.
- 숫자는 데이터 값 그대로: 발화 속도(speaking_rate_spm, 분당 음절 수)는 "spm" 대신 "분당 ○○음절".
  무음은 "몇 초 멈춘 곳이 몇 번"으로 쓰세요(예: "3초 이상 멈춘 곳이 2번, 가장 긴 것은 5.7초", "6.7초 멈춘 곳이 1번"). 무음 비율(%)은 쓰지 않아도 됩니다.
- 필러 단어를 예로 들 때는 filler_words 에 있는 단어만 쓰세요. voice_timeline 의 "<uh>" 같은 기호나,
  전사문에만 있는 '그리고' 같은 접속사는 필러 단어로 쓰지 마세요. filler_words 가 비어 있으면
  단어를 들지 말고 "필러"라고만 쓰세요.
- 전사문(stt_text)은 음성인식 결과라 단어가 잘못 적혀 있을 수 있습니다. 철자·단어 오류는 지적하지 마세요.

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


def _segment_rating(issue_count: int) -> str:
    """구간 등급 = 코드 판정 문제 개수(speech_issues + motion_issues + minor_motion_issues).
    가벼운 고칠 점도 1개로 센다 — 빼면 "문제 0개 = 잘함" 규칙에 예외가 생긴다.

    0개 = 잘함, 1~2개 = 보통, 3개 이상 = 개선필요.
    """
    if issue_count == 0:
        return "잘함"
    if issue_count <= 2:
        return "보통"
    return "개선필요"


def _run_one_segment(client, seg: dict, outline: list[dict],
                     video_analysis: list[dict], voice_timeline: dict,
                     speech_issues: list[str], motion_issues: list[str],
                     minor_motion_issues: list[str]) -> dict:
    videos, voice = _slice_for_segment(seg, video_analysis, voice_timeline)
    # 무음 비율은 종합 피드백처럼 "30%" 글자로 바꿔서 보낸다
    seg_view = {**{k: (_to_percent(v) if k == "silence_ratio" else v)
                   for k, v in seg.items() if k != "segment_id"},
                "speaking_rate_label": _speaking_rate_label(seg.get("speaking_rate_spm"))}
    labeled = {"outline": _add_time_labels(outline), "segment": _add_time_labels(seg_view),
               "video": _add_time_labels(videos), "voice": _add_time_labels(voice)}
    prompt = SEGMENT_PROMPT.format(
        outline=json.dumps(labeled["outline"], ensure_ascii=False, indent=2),
        segment=json.dumps(labeled["segment"], ensure_ascii=False, indent=2),
        video_analysis=json.dumps(labeled["video"], ensure_ascii=False, indent=2),
        voice_timeline=json.dumps(labeled["voice"], ensure_ascii=False, indent=2),
        speech_issues=json.dumps(speech_issues, ensure_ascii=False),
        motion_issues=json.dumps(motion_issues, ensure_ascii=False),
        minor_motion_issues=json.dumps(minor_motion_issues, ensure_ascii=False),
        filler_words=json.dumps(_filler_words(seg, voice_timeline), ensure_ascii=False),
    )

    try:
        fb = _generate_validated(client, prompt, _collect_time_tokens(labeled),
                                 f"STEP 5 구간 {seg['segment_id']}")
    except RuntimeError as exc:
        return {"segment_id": seg["segment_id"], "error": str(exc)}
    fb = _ensure_timestamps(fb, labeled["segment"]["time_label"])
    issue_count = len(speech_issues) + len(motion_issues) + len(minor_motion_issues)
    # 판정값이 모두 비었는데 LLM 이 개선점을 쓰면("필러 한 번" 등, #91) 등급 "잘함"과 안 맞으므로 코드가 비운다
    if issue_count == 0 and fb.get("improvements"):
        logger.info("STEP 5 구간 %s: 판정값이 없는데 나온 개선점 %d개를 뺌", seg["segment_id"], len(fb["improvements"]))
        fb["improvements"] = []
    fb["rating"] = _segment_rating(issue_count)
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

    # 판정값은 종합 피드백과 같은 함수로 만든다
    motion_issues = _all_motion_issues(segments, video_analysis)

    with concurrent.futures.ThreadPoolExecutor(max_workers=SEGMENT_MAX_WORKERS) as pool:
        futures = [pool.submit(_run_one_segment, client, s, outline, video_analysis, voice_timeline,
                               _speech_issues(s) + _segment_silence_issues(s, voice_timeline), mi, minor)
                   for s, (mi, minor) in zip(segments, motion_issues)]
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
# 2026-11-06: "고치는 행동에 말하기 1개 + 몸짓 1개 모두" 규칙을 지웠다. speech_issues 가 비어 있어도
# 말하기 행동을 하나 넣으려고 반복 2회(기준 미만)를 억지로 지적했기 때문.
# 또 설명 제스처가 적다고 "손으로 화면을 가리키는 동작을 추가하세요"라고 썼다(프롬프트 예시를 베낌).
# 설명 제스처의 많고 적음은 사람마다 다른 발표 스타일이라 고칠 점에서 빼고, 예시도 바꿨다.
# 2026-11-06: 습관 필러(habit_fillers)와 headline 비중(headline_mode)을 코드가 판정해서 보낸다.
#   - 일부러 "이제"를 많이 쓴 발표에서도 습관이라고 짚지 않았다 → 발표 전체 필러 단어를 세서 골라 준다.
#   - headline 이 늘 "잘한 점 1 + 고칠 점 1"이라, 구간 등급(잘함/개선필요)이 대부분 한쪽이면 그쪽 위주로 쓴다.
# 2026-11-06: 몸짓 고칠 점도 말하기처럼 코드가 판정해서 motion_issues 로 보낸다(_motion_issues).
#   그전엔 몸짓 기준이 프롬프트 글뿐이라, 같은 #107(얼굴 만지기 2·3·1회)을 짚을 때도 있고 빠뜨릴 때도 있었다.
# 2026-11-06: 프롬프트를 "0. 판정값 → 1. 무엇을 쓸지 → 2. headline → 3. 부가 설명(문장 틀) → 4. 표현 규칙"
#   순서로 다시 정리했다. 규칙을 덧붙이다 보니 지침 3 하나가 53줄이 되고 중복·충돌이 생겨서,
#   headline 에 고칠 점을 2개 쓰거나 부가 설명이 5문장이 되는 일이 잦았다.
#   판정 기준 숫자는 프롬프트에 쓰지 않는다 — LLM 은 판정값만 보면 되고, 숫자를 보여주면 "기준"이란 말을 더 썼다.
# 2026-11-20: 습관 필러가 있으면 headline 의 고칠 점은 무조건 습관 필러(단어 포함)로 쓰게 했다.
#   그전엔 headline 규칙에 habit_fillers 가 없어서, "칭찬 위주"면 아예 빠지고 그 밖에도 몸짓 문제에 자주 밀렸다.
#   "칭찬 위주"여도 이때는 잘한 점 1개 + 습관 필러 1개로 쓴다. 밀려난 고칠 점은 overall_summary 에서 다룬다.
# 2026-11-24: headline 에 쓸 잘한 점·고칠 점을 코드가 골라 headline_good / headline_fix 로 보낸다
#   (_headline_points·_headline_plan). 위 습관 필러 규칙도 프롬프트 글 대신 코드가 지킨다.
#   칭찬해도 되는 항목은 strengths 로 보내고, 부가 설명 ①도 그 안에서만 칭찬하게 했다
#   (예시 "자세는 안정적"을 베껴 구부정한 발표의 자세를 칭찬했다).
# 발화 속도는 구간별 피드백과 같은 느림/보통/빠름 라벨을 같이 보낸다.
# 구간별처럼 항목마다 시각을 강제하지 않는다 — 총평은 짧아야 해서 문장마다
# 시각을 넣으면 오히려 읽기 어려워진다. 다만 시각을 언급하는 경우엔 구간별과 같은 검증
# (_generate_validated) 을 거쳐 데이터에 없는 시각을 지어내지 못하게 막는다.
# ═══════════════════════════════════════════════════════════════════════════

OVERALL_PROMPT = """당신은 발표 코칭 전문가입니다.
아래는 발표 전체를 구간별로 나눠 분석한 데이터입니다. outline(구간별 라벨·제목·시각)과
segments(구간별 전사문·지표)를 종합해서, 특정 구간 하나만 보지 말고 발표 전체를 아우르는 총평을 작성하세요.

## 0. 코드가 미리 판정한 값 — 가장 먼저 보세요
- headline_mode (headline 구성): {headline_mode} — **headline 에만** 적용됩니다. overall_summary 는 1번 규칙대로 씁니다.
- headline_good (headline 에 쓸 잘한 점의 주제, (없음)이면 잘한 점을 쓰지 않음): {headline_good}
- headline_fix (headline 에 쓸 고칠 점의 주제, (없음)이면 고칠 점을 쓰지 않음): {headline_fix}
- strengths (칭찬해도 되는 항목, 쓸 순서대로): {strengths}
- habit_fillers (발표 전체에서 말버릇처럼 반복된 필러 단어, 비어 있으면 없음): {habit_fillers}
- talk_silence (발표 전체에서 오래 멈춘 곳이 잦은지, 비어 있으면 문제 없음): {talk_silence}
- segments 의 구간마다 들어 있는 판정값:
  - speech_issues: 그 구간의 필러·반복 문제 (예: "필러 5회", "반복 3회")
  - motion_issues: 그 구간의 몸짓 문제 (예: "얼굴·머리 만지기 2회", "시선 드묾(청중·카메라를 거의 보지 않음)")
  - minor_motion_issues: 그 구간의 가벼운 몸짓 문제 (예: "얼굴·머리 만지기 2회") — 설명 제스처를 더 많이 쓴
    발표라 얼굴 만지기 같은 동작을 가볍게 보는 항목
  - speaking_rate_label: 발화 속도 (느림 / 보통 / 빠름)
**무엇을 칭찬하고 무엇을 고칠지는 이 판정값으로만 정하세요.** 데이터의 다른 숫자나 motion_notes 를 보고
따로 문제를 찾아내지 마세요. 다른 데이터는 판정값의 근거(구간·장면·시각)를 쓸 때만 쓰세요.

## 1. 무엇을 쓸지
말하기
- 고칠 점: 어느 한 구간이라도 speech_issues 가 있거나, habit_fillers 나 talk_silence 가 있을 때.
  - speech_issues 가 있으면 "과도하지 않다", "비교적 안정적"처럼 넘기지 마세요.
  - habit_fillers 가 있으면 그 단어와 횟수를 그대로 짚고("'이제'가 12번 나왔습니다"),
    말버릇처럼 반복된다는 점을 분명히 쓰세요.
  - talk_silence 가 있으면 다른 말하기 문제가 더 심해도 **빼먹지 말고** 짚으세요. 필러와 한 문장에 묶어도 됩니다
    (예: "'어'가 14번 나왔고 3.5초 이상 멈춘 곳도 4번 있었으니…").
- 잘한 점: 모든 구간의 speech_issues 가 비어 있고 habit_fillers·talk_silence 도 비어 있을 때.
  필러·반복·무음이 몇 번 있어도 판정값에 없으면 문제가 아닙니다(예: speech_issues 에 없는 "반복 2회").
  무음은 talk_silence 로만 판단하세요. 구간 데이터의 무음 목록이나 무음 비율을 보고 따로 문제 삼지 마세요.
- 발화 속도는 speaking_rate_label 을 그대로 따르세요. "보통"이면 문제로 쓰지 마세요.
몸짓
- 고칠 점: 어느 한 구간이라도 motion_issues 가 있을 때.
  motion_issues 에 없는 동작(motion_notes 에만 한 번 적힌 손동작 등)은 고칠 점으로 쓰지 마세요.
- 가벼운 고칠 점: 어느 한 구간이라도 minor_motion_issues 가 있을 때. 빼먹지 말고 반드시 짚되,
  설명 제스처를 잘한 점으로 쓴 뒤 "다만 ~"처럼 짧게 덧붙이세요(3번 틀의 ③).
  "산만한 동작이 없었다"처럼 minor_motion_issues 와 반대되는 말은 쓰지 마세요.
- 잘한 점: 모든 구간의 motion_issues 가 비어 있을 때(minor_motion_issues 만 있어도 몸짓은 잘한 점입니다).
- 설명 제스처(손으로 설명하기·가리키기)의 많고 적음은 사람마다 다른 발표 스타일입니다.
  많으면 잘한 점으로 쓸 수 있지만, 적거나 없다는 이유로 고치라고 하지 마세요
  ("제스처를 추가하세요", "손으로 화면을 가리키세요" 같은 조언 금지).
  motion_notes 에 "제스처가 거의 없다"고 적혀 있어도 고칠 점이 아닙니다.
공통
- 칭찬은 strengths 에 있는 항목으로만 하세요. strengths 에 없는 항목(예: 자세가 없으면 자세)은 칭찬하지 마세요.
- 같은 항목(예: 시선)을 잘한 점으로 쓰고 고칠 점으로도 쓰지 마세요.
- 문제가 없는 쪽에 고칠 점이나 행동을 억지로 만들어 넣지 마세요.

## 2. headline (핵심 한 줄)
한 문장, 약 20~35자, 시각 없이. 구성은 headline_mode 를 그대로 따르세요.
**무엇을 쓸지는 이미 골라 두었습니다.** 잘한 점은 headline_good, 고칠 점은 headline_fix 에 있는 것만 쓰고,
다른 항목으로 바꾸지 마세요. 둘 다 있으면 반드시 둘 다 한 문장에 담으세요(고칠 점만 쓰면 안 됩니다).
headline_good·headline_fix 는 **주제 이름**입니다. 그대로 붙여 넣지 말고 문장 안에 자연스럽게 녹이세요.
구간 이름·구간 수·횟수·"—"·괄호·대괄호는 headline 에 넣지 마세요(근거는 overall_summary 에서 씁니다).
  예: headline_good "설명 제스처", headline_fix "청중·카메라를 보는 시선"
      → "설명 제스처는 잘 썼지만, 화면 대신 청중을 봐 주세요"
headline_mode 는 headline 에만 적용됩니다. "칭찬 위주"여도 overall_summary 에서는 판정값의 고칠 점을
1번 규칙대로 **반드시** 다루고, 판정값과 반대되는 말("말하기 문제가 없었다", "시선 처리가 적절했다" 등)을 쓰지 마세요.
- "칭찬 위주": headline_good 의 잘한 점만 1~2개. 고칠 점은 넣지 마세요.
  예: "발화 속도와 자세가 끝까지 안정적이었어요"
- "균형": headline_good 1개 + headline_fix 1개.
  예: "설명 제스처는 잘 썼지만, 화면 대신 청중을 봐 주세요"
- "고칠 점 위주": headline_fix 의 고칠 점 1개만.
  예: "필러가 잦으니, 문장 끝에서 잠시 멈추는 연습을 해봐요"
headline_fix 가 습관 필러(말버릇처럼 반복된 단어)이면 그 단어를 headline 에 그대로 넣으세요.
  예: "설명 제스처는 잘 썼지만, '이제'가 말버릇처럼 나와요"
어느 모드든 고칠 점은 **1개만** 쓰세요. "필러와 시선을 개선하세요", "시선을 들지 않고 필러가 반복됩니다"처럼
두 가지를 나열하지 마세요. 고칠 점이 말하기·몸짓 둘 다 있으면 headline 에는 하나만 쓰고,
나머지는 overall_summary 에서 다루세요. minor_motion_issues 는 headline 에 쓰지 마세요.
나쁜 예: "자세와 시선은 안정적이지만, 필러와 시선 분배를 개선하세요" (고칠 점 2개 + 시선을 칭찬하고 또 지적)

## 3. overall_summary (부가 설명)
목록이 아니라 이어지는 글 한 문단입니다. **아래 틀의 순서대로 3~4문장**(약 150~250자)으로 쓰고,
4문장을 넘기지 마세요. 말하기와 몸짓은 잘한 점이든 고칠 점이든 둘 다 한 번 이상 나와야 합니다.
  ① 잘한 점 1문장: strengths 의 앞쪽 항목(headline 에 쓴 잘한 점이 있으면 그것)의 근거.
     strengths 가 비어 있으면 이 문장은 쓰지 마세요.
  ② 말하기 1문장: 고칠 점이면 근거(구간·숫자)와 고치는 행동을 한 문장에 쓰세요.
     잘한 점이면 ①에서 다뤘으니 따로 쓰지 않아도 됩니다.
  ③ 몸짓 1문장: 고칠 점이면 근거(구간·동작 이름·횟수)와 고치는 행동을 한 문장에 쓰세요.
     잘한 점이면 ①에서 다뤘으니 따로 쓰지 않아도 됩니다.
     minor_motion_issues 가 있으면 이 자리에 "다만 해결방안(0:54~3:23)에서 얼굴을 만지는 동작이 4번 있었으니,
     손을 허리 높이에 모아 두세요"처럼 짧게 쓰세요.
  ④ (필요할 때만) ②나 ③이 너무 길어지면 행동만 이 문장으로 나눠 쓰세요.
근거 쓰는 법
- 문제가 있는 구간이 여러 개여도 전부 나열하지 말고, 가장 심한 구간 1~2개만 구간 라벨이나 시각으로 짚으세요.
- "대부분의 구간", "후반부"처럼 흐리게 쓰지 마세요.
행동 쓰는 법
- 말하기 행동: "무엇을 줄이려고 + 어떻게 연습할지"를 구체적으로.
  예: "핵심 문장마다 미리 끊어 읽고, 불필요한 '이제' 같은 필러를 줄이기 위해 문장 끝에서 잠시 멈추는 연습을 하세요."
  이 예시를 그대로 베끼지 말고 이 발표에 맞게 쓰세요. habit_fillers 가 있으면 그 단어를 줄이는 방법으로 쓰세요.
- 몸짓 행동: motion_notes 에 적힌 구체적인 장면(어느 구간에서, 무엇을 설명할 때 시선이 내려갔는지·
  얼굴이나 물건을 만졌는지 등)을 근거로 쓰세요. "대본을 외워 핵심 문장마다 카메라를 바라보세요"처럼
  어느 발표에나 쓸 수 있는 일반적인 조언만 쓰지 마세요.
  좋은 예: "본론(1:20~3:40)에서 얼굴을 만지는 동작이 3번 있었으니, 말하는 동안 손을 허리 높이에 모아 두세요."

## 4. 표현 규칙 (headline 과 overall_summary 모두)
- 판정이 있다는 사실을 쓰지 마세요: "기준 이하", "기준을 넘었다", "기준에 해당", "판정", "가벼운 문제" 같은 표현 금지.
  라벨 단어도 "느림으로"처럼 그대로 붙이지 말고 "느린 편", "보통 속도"처럼 풀어 쓰세요.
- 느낌·감상 표현을 쓰지 마세요: 신뢰감, 인상적, 듣기 편한, 생동감, 자연스러운, 적극적인, 긍정적,
  "더 좋은 발표가 될 것입니다" 같은 맺음말. 대신 관찰된 사실(어느 구간·몇 번·몇 초)과 행동을 쓰세요.
  나쁜 예: "자연스러운 손짓을 더해 전달력을 높이면 더욱 생동감 있는 발표가 될 것입니다."
- 영문 데이터 이름(filler_count, silence_ratio, speech_issues 등 소문자와 _ 로 된 이름)을 쓰지 말고
  "필러 횟수", "무음 비율", "발화 속도"처럼 발표자가 읽는 말로 쓰세요.
- 숫자는 데이터 값 그대로: 발화 속도는 "spm" 대신 "분당 ○○음절".
  무음은 "몇 초 멈춘 곳이 몇 번"으로 쓰세요(예: "3초 이상 멈춘 곳이 2번, 가장 긴 것은 5.7초", "6.7초 멈춘 곳이 1번"). 무음 비율(%)은 쓰지 않아도 됩니다.
- 필러 단어를 예로 들 때는 filler_words(그 구간에서 실제로 필러로 잡힌 단어와 횟수)나 habit_fillers 에
  있는 단어만 쓰세요. 전사문에 있어도 거기에 없는 단어('그리고' 같은 접속사 등)는 필러가 아닙니다.
  예시의 '이제'도 거기에 없으면 쓰지 마세요. 둘 다 비어 있으면 단어를 들지 말고 "필러"라고만 쓰세요.
- 시각은 언급해도 되지만 강제는 아닙니다. 언급할 때는 데이터의 time_label 이나 gesture_timelines 값을
  "0:12~0:16" 또는 "0:14"처럼 그대로 쓰고, 계산하거나 지어내지 마세요.
- 전사문(stt_text)은 음성인식 결과라 단어가 잘못 적혀 있을 수 있습니다. 철자·단어 오류는 지적하지 마세요.

## 출력 형식 (JSON, 다른 텍스트 없이)
{{
  "headline": "핵심 한 줄",
  "overall_summary": "3~4문장의 부가 설명 문단"
}}

## outline (발표 전체 구간 목록)
{outline}

## segments (구간별 전사문·지표)
{segments}
"""


# 종합 피드백에서 "말하기 고칠 점"이 있는지 코드가 판정하는 기준 (구간 하나라도 넘으면 있음).
# LLM 에게 "뚜렷한 문제가 없으면 칭찬하라"고만 하면 필러 15회도 "과도하지 않다"고 넘겼다(#105).
# 발화 속도는 넣지 않는다 — 지금 기준(250 SPM 미만 = 느림)이면 거의 모든 발표가 느림이 된다.
# 2회는 한 구간에서 흔히 나오는 수준이라 거의 모든 발표가 말하기 지적을 받아서 3회로 올림 (2026-10-27).
SPEECH_FILLER_MIN = 3       # 필러 횟수
SPEECH_REPEAT_MIN = 3       # 반복(말더듬) 횟수
# 무음: 구간에서 시작한 3초 이상 무음이 2번 이상이면 문제 (2026-11-08, 팀원과 정함 — 그전엔 무음 비율 30%).
# STEP3 도 무음 최소 길이를 3초로 바꾸지만, 그 전에 분석한 세션(0.7초·2초 기준)도 같게 판정되도록 여기서도 거른다.
SPEECH_SILENCE_MIN_SEC = 3.0    # 이 길이(초) 이상인 무음만 센다
SPEECH_SILENCE_COUNT_MIN = 2    # 구간에서 그런 무음이 이 횟수 이상이면 문제
# 구간별 피드백만: 이 길이(초) 이상인 무음은 한 번만 있어도 문제 (2026-11-08, 팀원 제안).
SPEECH_SILENCE_SINGLE_SEC = 5.0
# 종합 피드백: 구간 판정 대신 발표 전체에서 센다 (2026-11-08).
# 종합은 "가장 심한 것"만 짚어서 구간 무음은 필러에 밀려 안 나왔다 → 발표 전체로 잦을 때만 꼭 짚게 한다.
# 2026-11-24: "3초 이상 3번" 한 가지 → 길이별 3단계 중 하나라도 해당하면 문제로 바꿈.
#   길게 멈출수록 적은 횟수로도 눈에 띈다. (길이 초, 횟수) — 3.5초 이상 3번 / 4초 이상 2번 / 5초 이상 1번.
#   구간 카드(_segment_silence_issues)는 그대로 3초 2번 / 5초 1번.
TALK_SILENCE_RULES = ((3.5, 3), (4.0, 2), (5.0, 1))


def _speech_issues(seg: dict) -> list[str]:
    """구간 하나에서 기준을 넘은 필러·반복을 "필러 5회"처럼 사람이 읽는 글로 돌려준다. 없으면 [].

    무음은 구간별(_segment_silence_issues)과 종합(_talk_silence_issues) 기준이 달라서 따로 판정한다.
    """
    issues = []
    if (seg.get("filler_count") or 0) >= SPEECH_FILLER_MIN:
        issues.append(f"필러 {seg['filler_count']}회")
    if (seg.get("repetition_count") or 0) >= SPEECH_REPEAT_MIN:
        issues.append(f"반복 {seg['repetition_count']}회")
    return issues


def _long_silences(silences: list[dict]) -> list[float]:
    """무음 목록에서 3초 이상인 것의 길이(초)만 돌려준다."""
    lengths = [x["t_end"] - x["t_start"] for x in silences or []]
    return [n for n in lengths if n >= SPEECH_SILENCE_MIN_SEC]


def _segment_silence_issues(seg: dict, voice_timeline: dict) -> list[str]:
    """구간별 피드백용 무음 판정: 이 구간에서 시작한 3초 이상 무음이 2번 이상, 또는 5초 이상 무음 1번."""
    lengths = _long_silences([x for x in voice_timeline.get("silence_segments") or []
                              if seg["t_start"] <= x["t_start"] < seg["t_end"]])
    if len(lengths) >= SPEECH_SILENCE_COUNT_MIN:
        return [f"{SPEECH_SILENCE_MIN_SEC:g}초 이상 멈춘 곳 {len(lengths)}번(가장 긴 것 {max(lengths):.1f}초)"]
    if lengths and max(lengths) >= SPEECH_SILENCE_SINGLE_SEC:
        return [f"{max(lengths):.1f}초 멈춘 곳 1번"]
    return []


def _talk_silence_issues(voice_timeline: dict) -> list[str]:
    """종합 피드백용 무음 판정: 발표 전체에서 TALK_SILENCE_RULES 중 하나라도 해당하면
    ["3.5초 이상 멈춘 곳 3번(가장 긴 것 8.4초)"] 처럼 처음 걸린 단계로 돌려준다. 없으면 []."""
    lengths = [x["t_end"] - x["t_start"] for x in voice_timeline.get("silence_segments") or []]
    for sec, count in TALK_SILENCE_RULES:
        hit = [n for n in lengths if n >= sec]
        if len(hit) >= count:
            return [f"{sec:g}초 이상 멈춘 곳 {len(hit)}번(가장 긴 것 {max(hit):.1f}초)"]
    return []


# 음성인식 모델이 군소리를 표시하는 태그 → 사람이 읽는 소리 (voice/filler.py 의 MODEL_FILLER_TAGS)
_FILLER_TAG_SOUND = {"<ah>": "아", "<uh>": "어", "<um>": "음", "<gue>": "그",
                     "<jeo>": "저", "<mwo>": "뭐", "<mak>": "막"}


def _filler_word(f: dict) -> str | None:
    """필러 하나를 사람이 읽는 단어로. 모델 태그(<uh> 등)는 "어" 같은 소리로 바꾸고, 알 수 없는 것(?)은 None."""
    word = _FILLER_TAG_SOUND.get(f.get("text") or "", f.get("text") or "")
    if not word or word.startswith("<") or word == "?":
        return None
    return word


def _filler_words(seg: dict, voice_timeline: dict) -> list[str]:
    """그 구간에서 실제로 필러로 잡힌 단어를 많은 순으로 ["어 9회", "이제 6회"] 처럼 돌려준다.

    전사문만 보고 고르게 하면 '그리고' 같은 접속사를 필러라고 불렀다(#106) → 실제 목록을 준다.
    모델 태그(<uh> 등)는 전사문에 글자로 안 남으니 "어" 같은 소리로 바꾼다. 알 수 없는 것(?)은 뺀다.
    """
    counts: dict[str, int] = {}
    for f in voice_timeline.get("filler_words") or []:
        if not (seg["t_start"] <= f["t_start"] < seg["t_end"]):
            continue
        word = _filler_word(f)
        if word:
            counts[word] = counts.get(word, 0) + 1
    return [f"{w} {n}회" for w, n in sorted(counts.items(), key=lambda x: -x[1])]


# 습관 필러: 발표 전체에서 같은 필러 단어가 이 횟수 이상이고, 전체 필러(단어를 아는 것만) 중 이 비율 이상.
# 구간별로 보면 2~3회씩 흩어져서 안 보이므로 발표 전체로 센다.
# 일부러 "이제"를 많이 쓴 발표에서도 습관이라고 짚지 않아서 추가 (2026-11-06).
HABIT_FILLER_MIN_COUNT = 5
HABIT_FILLER_MIN_SHARE = 0.40


def _habit_fillers(voice_timeline: dict) -> list[str]:
    """발표 전체의 습관 필러를 ["이제 12회 (전체 필러의 55%)"] 처럼 돌려준다. 없으면 []."""
    counts: dict[str, int] = {}
    for f in voice_timeline.get("filler_words") or []:
        word = _filler_word(f)
        if word:
            counts[word] = counts.get(word, 0) + 1
    total = sum(counts.values())
    habits = []
    for word, n in sorted(counts.items(), key=lambda x: -x[1]):
        if n >= HABIT_FILLER_MIN_COUNT and n / total >= HABIT_FILLER_MIN_SHARE:
            habits.append(f"{word} {n}회 (전체 필러의 {_to_percent(n / total)})")
    return habits


# headline 비중: 구간 등급(STEP5 구간별 피드백의 rating)이 이 비율 이상 한쪽이면 그쪽 위주로 쓴다.
# 구간이 3~4개라서 60% = 3개 중 2개, 4개 중 3개.
HEADLINE_MAJORITY = 0.6


def _headline_mode(ratings: list[str | None] | None) -> str:
    """구간 등급 목록 → "칭찬 위주" / "균형" / "고칠 점 위주". 등급이 없으면(예전 세션) "균형"."""
    rated = [r for r in (ratings or []) if r in RATINGS]
    if not rated:
        return "균형"
    if rated.count("잘함") / len(rated) >= HEADLINE_MAJORITY:
        return "칭찬 위주"
    if rated.count("개선필요") / len(rated) >= HEADLINE_MAJORITY:
        return "고칠 점 위주"
    return "균형"


# 종합 피드백에서 "몸짓 고칠 점"이 있는지 코드가 판정하는 기준.
# 부정 제스처는 VLM 이 센 횟수라 STT 보다 오차가 커서 넉넉하게 잡는다:
# 한 구간에서 2회 이상이거나, 발표 전체에서 3회 이상이면(이때는 1회인 구간도 같이 짚는다) 문제.
# 설명 제스처(긍정)는 사람마다 다른 스타일이라 판정에 넣지 않는다.
# 단, 발표 전체에서 긍정 제스처가 부정보다 많으면 부정 제스처는 "가벼운 고칠 점"(minor_motion_issues)으로
# 따로 보낸다(지우지는 않는다 — 설명을 잘해도 얼굴을 자주 만지면 따로 눈에 띈다). headline 에는 안 올리고
# 부가 설명·구간 카드에서만 짧게 짚는다. 시선·자세 문제는 이 규칙과 상관없다. (2026-11-08)
# 처음엔 motion_issues 문구 끝에 "(가벼움: …)"을 붙였는데, LLM 이 그 표시를 문장에 그대로 옮기거나
# 종합 피드백에서 아예 빼먹어서 칸을 나눴다.
MOTION_NEGATIVE_SEGMENT_MIN = 2
MOTION_NEGATIVE_TOTAL_MIN = 3

# 긍정 제스처 3종 (step4_aggregate._POSITIVE_GESTURE_KEYS 와 같음 — 화면의 "일반 제스처" 숫자)
_POSITIVE_GESTURE_KEYS = ("explanatory_gesture", "pointing", "body_movement")

# 부정 제스처 4종의 화면 이름 (step4_aggregate._NEGATIVE_GESTURE_KEYS, 프론트 InteractiveScript 와 같은 이름)
_NEGATIVE_GESTURE_NAMES = {
    "distracting_gesture": "산만한 제스처",
    "touching_face_or_hair": "얼굴·머리 만지기",
    "fidgeting_with_objects": "물건 만지작거리기",
    "closed_posture": "닫힌 자세",
}
_BAD_EYE_CONTACT = ("드묾", "드묽")   # 드묽 = VLM 이 가끔 내는 오타
_BAD_POSTURES = ("구부정", "기댐", "과도한 움직임")


def _segment_motion(seg: dict, video_analysis: list[dict]) -> dict:
    """구간과 겹치는 영상 조각에서 부정 제스처 종류별 횟수, 긍정 제스처 합계, 시선·자세 라벨을 모은다
    (STEP4 집계와 같은 기준)."""
    negative: dict[str, int] = {}
    positive = 0
    eyes, postures = [], []
    for v in video_analysis:
        if not _overlaps(seg["t_start"], seg["t_end"], v["t_start"], v["t_end"]):
            continue
        for key, n in (v.get("gesture_counts") or {}).items():
            if key in _NEGATIVE_GESTURE_NAMES and n:
                negative[key] = negative.get(key, 0) + n
            elif key in _POSITIVE_GESTURE_KEYS and n:
                positive += n
        if v.get("eye_contact"):
            eyes.append(v["eye_contact"])
        if v.get("posture"):
            postures.append(v["posture"])
    return {"negative": negative, "positive": positive, "eyes": eyes, "postures": postures}


def _motion_issues(motion: dict, talk_negative_total: int) -> tuple[list[str], list[str]]:
    """구간 하나의 몸짓 문제를 (부정 제스처 목록, 시선·자세 목록)으로 나눠 돌려준다.

    예: (["얼굴·머리 만지기 3회"], ["시선 드묾(청중·카메라를 거의 보지 않음)", "자세 구부정"]). 없으면 빈 목록.
    motion: _segment_motion() 결과. talk_negative_total: 발표 전체의 부정 제스처 합계.
    """
    negative, others = [], []
    seg_total = sum(motion["negative"].values())
    if seg_total >= MOTION_NEGATIVE_SEGMENT_MIN or (talk_negative_total >= MOTION_NEGATIVE_TOTAL_MIN and seg_total > 0):
        for key, n in sorted(motion["negative"].items(), key=lambda x: -x[1]):
            negative.append(f"{_NEGATIVE_GESTURE_NAMES[key]} {n}회")
    if any(e in _BAD_EYE_CONTACT for e in motion["eyes"]):
        others.append("시선 드묾(청중·카메라를 거의 보지 않음)")
    for p in _BAD_POSTURES:
        if p in motion["postures"]:
            others.append(f"자세 {p}")
    return negative, others


def _all_motion_issues(segments: list[dict], video_analysis: list[dict]) -> list[tuple[list[str], list[str]]]:
    """구간마다 (motion_issues, minor_motion_issues) 를 만든다.

    발표 전체 합계를 먼저 센다: 부정 제스처 "전체 3회" 조건, 그리고 긍정 제스처가 부정보다 많은지.
    긍정이 더 많으면 부정 제스처는 minor_motion_issues(가벼운 고칠 점)로, 아니면 motion_issues 로 간다.
    """
    motions = [_segment_motion(s, video_analysis) for s in segments]
    talk_negative = sum(sum(m["negative"].values()) for m in motions)
    talk_positive = sum(m["positive"] for m in motions)
    minor = talk_positive > talk_negative
    result = []
    for m in motions:
        negative, others = _motion_issues(m, talk_negative)
        result.append((others, negative) if minor else (negative + others, []))
    return result


# headline 에 올릴 잘한 점·고칠 점은 코드가 고른다 (2026-11-24).
# 그전엔 headline_mode 만 넘기고 "가장 잘한 점 / 가장 고칠 점"을 LLM 이 골랐더니
#   - 고칠 점이 여러 개면 돌릴 때마다 다른 항목을 골랐고,
#   - 1번 규칙이 잘한 점을 말하기·몸짓 큰 묶음으로만 정해서, 두 묶음 다 문제가 조금씩 있으면
#     "균형"인데도 잘한 점이 없다고 보고 고칠 점만 썼다
#     (구간 6개 중 보통 5·개선필요 1 → 균형인데 headline 은 필러 지적만).
#     구간 카드에는 "설명 제스처로 강조했다"가 3번이나 나왔는데도.
# 고칠 점: 습관 필러가 있으면 무조건 필러(2026-11-20 팀원 규칙을 코드로 옮김). 그 밖에는 문제가 난
#   구간이 가장 많은 항목. 구간 수가 같으면 _HEADLINE_FIX_ORDER 순서.
# 잘한 점: ① 실제로 한 행동(설명 제스처) 먼저 → ② 없으면 문제가 없었던 것(시선·자세·필러·발화 속도).
#   "발화 속도 보통"은 거의 모든 발표에 나와서 맨 뒤. 고칠 점으로 잡힌 항목은 잘한 점에서 뺀다
#   (구부정한 구간이 있는데 "바른 자세를 유지했다"고 칭찬하던 모순을 막는다).
HEADLINE_GESTURE_MIN_SEGMENTS = 2     # 설명 제스처가 이 개수 이상의 구간에서 나와야 잘한 점
HEADLINE_STEADY_RATE_SHARE = 2 / 3    # 발화 속도 "보통"인 구간이 이 비율 이상이면 잘한 점
_HEADLINE_FIX_ORDER = ("필러", "시선", "산만한 동작", "자세", "무음", "반복")
_POSTURE_TOPIC = {"구부정": "구부정한 자세", "기댐": "기대는 자세", "과도한 움직임": "과도한 몸 움직임"}


def _headline_points(segments: list[dict], video_analysis: list[dict], voice_timeline: dict,
                     motion_issues: list[tuple[list[str], list[str]]]
                     ) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(잘한 점 후보, 고칠 점 후보)를 쓸 순서대로 돌려준다. 각 항목은 (주제, 근거) 쌍.

    주제는 headline 에 넣을 짧은 이름("설명 제스처", "청중을 보는 시선"), 근거는 부가 설명용 한 줄.
    처음엔 근거 한 줄만 보냈더니 LLM 이 headline 에 그 글을 그대로 붙여 넣었다
    ("[시선 — 청중·카메라를 거의 보지 않음, 5개 구간(…)]", 2026-11-24).

    motion_issues: _all_motion_issues() 결과 (구간마다 (motion_issues, minor_motion_issues)).
    """
    labels = [s.get("label") or f"{i + 1}번 구간" for i, s in enumerate(segments)]

    def where(idx: list[int]) -> str:
        return f"{len(idx)}개 구간({'·'.join(labels[i] for i in idx)})"

    # ── 고칠 점: 항목별로 문제가 난 구간 번호를 모은다 ──
    hits: dict[str, list[int]] = {k: [] for k in _HEADLINE_FIX_ORDER}
    for i, s in enumerate(segments):
        if (s.get("filler_count") or 0) >= SPEECH_FILLER_MIN:
            hits["필러"].append(i)
        if (s.get("repetition_count") or 0) >= SPEECH_REPEAT_MIN:
            hits["반복"].append(i)
        if _segment_silence_issues(s, voice_timeline):
            hits["무음"].append(i)
        major = motion_issues[i][0]
        if any(m.startswith("시선") for m in major):
            hits["시선"].append(i)
        if any(m.startswith("자세") for m in major):
            hits["자세"].append(i)
        if any(not m.startswith(("시선", "자세")) for m in major):
            hits["산만한 동작"].append(i)
    habit = _habit_fillers(voice_timeline)
    talk_silence = _talk_silence_issues(voice_timeline)

    def fix_size(key: str) -> int:
        n = len(hits[key])
        # 발표 전체 기준으로만 잡히는 문제(습관 필러·잦은 무음)는 구간이 0개여도 1개로 친다
        if (key == "필러" and habit) or (key == "무음" and talk_silence):
            n = max(n, 1)
        return n

    fixes = []
    def rank(k: str) -> tuple:
        return (not (k == "필러" and habit), -fix_size(k), _HEADLINE_FIX_ORDER.index(k))

    for key in sorted((k for k in _HEADLINE_FIX_ORDER if fix_size(k)), key=rank):
        idx = hits[key]
        if key == "필러":
            text = f"필러가 잦음 — {where(idx)}" if idx else "필러가 잦음"
            if habit:
                text += f", 말버릇처럼 반복된 단어: {', '.join(habit)}"
                topic = "·".join(f"'{h.split()[0]}'" for h in habit) + " 말버릇"
            else:
                topic = "잦은 필러"
        elif key == "시선":
            text = f"시선 — 청중·카메라를 거의 보지 않음, {where(idx)}"
            topic = "청중·카메라를 보는 시선"
        elif key == "자세":
            names = sorted({m for i in idx for m in motion_issues[i][0] if m.startswith("자세")})
            text = f"{', '.join(names)} — {where(idx)}"
            topic = "·".join(_POSTURE_TOPIC.get(n.removeprefix("자세 "), "자세") for n in names)
        elif key == "산만한 동작":
            text = f"산만한 동작(얼굴 만지기·만지작거리기 등) — {where(idx)}"
            topic = "얼굴 만지기 같은 산만한 동작"
        elif key == "무음":
            text = f"말이 오래 끊김 — {talk_silence[0]}" if talk_silence else f"말이 오래 끊김 — {where(idx)}"
            topic = "말이 오래 끊기는 곳"
        else:
            text = f"같은 말 반복(말더듬) — {where(idx)}"
            topic = "같은 말 반복"
        fixes.append((topic, text))

    # ── 잘한 점 ──
    goods = []
    motions = [_segment_motion(s, video_analysis) for s in segments]
    talk_positive = sum(m["positive"] for m in motions)
    talk_negative = sum(sum(m["negative"].values()) for m in motions)
    gesture_idx = [i for i, m in enumerate(motions) if m["positive"] > 0]
    # ① 실제로 한 행동
    if talk_positive > talk_negative and len(gesture_idx) >= HEADLINE_GESTURE_MIN_SEGMENTS:
        goods.append(("설명 제스처", f"설명 제스처 — {where(gesture_idx)}에서 손으로 설명하거나 가리키며 내용을 강조함"))
    # ② 문제가 없었던 것 (고칠 점으로 잡힌 항목은 빼고)
    if not fix_size("시선"):
        goods.append(("청중을 보는 시선", "시선 — 청중·카메라를 거의 보지 않은 구간이 없음"))
    if not fix_size("자세") and not fix_size("산만한 동작"):
        goods.append(("안정적인 자세", "자세 — 구부정하거나 기대는 구간 없이 안정적"))
    if not fix_size("필러") and not fix_size("반복"):
        goods.append(("적은 필러", "필러·반복 — 모든 구간에서 적음"))
    steady = [i for i, s in enumerate(segments) if _speaking_rate_label(s.get("speaking_rate_spm")) == "보통"]
    if segments and len(steady) / len(segments) >= HEADLINE_STEADY_RATE_SHARE:
        goods.append(("일정한 말 속도", f"발화 속도 — {len(segments)}개 구간 중 {len(steady)}개에서 보통 속도로 일정"))
    return goods, fixes


def _headline_plan(mode: str, goods: list, fixes: list,
                   habit_fillers: bool = False) -> tuple[str, list, list]:
    """headline_mode 에 맞춰 headline 에 쓸 (모드, 잘한 점, 고칠 점)을 정한다.

    쓸 거리가 없는 쪽은 모드를 바꾼다: 균형인데 잘한 점 후보가 없으면 고칠 점 위주, 고칠 점이 없으면 칭찬 위주.
    habit_fillers: 습관 필러가 있으면 "칭찬 위주"여도 잘한 점 1개 + 습관 필러 1개(균형)로 쓴다 (2026-11-20 팀원 규칙).
    """
    if mode == "칭찬 위주" and habit_fillers and fixes:
        mode = "균형"
    if mode == "칭찬 위주" and not goods and fixes:
        mode = "고칠 점 위주"
    elif mode == "고칠 점 위주" and not fixes and goods:
        mode = "칭찬 위주"
    elif mode == "균형" and not (goods and fixes):
        mode = "고칠 점 위주" if fixes else "칭찬 위주"
    if mode == "칭찬 위주":
        return mode, goods[:2], []
    if mode == "고칠 점 위주":
        return mode, [], fixes[:1]
    return mode, goods[:1], fixes[:1]


def _to_percent(ratio):
    """0~1 비율 → "30%" 글자. 값이 없으면 그대로 둔다."""
    return f"{round(ratio * 100)}%" if isinstance(ratio, (int, float)) else ratio


def run_overall(segments: list[dict], video_analysis: list[dict], voice_timeline: dict,
                ratings: list[str | None] | None = None) -> dict:
    """발표 전체를 한 번 호출해서 핵심 한 줄(headline)과 부가 설명(overall_summary)을 받는다.

    segments: run_segments 와 같은 입력(segment_id 포함, 구간 순서). video_analysis·voice_timeline 은
    인자로는 받지만 이번엔 프롬프트에 넣지 않는다 — 총평은 구간별 지표(segments 안에 이미 집계돼
    있음)만으로 충분하고, 원본 이벤트까지 다 보내면 총평치고 너무 장황해진다.
    (voice_timeline 의 필러 목록은 구간별 filler_words 와 습관 필러를, video_analysis 는 motion_issues 를 셀 때만 쓴다)
    ratings: 구간별 피드백에서 나온 구간 등급(잘함/보통/개선필요) 목록 — headline 비중을 정한다.
    반환: {"headline": "...", "overall_summary": "..."}
    """
    client = _make_client()

    outline = [{"label": s["label"], "title": s["title"],
                "t_start": s["t_start"], "t_end": s["t_end"]} for s in segments]
    # 숫자는 LLM 이 그대로 옮겨 쓸 수 있는 모양으로 바꿔서 보낸다.
    #   무음 비율: 0~1 소수 → "30%" (소수로 보내면 %로 바꾸며 끝자리를 틀렸다: 0.296 → "29%")
    #   발화 속도: 소수 → 정수 (171.9 를 "171"로 버림해서 썼다) + 구간별 피드백과 같은
    #   느림/보통/빠름 라벨 (라벨 없이 숫자만 주면 144~211 을 "일정하다"고 판단했다)
    motion_issues = _all_motion_issues(segments, video_analysis)
    segs_view = []
    for s, (mi, minor) in zip(segments, motion_issues):
        view = {k: (_to_percent(v) if k == "silence_ratio" else v) for k, v in s.items() if k != "segment_id"}
        spm = s.get("speaking_rate_spm")
        if isinstance(spm, (int, float)):
            view["speaking_rate_spm"] = round(spm)
        view["speaking_rate_label"] = _speaking_rate_label(spm)
        view["speech_issues"] = _speech_issues(s)   # 무음은 발표 전체 기준(talk_silence)으로 따로 보낸다
        view["filler_words"] = _filler_words(s, voice_timeline)
        view["motion_issues"] = mi
        view["minor_motion_issues"] = minor
        segs_view.append(view)
    labeled = {"outline": _add_time_labels(outline), "segments": _add_time_labels(segs_view)}
    goods, fixes = _headline_points(segments, video_analysis, voice_timeline, motion_issues)
    mode, head_good, head_fix = _headline_plan(_headline_mode(ratings), goods, fixes,
                                               habit_fillers=bool(_habit_fillers(voice_timeline)))

    prompt = OVERALL_PROMPT.format(
        outline=json.dumps(labeled["outline"], ensure_ascii=False, indent=2),
        segments=json.dumps(labeled["segments"], ensure_ascii=False, indent=2),
        habit_fillers=json.dumps(_habit_fillers(voice_timeline), ensure_ascii=False),
        talk_silence=json.dumps(_talk_silence_issues(voice_timeline), ensure_ascii=False),
        headline_mode=mode,
        headline_good=" / ".join(t for t, _ in head_good) or "(없음)",
        headline_fix=" / ".join(t for t, _ in head_fix) or "(없음)",
        strengths=json.dumps([d for _, d in goods], ensure_ascii=False),
    )

    allowed = _collect_time_tokens(labeled)
    hint = ""
    for _ in range(HEADLINE_MAX_ATTEMPTS):
        result = _generate_validated(client, prompt + hint, allowed, "STEP 5 종합")
        problem = _headline_problem(result.get("headline"))
        if not problem:
            return result
        logger.warning("STEP 5 종합: headline 이 이상함(%s) → 다시 요청: %r", problem, result.get("headline"))
        hint = ("\n\n## 정정 요청\n이전 headline 이 " + problem + ". 2번 규칙대로 20~35자의 자연스러운 "
                "한 문장으로 처음부터 다시 작성하세요.")
    # 그래도 이상하면 코드가 고른 주제로 짧게 만든다 — 설명 글이 화면에 그대로 나가는 것보다 낫다.
    result["headline"] = _fallback_headline(head_good, head_fix) or result.get("headline")
    return result


# headline 검사: 근거 글을 그대로 붙여 넣은 흔적이 있으면 다시 요청한다 (2026-11-24).
HEADLINE_MAX_ATTEMPTS = 2
HEADLINE_MAX_LEN = 45
_HEADLINE_COPY_MARKS = ("—", "[", "]", "개 구간", "headline_", "strengths")


def _headline_problem(headline) -> str | None:
    """headline 이 이상하면 이유 한 줄, 괜찮으면 None."""
    if not isinstance(headline, str) or not headline.strip():
        return "비어 있습니다"
    marks = [m for m in _HEADLINE_COPY_MARKS if m in headline]
    if marks:
        return f"데이터 설명 글을 그대로 옮겨 적었습니다({', '.join(marks)} 포함)"
    if len(headline) > HEADLINE_MAX_LEN:
        return f"{len(headline)}자로 너무 깁니다"
    return None


def _fallback_headline(goods: list, fixes: list) -> str | None:
    """재요청해도 headline 이 이상할 때 쓰는 짧은 문장 (조사가 필요 없는 모양)."""
    good = goods[0][0] if goods else None
    fix = fixes[0][0] if fixes else None
    if good and fix:
        return f"잘한 점: {good} · 고칠 점: {fix}"
    if fix:
        return f"이번에 고칠 점: {fix}"
    if good:
        return f"이번에 잘한 점: {good}"
    return None
