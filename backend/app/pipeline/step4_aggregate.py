"""
Step 4-b: 구간별 집계

STEP 4 가 정한 구간 경계로 **앞 단계 결과를 잘라 담는다.** 새로 측정하지 않는다.

    segments[i] = (t_start, t_end)
          ↓ 이 범위에 걸치는 것을 모아서
    segment_analyses[i]

`voice_raws` 의 세 배열(silence_segments / filler_words / repetitions)이 같은 뼈대
(t_start / t_end / duration)라 같은 함수로 센다.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# 한글 음절 블록 — 발화 속도는 어절(WPM)이 아니라 음절(SPM) 기준.
# 띄어쓰기 정책에 따라 어절 수가 흔들리기 때문. (docs/Dev-STEP3.md 참고)
_HANGUL_START, _HANGUL_END = 0xAC00, 0xD7A3


def _count_syllables(text: str) -> int:
    hangul = sum(1 for c in text if _HANGUL_START <= ord(c) <= _HANGUL_END)
    other = sum(1 for c in text if c.isalnum()
                and not (_HANGUL_START <= ord(c) <= _HANGUL_END))
    return hangul + other // 2


def _in_range(items, t0: float, t1: float) -> list[dict]:
    """구간 [t0, t1) 안에서 **시작하는** 항목들.

    시작 시각 기준으로 판정한다. 걸쳐 있는 항목을 양쪽에 중복으로 세지 않기 위함 —
    구간별 개수를 다 더하면 전체 개수와 일치해야 한다.
    """
    return [x for x in (items or []) if t0 <= x["t_start"] < t1]


def _overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


_POSITIVE_GESTURE_KEYS = ("explanatory_gesture", "pointing", "body_movement")
_NEGATIVE_GESTURE_KEYS = ("distracting_gesture", "touching_face_or_hair",
                          "fidgeting_with_objects", "closed_posture")


def aggregate(segment: dict, sentences: list[dict], voice_raw: dict,
              video_analyses=None) -> dict:
    """구간 하나의 집계값. 반환 키는 `segment_analyses` 컬럼과 1:1."""
    t0, t1 = segment["t_start"], segment["t_end"]
    dur = max(1e-6, t1 - t0)

    texts = [s["text"] for s in sentences if t0 <= s["t_start"] < t1]
    stt_text = " ".join(texts).strip()
    syllables = _count_syllables(stt_text)

    silences = _in_range(voice_raw.get("silence_segments"), t0, t1)
    fillers = _in_range(voice_raw.get("filler_words"), t0, t1)
    reps = _in_range(voice_raw.get("repetitions"), t0, t1)

    # 구간 안 무음 길이는 **겹친 만큼만** 센다 (경계를 걸친 무음 대비)
    silence_sec = sum(_overlap(t0, t1, x["t_start"], x["t_end"])
                      for x in (voice_raw.get("silence_segments") or []))
    speech_sec = max(1e-6, dur - silence_sec)

    gesture: dict[str, int] = {}
    posture: dict[str, int] = {}
    eye: dict[str, int] = {}
    notes: list[str] = []
    for v in video_analyses or []:
        if _overlap(t0, t1, v["t_start"], v["t_end"]) <= 0:
            continue
        for k, n in (v.get("gesture_counts") or {}).items():
            gesture[k] = gesture.get(k, 0) + n
        # posture/eye_contact 는 청크당 라벨 하나 → 등장 횟수로 집계
        if v.get("posture"):
            posture[v["posture"]] = posture.get(v["posture"], 0) + 1
        if v.get("eye_contact"):
            eye[v["eye_contact"]] = eye.get(v["eye_contact"], 0) + 1
        if v.get("notes"):
            notes.append(v["notes"])

    return {
        "stt_text": stt_text or None,
        "speaking_rate_spm": round(syllables / (dur / 60.0), 1),             # 무음 포함
        "articulation_rate_spm": round(syllables / (speech_sec / 60.0), 1),  # 무음 제외
        "silence_count": len(silences),
        "silence_ratio": round(silence_sec / dur, 3),
        "filler_count": len(fillers),
        "repetition_count": len(reps),
        "gesture_counts": gesture or None,
        "positive_gesture_count": sum(gesture.get(k, 0) for k in _POSITIVE_GESTURE_KEYS),
        "negative_gesture_count": sum(gesture.get(k, 0) for k in _NEGATIVE_GESTURE_KEYS),
        "posture_counts": posture or None,
        "eye_contact_counts": eye or None,
        "motion_notes": " / ".join(notes) or None,
    }


def summarize(per_segment: list[dict], total_duration: float) -> dict:
    """세션 전체 요약 — `session_summaries` 컬럼과 1:1."""
    n = len(per_segment)
    return {
        "total_duration": round(total_duration, 2),
        "segment_count": n,
        "total_filler_count": sum(x["filler_count"] for x in per_segment),
        "total_repetition_count": sum(x["repetition_count"] for x in per_segment),
        "avg_speaking_rate_spm": round(
            sum(x["speaking_rate_spm"] for x in per_segment) / n, 1) if n else None,
        "avg_articulation_rate_spm": round(
            sum(x["articulation_rate_spm"] for x in per_segment) / n, 1) if n else None,
    }
