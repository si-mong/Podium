from datetime import datetime
from typing import Literal

from pydantic import BaseModel

Verdict = Literal["improved", "same", "worse"]


class MetricDiff(BaseModel):
    """지표 하나의 두 회차 값. 비율(unit "%")은 0~1 값 그대로 내려준다."""
    key: str
    label: str
    unit: str
    direction: Literal["lower", "higher", "band", "neutral"]
    base: float | None
    target: float | None
    verdict: Verdict | None             # 판정 없는 지표거나 값이 없으면 None
    base_count: int | None = None       # 분당 횟수 지표의 원래 횟수
    target_count: int | None = None


class SegmentBrief(BaseModel):
    segment_id: int
    title: str
    t_start: float
    t_end: float
    stt_text: str | None
    rating: str | None


class LabelCompare(BaseModel):
    label: str
    status: Literal["both", "only_base", "only_target"]
    metrics: list[MetricDiff]
    base_segments: list[SegmentBrief]
    target_segments: list[SegmentBrief]


class CompareSession(BaseModel):
    session_id: int
    session_no: int
    created_at: datetime
    comparable: bool                    # 구간 분리까지 끝나서 비교할 수 있는 회차인지
    has_video: bool


class FeedbackItem(BaseModel):
    status: Literal["resolved", "improved", "persists", "new"]
    title: str
    previous: str | None
    detail: str


class CompareFeedback(BaseModel):
    comparison_id: int
    base_session_id: int | None
    target_session_id: int | None
    base_session_no: int
    target_session_no: int
    status: str                         # done / error
    headline: str | None
    items: list[FeedbackItem]
    error: str | None
    created_at: datetime
    stale: bool                         # 만든 뒤 두 회차 중 하나가 재분석됨 → 다시 만들기 권장


class ProjectCompare(BaseModel):
    project_id: int
    sessions: list[CompareSession]      # 폴더의 전체 회차 (회차 선택용)
    base: CompareSession | None         # 두 회차를 아직 안 골랐으면 None
    target: CompareSession | None
    metrics: list[MetricDiff]
    labels: list[LabelCompare]
    warnings: list[str]
    feedback: CompareFeedback | None    # 이 두 회차로 만든 AI 비교 피드백 (없으면 None)


class ComparisonListItem(BaseModel):
    comparison_id: int
    base_session_id: int | None
    target_session_id: int | None
    base_session_no: int
    target_session_no: int
    status: str
    headline: str | None
    created_at: datetime
