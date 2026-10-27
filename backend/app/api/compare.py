"""비교 분석 라우터 (설계: docs/Dev-비교분석.md).

  GET  /projects/{id}/compare?base=&target=           -> ① 전체 지표 + ② 같은 구간끼리 비교 (그때그때 계산)
  POST /projects/{id}/compare/feedback?base=&target=  -> ③ AI 비교 피드백 생성 (GPT, 저장)
  GET  /projects/{id}/comparisons                     -> 만든 AI 비교 피드백 목록

두 회차는 같은 폴더에 있고 구간 분리(STEP4)까지 끝나 있어야 한다. 아니면 400.
base/target 을 안 주면 비교할 수 있는 회차 중 마지막 회차(target)와 그 직전 회차(base).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api._deps import get_current_user_id, get_owned_project
from app.core.database import get_db
from app.models import Session, SessionComparison
from app.pipeline import compare_feedback
from app.schemas.compare import (
    CompareFeedback,
    CompareSession,
    ComparisonListItem,
    ProjectCompare,
)
from app.services import compare as cmp
from app.services.analysis_log import tracked

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["compare"])


def _project_sessions(db: DbSession, project_id: int) -> tuple[list[CompareSession], dict]:
    sessions = db.scalars(
        select(Session).where(Session.project_id == project_id).order_by(Session.session_no)
    ).all()
    data = cmp.load_sessions(db, [s.session_id for s in sessions])
    items = [CompareSession(session_id=s.session_id, session_no=s.session_no, created_at=s.created_at,
                            comparable=data[s.session_id]["summary"] is not None,
                            has_video=bool(s.full_video_path))
             for s in sessions]
    return items, data


def _pick(items: list[CompareSession], base: int | None, target: int | None) -> tuple[CompareSession | None, CompareSession | None]:
    """비교할 두 회차를 고른다. 직접 고른 회차가 이 폴더에 없거나 아직 비교할 수 없으면 400."""
    ok = [s for s in items if s.comparable]
    by_id = {s.session_id: s for s in items}
    for sid in (base, target):
        if sid is not None and (sid not in by_id or not by_id[sid].comparable):
            raise HTTPException(400, "비교할 수 없는 회차예요. 같은 폴더에서 분석이 끝난 회차를 골라 주세요.")
    if base is not None and base == target:
        raise HTTPException(400, "서로 다른 두 회차를 골라 주세요.")
    if len(ok) < 2:
        return None, None
    t = by_id[target] if target is not None else ok[-1]
    if base is not None:
        return by_id[base], t
    # 기본 비교 대상: 이번 회차 바로 앞의 회차. 첫 회차를 골랐으면 바로 뒤 회차.
    before = [s for s in ok if s.session_no < t.session_no]
    after = [s for s in ok if s.session_no > t.session_no]
    return (before[-1] if before else after[0]), t


def _to_feedback(db: DbSession, c: SessionComparison) -> CompareFeedback:
    stale = False
    if c.base_session_id and c.target_session_id:
        stale = (cmp.analyzed_at(db, c.base_session_id) != c.base_analyzed_at
                 or cmp.analyzed_at(db, c.target_session_id) != c.target_analyzed_at)
    fb = c.llm_feedback or {}
    return CompareFeedback(
        comparison_id=c.comparison_id, base_session_id=c.base_session_id, target_session_id=c.target_session_id,
        base_session_no=c.base_session_no, target_session_no=c.target_session_no, status=c.status,
        headline=fb.get("headline"), items=fb.get("items") or [], error=c.error,
        created_at=c.created_at, stale=stale,
    )


def _compute(db: DbSession, data: dict, base: CompareSession, target: CompareSession):
    bd, td = data[base.session_id], data[target.session_id]
    metrics = cmp.diff_metrics(cmp.OVERALL_METRICS,
                               cmp.overall_metrics(bd["voice"], bd["summary"], bd["vas"]),
                               cmp.overall_metrics(td["voice"], td["summary"], td["vas"]))
    base_segs, target_segs = cmp.load_segments(db, base.session_id), cmp.load_segments(db, target.session_id)
    labels = cmp.align_labels(base_segs, target_segs)
    return metrics, labels, base_segs, target_segs


@router.get("/{project_id}/compare", response_model=ProjectCompare)
def get_compare(
    project_id: int,
    base: int | None = None,
    target: int | None = None,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """두 회차의 전체 지표·구간별 지표·스크립트. 저장하지 않고 저장된 분석 결과로 그때그때 계산한다."""
    get_owned_project(db, project_id, user_id)
    items, data = _project_sessions(db, project_id)
    b, t = _pick(items, base, target)
    if b is None or t is None:
        return ProjectCompare(project_id=project_id, sessions=items, base=None, target=None,
                              metrics=[], labels=[], warnings=[], feedback=None)

    metrics, labels, _, _ = _compute(db, data, b, t)
    saved = db.scalar(select(SessionComparison).where(
        SessionComparison.base_session_id == b.session_id, SessionComparison.target_session_id == t.session_id))
    return ProjectCompare(
        project_id=project_id, sessions=items, base=b, target=t, metrics=metrics, labels=labels,
        warnings=cmp.model_warnings(db, b.session_id, t.session_id),
        feedback=_to_feedback(db, saved) if saved else None,
    )


@router.post("/{project_id}/compare/feedback", response_model=CompareFeedback)
@tracked("comparison", model=lambda: compare_feedback.MODEL)
def create_compare_feedback(
    project_id: int,
    base: int,
    # 실행 기록(analysis_events)은 이번 회차에 남긴다 — @tracked 가 session_id 라는 이름의 인자를 읽어서 이름을 맞춘다.
    session_id: int = Query(..., alias="target"),
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """AI 비교 피드백을 만든다 (GPT 호출, 보통 10~20초). 같은 두 회차로 다시 부르면 덮어쓴다."""
    get_owned_project(db, project_id, user_id)
    items, data = _project_sessions(db, project_id)
    b, t = _pick(items, base, session_id)
    metrics, labels, base_segs, target_segs = _compute(db, data, b, t)

    c = db.scalar(select(SessionComparison).where(
        SessionComparison.base_session_id == b.session_id, SessionComparison.target_session_id == t.session_id))
    if c is None:
        c = SessionComparison(project_id=project_id, base_session_id=b.session_id, target_session_id=t.session_id,
                              base_session_no=b.session_no, target_session_no=t.session_no, status="done")
        db.add(c)
    # 스냅샷에는 스크립트(전사문)를 빼고 숫자만 남긴다 — 용량이 크고 원본은 회차에 있다
    c.metrics_diff = metrics
    c.segment_alignment = [{k: v for k, v in l.items() if k not in ("base_segments", "target_segments")}
                           for l in labels]
    c.base_analyzed_at = cmp.analyzed_at(db, b.session_id)
    c.target_analyzed_at = cmp.analyzed_at(db, t.session_id)

    try:
        result = compare_feedback.run(
            metrics, labels,
            previous=cmp.feedback_digest(data[b.session_id]["summary"], base_segs),
            current=cmp.feedback_digest(data[t.session_id]["summary"], target_segs),
        )
    except Exception as e:
        logger.exception("비교 피드백 실패 (project=%s base=%s target=%s)", project_id, b.session_id, t.session_id)
        c.status, c.error, c.llm_feedback = "error", f"{type(e).__name__}: {e}"[:2000], None
        db.commit()
        raise HTTPException(502, "AI 비교 피드백을 만들지 못했어요. 잠시 후 다시 시도해 주세요.") from e

    c.status, c.error, c.llm_feedback = "done", None, result
    db.commit()
    db.refresh(c)
    return _to_feedback(db, c)


@router.get("/{project_id}/comparisons", response_model=list[ComparisonListItem])
def list_comparisons(
    project_id: int,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """이 폴더에서 만든 AI 비교 피드백 목록 (최신순)."""
    get_owned_project(db, project_id, user_id)
    rows = db.scalars(
        select(SessionComparison).where(SessionComparison.project_id == project_id)
        .order_by(SessionComparison.created_at.desc())
    ).all()
    return [ComparisonListItem(
        comparison_id=c.comparison_id, base_session_id=c.base_session_id, target_session_id=c.target_session_id,
        base_session_no=c.base_session_no, target_session_no=c.target_session_no, status=c.status,
        headline=(c.llm_feedback or {}).get("headline"), created_at=c.created_at,
    ) for c in rows]
