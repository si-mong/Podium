"""두 회차 비교 (설계: docs/Dev-비교분석.md) — ① 전체 지표 비교 · ② 같은 라벨 구간끼리 비교.

LLM 을 부르지 않고 **저장된 분석 결과만** 모아 계산한다. ③ AI 비교 피드백(app/pipeline/compare_feedback.py)은
여기서 계산한 숫자를 그대로 받아 해석만 한다 — 숫자를 LLM 이 만들지 않게.

- 회차마다 발표 길이가 달라서 횟수 지표는 **분당 횟수**로 바꿔 비교한다.
- 작은 변화(허용폭 안)는 "유지"로 본다. 3.1 → 3.0 회/분을 "개선"이라 하면 오히려 믿음이 떨어진다.
- 말하기 속도는 많을수록/적을수록 좋은 지표가 아니라, 적정 범위(STEP5 와 같은 250~450 음절/분)에
  더 가까워졌는지로 판정한다.
- 종합추이(GET /projects/{id}/trend)도 같은 overall_metrics 를 쓴다 → 두 화면 숫자가 같다.
"""
from __future__ import annotations

import re
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession, selectinload

from app.models import AnalysisEvent, Segment, SessionSummary, VideoAnalysis, VoiceRaw
from app.pipeline.step5_feedback import SPM_FAST, SPM_SLOW

# gesture_counts 7종(app/pipeline/step2_video_analysis.py) 중 일반/부정적 제스처로 묶는 기준.
# 프론트 단일 분석 카드(dashboard/page.tsx 의 GENERAL/NEGATIVE_GESTURE_KEYS)와 같다.
GENERAL_GESTURE_KEYS = ("explanatory_gesture", "pointing", "body_movement")
NEGATIVE_GESTURE_KEYS = ("distracting_gesture", "touching_face_or_hair", "fidgeting_with_objects", "closed_posture")

# 분석 파이프라인 단계 (analysis_events.step). 비교 피드백("comparison")은 분석이 아니라서 뺀다.
PIPELINE_STEPS = ("preprocess", "motion", "voice", "segments", "segment_feedback", "overall_feedback")
STEP_NAMES = {"motion": "동작 분석", "voice": "음성 분석", "segments": "구간 분리",
              "segment_feedback": "구간 피드백", "overall_feedback": "종합 피드백"}

# 지표 정의: (키, 이름, 단위, 방향, 허용폭)
#   방향 lower = 적을수록 좋음 / higher = 많을수록 좋음 / band = 적정 범위에 가까울수록 좋음 / neutral = 판정 없음
#   허용폭: 변화가 max(허용폭, 이전 값의 10%) 보다 작으면 "유지"
OVERALL_METRICS = [
    ("filler_per_min", "필러", "회/분", "lower", 0.3),
    ("repetition_per_min", "말 더듬", "회/분", "lower", 0.2),
    ("silence_ratio", "무음 비율", "%", "lower", 0.02),
    ("speaking_rate_spm", "말하기 속도", "음절/분", "band", 15),
    ("negative_gesture_per_min", "부정적 제스처", "회/분", "lower", 0.2),
    ("general_gesture_per_min", "일반 제스처", "회/분", "neutral", 0),
    ("eye_contact_ratio", "시선 맞춤 비율", "%", "higher", 0.05),
    ("duration_sec", "발표 길이", "초", "neutral", 0),
]
# 구간(라벨)별 비교에 쓰는 지표 — 구간 영상 조각 단위인 시선 비율은 구간에 없어서 뺀다
LABEL_METRICS = [m for m in OVERALL_METRICS if m[0] not in ("eye_contact_ratio", "general_gesture_per_min")]
REL_TOLERANCE = 0.10
# 분당 횟수의 원래 횟수 (화면에 "12회 → 5회" 로 같이 보여준다)
COUNT_OF = {"filler_per_min": "filler_count", "repetition_per_min": "repetition_count",
            "negative_gesture_per_min": "negative_gesture", "general_gesture_per_min": "general_gesture"}

NO_LABEL = "(라벨 없음)"


def _per_min(count, duration_sec):
    if count is None or not duration_sec:
        return None
    return round(count / (duration_sec / 60), 2)


def _gesture_sums(counts: dict | None) -> tuple[int, int]:
    counts = counts or {}
    return (sum(counts.get(k) or 0 for k in GENERAL_GESTURE_KEYS),
            sum(counts.get(k) or 0 for k in NEGATIVE_GESTURE_KEYS))


def overall_metrics(voice: VoiceRaw | None, summary: SessionSummary | None, vas: list[VideoAnalysis]) -> dict:
    """회차 하나의 전체 지표. 단일 분석 화면 상단 카드와 같은 기준 (voice-summary + 동작 분석 합계).

    분석이 안 끝난 단계의 값은 None.
    """
    duration = voice.total_duration if voice is not None else (summary.total_duration if summary else None)
    m: dict = {"duration_sec": duration, "filler_count": None, "repetition_count": None, "silence_ratio": None,
               "speaking_rate_spm": summary.avg_speaking_rate_spm if summary else None,
               "general_gesture": None, "negative_gesture": None, "eye_contact_ratio": None}
    if voice is not None:
        m["filler_count"] = len(voice.filler_words or [])
        m["repetition_count"] = len(voice.repetitions or [])
        if voice.total_duration > 0:
            silence_sec = sum(seg["duration"] for seg in (voice.silence_segments or []))
            m["silence_ratio"] = round(silence_sec / voice.total_duration, 3)
    if vas:
        general = negative = 0
        eye_total = eye_frequent = 0.0
        for va in vas:
            g, n = _gesture_sums(va.gesture_counts)
            general += g
            negative += n
            # 시선은 영상 조각마다 빈번/보통/드묾 중 하나 → 조각 길이로 가중해서 "빈번" 비율
            if va.eye_contact in ("빈번", "보통", "드묾"):
                dur = max(va.t_end - va.t_start, 0)
                eye_total += dur
                if va.eye_contact == "빈번":
                    eye_frequent += dur
        m["general_gesture"], m["negative_gesture"] = general, negative
        if eye_total > 0:
            m["eye_contact_ratio"] = round(eye_frequent / eye_total, 3)
    for key, count_key in COUNT_OF.items():
        m[key] = _per_min(m[count_key], duration)
    return m


def _band_distance(spm: float) -> float:
    return max(SPM_SLOW - spm, 0, spm - SPM_FAST)


def _verdict(direction: str, base, target, tolerance: float) -> str | None:
    """improved / same / worse. 판정하지 않는 지표거나 값이 없으면 None."""
    if direction == "neutral" or base is None or target is None:
        return None
    if direction == "band":
        base, target, direction = _band_distance(base), _band_distance(target), "lower"
    if abs(target - base) < max(tolerance, abs(base) * REL_TOLERANCE):
        return "same"
    better = target < base if direction == "lower" else target > base
    return "improved" if better else "worse"


def diff_metrics(defs, base: dict, target: dict) -> list[dict]:
    out = []
    for key, label, unit, direction, tol in defs:
        b, t = base.get(key), target.get(key)
        row = {"key": key, "label": label, "unit": unit, "direction": direction,
               "base": b, "target": t, "verdict": _verdict(direction, b, t, tol)}
        if key in COUNT_OF:
            row["base_count"], row["target_count"] = base.get(COUNT_OF[key]), target.get(COUNT_OF[key])
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# ② 라벨별 구간 비교
# ---------------------------------------------------------------------------

def _label_metrics(segs: list[Segment]) -> dict:
    """같은 라벨 구간 여러 개를 하나로 합친 지표. 비율·속도는 구간 길이로 가중 평균."""
    dur = sum(max(s.t_end - s.t_start, 0) for s in segs)
    filler = repetition = negative = 0
    silence_w = rate_w = rate_dur = 0.0
    for s in segs:
        a = s.analysis
        if a is None:
            continue
        d = max(s.t_end - s.t_start, 0)
        filler += a.filler_count or 0
        repetition += a.repetition_count or 0
        negative += a.negative_gesture_count if a.negative_gesture_count is not None else _gesture_sums(a.gesture_counts)[1]
        silence_w += (a.silence_ratio or 0) * d
        if a.speaking_rate_spm is not None:
            rate_w += a.speaking_rate_spm * d
            rate_dur += d
    return {
        "duration_sec": round(dur, 1),
        "filler_count": filler, "filler_per_min": _per_min(filler, dur),
        "repetition_count": repetition, "repetition_per_min": _per_min(repetition, dur),
        "negative_gesture": negative, "negative_gesture_per_min": _per_min(negative, dur),
        "silence_ratio": round(silence_w / dur, 3) if dur else None,
        "speaking_rate_spm": round(rate_w / rate_dur) if rate_dur else None,
    }


def _segment_brief(s: Segment) -> dict:
    return {"segment_id": s.segment_id, "title": s.title, "t_start": s.t_start, "t_end": s.t_end,
            "stt_text": s.analysis.stt_text if s.analysis else None,
            "rating": s.feedback.rating if s.feedback else None}


def align_labels(base_segs: list[Segment], target_segs: list[Segment]) -> list[dict]:
    """같은 라벨끼리 묶어 비교 (설계 문서의 방식 A: 라벨 합산).

    구간 수·경계가 회차마다 달라서 1번 구간끼리 비교하는 건 의미가 없다.
    순서는 이번 회차에 나온 순서, 이번에 없는 라벨은 뒤에 붙인다 (status: both / only_base / only_target).
    """
    def group(segs):
        g: dict[str, list[Segment]] = {}
        for s in sorted(segs, key=lambda s: s.t_start):
            g.setdefault(s.label or NO_LABEL, []).append(s)
        return g

    bg, tg = group(base_segs), group(target_segs)
    order = list(tg) + [k for k in bg if k not in tg]
    out = []
    for label in order:
        b, t = bg.get(label), tg.get(label)
        bm, tm = (_label_metrics(b) if b else None), (_label_metrics(t) if t else None)
        out.append({
            "label": label,
            "status": "both" if b and t else ("only_base" if b else "only_target"),
            "metrics": diff_metrics(LABEL_METRICS, bm or {}, tm or {}),
            "base_segments": [_segment_brief(s) for s in b or []],
            "target_segments": [_segment_brief(s) for s in t or []],
        })
    return out


# ---------------------------------------------------------------------------
# 데이터 모으기
# ---------------------------------------------------------------------------

def load_sessions(db: DbSession, session_ids: list[int]) -> dict[int, dict]:
    """회차별 원자료. 테이블마다 한 번씩만 조회한다 (회차가 많아도 쿼리 수 일정)."""
    if not session_ids:
        return {}
    data = {sid: {"voice": None, "summary": None, "vas": [], "segments": []} for sid in session_ids}
    for v in db.scalars(select(VoiceRaw).where(VoiceRaw.session_id.in_(session_ids))):
        data[v.session_id]["voice"] = v
    for s in db.scalars(select(SessionSummary).where(SessionSummary.session_id.in_(session_ids))):
        data[s.session_id]["summary"] = s
    for va in db.scalars(select(VideoAnalysis).where(VideoAnalysis.session_id.in_(session_ids))):
        data[va.session_id]["vas"].append(va)
    return data


def load_segments(db: DbSession, session_id: int) -> list[Segment]:
    return list(db.scalars(
        select(Segment).where(Segment.session_id == session_id)
        .options(selectinload(Segment.analysis), selectinload(Segment.feedback))
        .order_by(Segment.t_start)
    ))


def analyzed_at(db: DbSession, session_id: int) -> datetime | None:
    """마지막으로 분석이 끝난 시각. 저장된 비교 피드백이 낡았는지(재분석됐는지) 판단하는 데 쓴다."""
    return db.scalar(
        select(func.max(AnalysisEvent.finished_at))
        .where(AnalysisEvent.session_id == session_id, AnalysisEvent.step.in_(PIPELINE_STEPS),
               AnalysisEvent.status.in_(["succeeded", "partial"]))
    )


def model_warnings(db: DbSession, base_id: int, target_id: int) -> list[str]:
    """두 회차를 분석한 모델이 단계별로 다르면 경고 문구. 설정이 다르면 숫자 변화가 실력 변화가 아닐 수 있다."""
    def models(sid):
        out = {}
        for ev in db.scalars(select(AnalysisEvent).where(
                AnalysisEvent.session_id == sid, AnalysisEvent.status == "succeeded",
                AnalysisEvent.step.in_(PIPELINE_STEPS)).order_by(AnalysisEvent.started_at)):
            if ev.model:
                out[ev.step] = ev.model
        return out

    bm, tm = models(base_id), models(target_id)
    steps = [STEP_NAMES.get(k, k) for k in STEP_NAMES if k in bm and k in tm and bm[k] != tm[k]]
    if not steps:
        return []
    return [f"두 회차의 분석 방식이 달라요 ({', '.join(steps)}). 숫자 변화가 실력 변화가 아닐 수 있어요."]


# ---------------------------------------------------------------------------
# ③ 에 넘길 지난 피드백
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(r"\s*\(?\d+:\d\d(?:\s*~\s*\d+:\d\d)?\)?")


def strip_times(text: str) -> str:
    """피드백 문장의 시각("0:12~0:16")을 지운다. 회차마다 시각이 달라 비교에선 의미가 없고,
    남겨 두면 LLM 이 다른 회차의 시각을 섞어 쓴다."""
    return _TIME_RE.sub("", text).strip()


def feedback_digest(summary: SessionSummary | None, segs: list[Segment]) -> dict:
    """회차의 피드백 요약 — 종합 총평 + 라벨별 개선점 (시각 제거)."""
    fb = (summary.llm_feedback if summary else None) or {}
    improvements = []
    for s in segs:
        for text in (s.feedback.improvements if s.feedback else None) or []:
            if isinstance(text, str) and text.strip():
                improvements.append({"label": s.label or NO_LABEL, "text": strip_times(text)})
    return {
        "headline": strip_times(fb.get("headline") or "") or None,
        "overall_summary": strip_times(fb.get("overall_summary") or "") or None,
        "improvements": improvements,
    }
