"""관리자 라우터 — 외부 API 연결 점검 + 분석 현황.

  GET  /admin/health              -> API 키 설정 여부 + 단계별 사용 모델
  POST /admin/health/{target}     -> 해당 모델에 짧은 요청 1건을 보내 응답 여부·시간 확인
  GET  /admin/analyses/stats      -> 최근 N일 단계별 실행 수·성공률·평균 소요 시간
  GET  /admin/analyses            -> 전체 회원의 세션 목록 + 단계별 최근 실행 결과
  GET  /admin/analyses/{id}       -> 세션 하나의 실행 기록 전체 + 분석 결과(영상 제외)

분석이 실패했을 때 "우리 코드 문제인지, Gemini/OpenAI 쪽 문제인지"를 실제 영상 없이
바로 가리기 위함이다. 단계마다 모델이 달라서(STEP2 영상 / STEP4 구간분리 / STEP5 피드백)
각각 따로 확인한다. 요청은 몇 토큰짜리라 비용은 무시할 수준.

전부 `require_admin` 으로 막는다. 일반 회원은 403.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DbSession

from app.api import sessions as session_routes
from app.api._deps import require_admin
from app.core.config import settings
from app.core.database import get_db
from app.models import AnalysisEvent, Project, Session, SessionSummary, User, VoiceRaw
from app.pipeline import step2_video_analysis, step4_segmentation, step5_feedback

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

Target = Literal["step2_gemini", "step3_modal", "step4_openai", "step5_openai"]

# 점검 대상 → (단계 설명, 제공자, 모델). 모델은 각 단계 모듈의 상수를 그대로 읽어
# 단계에서 모델을 바꾸면 점검도 자동으로 따라간다.
TARGETS: dict[str, tuple[str, str, str]] = {
    "step2_gemini": ("STEP 2 영상 분석", "gemini", step2_video_analysis.MODEL),
    # STEP 3 STT 는 WHISPER_MODEL 이 modal: 일 때 Modal 서버리스 GPU 에서 돈다 (stt_remote.py).
    "step3_modal": ("STEP 3 음성 인식 (STT)", "modal", settings.whisper_model),
    "step4_openai": ("STEP 4 구간 분리", "openai", step4_segmentation.MODEL),
    "step5_openai": ("STEP 5 피드백", "openai", step5_feedback.MODEL),
}

PING_PROMPT = "Reply with exactly: OK"
TIMEOUT_SEC = 30


class TargetInfo(BaseModel):
    target: str
    label: str
    provider: str
    model: str
    key_configured: bool


class HealthOverview(BaseModel):
    targets: list[TargetInfo]
    whisper_model: str   # STEP 3 STT 설정값. modal: 이면 Modal GPU, hf: 면 서버에서 직접 실행


class PingResult(BaseModel):
    target: str
    model: str
    ok: bool
    latency_ms: int
    reply: str | None = None
    error: str | None = None


def _key_for(provider: str) -> str:
    if provider == "modal":
        # 서버는 환경변수, 로컬 개발은 `modal token new` 가 만든 ~/.modal.toml
        has_token = bool(os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")) \
            or (Path.home() / ".modal.toml").exists()
        return "configured" if has_token else ""
    return settings.gemini_api_key if provider == "gemini" else settings.openai_api_key


@router.get("/health", response_model=HealthOverview)
def health_overview():
    return HealthOverview(
        targets=[
            TargetInfo(target=t, label=label, provider=provider, model=model,
                       key_configured=bool(_key_for(provider)))
            for t, (label, provider, model) in TARGETS.items()
        ],
        whisper_model=settings.whisper_model,
    )


def _ping_gemini(model: str) -> str:
    from google import genai

    client = genai.Client(api_key=settings.gemini_api_key)
    resp = client.models.generate_content(model=model, contents=PING_PROMPT)
    return (resp.text or "").strip()


def _ping_modal() -> str:
    """배포된 Modal 앱을 찾기만 한다 (토큰·배포 확인). GPU 는 켜지 않아 비용·대기 시간이 없다."""
    import modal

    from app.pipeline.voice.stt_remote import APP_NAME, CLASS_NAME

    modal.Cls.from_name(APP_NAME, CLASS_NAME).hydrate()
    note = "" if settings.whisper_model.startswith("modal:") else " (단, 지금 WHISPER_MODEL 은 Modal 이 아님)"
    return f"{APP_NAME} 배포 확인{note}"


def _ping_openai(model: str) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key, timeout=TIMEOUT_SEC, max_retries=0)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": PING_PROMPT}],
        max_tokens=5,
    )
    return (resp.choices[0].message.content or "").strip()


@router.post("/health/{target}", response_model=PingResult)
def ping(target: Target):
    """모델에 짧은 요청 1건. 실패해도 500 이 아니라 ok=false + 에러 문구로 돌려준다
    — 점검 화면에서는 "실패했다는 사실과 이유"가 곧 결과이기 때문."""
    _, provider, model = TARGETS[target]
    if not _key_for(provider):
        need = "MODAL_TOKEN_ID / MODAL_TOKEN_SECRET" if provider == "modal" else f"{provider.upper()}_API_KEY"
        raise HTTPException(400, f"{need} 가 서버에 설정되지 않았습니다.")

    t0 = time.perf_counter()
    try:
        if provider == "gemini":
            reply = _ping_gemini(model)
        elif provider == "modal":
            reply = _ping_modal()
        else:
            reply = _ping_openai(model)
        ok, error = True, None
    except Exception as exc:  # noqa: BLE001 — 어떤 오류든 화면에 그대로 보여준다
        reply, ok, error = None, False, f"{type(exc).__name__}: {exc}"[:500]
    latency_ms = int((time.perf_counter() - t0) * 1000)

    return PingResult(target=target, model=model, ok=ok, latency_ms=latency_ms,
                      reply=reply, error=error)


# ---------------------------------------------------------------------------
# 분석 현황 (analysis_events)
# ---------------------------------------------------------------------------

STEPS = ["preprocess", "motion", "voice", "segments", "segment_feedback", "overall_feedback"]


def _latest_run(evs: list[AnalysisEvent]) -> tuple[dict[str, AnalysisEvent], int | None, bool]:
    """세션의 **가장 최근 분석 1회분**을 고른다 → (단계별 최근 실행, 총 소요 ms, 끝까지 성공했는지).

    분석 1회는 전처리(/end)로 시작하므로 마지막 전처리 이후의 기록만 본다 (재분석하면 새 회차).
    총 소요 = 그 회차의 첫 단계 시작 ~ 마지막 단계 종료. 단계 시간을 더하지 않는 이유는
    동작·음성 분석처럼 **동시에 도는 단계**가 있어서 더하면 실제보다 길어지기 때문이다.
    아직 실행 중인 단계가 있으면 총 소요는 None.
    evs 는 시작 시각 순이어야 한다.
    """
    evs = [ev for ev in evs if ev.step in STEPS]   # 비교 피드백(comparison)은 분석 1회에 속하지 않는다
    if not evs:
        return {}, None, False
    starts = [i for i, ev in enumerate(evs) if ev.step == "preprocess"]
    run = evs[starts[-1]:] if starts else evs
    latest = {ev.step: ev for ev in run}             # 시간순으로 덮어쓰므로 마지막 = 최근
    complete = latest.get("overall_feedback") is not None and latest["overall_feedback"].status == "succeeded"
    if any(ev.finished_at is None for ev in latest.values()):
        return latest, None, complete
    begin = min(ev.started_at for ev in latest.values())
    end = max(ev.finished_at for ev in latest.values())
    return latest, int((end - begin).total_seconds() * 1000), complete


class StepStat(BaseModel):
    step: str
    runs: int
    succeeded: int
    partial: int
    failed: int
    running: int
    avg_ms: int | None


class AnalysisStats(BaseModel):
    days: int
    sessions: int          # 기간 안에 한 단계라도 실행된 세션 수
    completed: int         # 종합 피드백까지 성공한 세션 수
    failed_sessions: int   # 실패(또는 일부 실패)가 한 번이라도 있었던 세션 수
    avg_total_ms: int | None   # 끝까지 성공한 분석의 평균 총 소요 시간 (전처리 시작 ~ 종합 피드백 종료)
    steps: list[StepStat]


@router.get("/analyses/stats", response_model=AnalysisStats)
def analysis_stats(days: int = Query(7, ge=1, le=365), db: DbSession = Depends(get_db)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.execute(
        select(AnalysisEvent.step, AnalysisEvent.status, func.count(), func.avg(AnalysisEvent.duration_ms))
        .where(AnalysisEvent.started_at >= since)
        .group_by(AnalysisEvent.step, AnalysisEvent.status)
    ).all()

    agg: dict[str, dict] = {s: {"runs": 0, "succeeded": 0, "partial": 0, "failed": 0, "running": 0,
                                "ok_ms_sum": 0.0, "ok_n": 0} for s in STEPS}
    for step, status, n, avg_ms in rows:
        a = agg.setdefault(step, {"runs": 0, "succeeded": 0, "partial": 0, "failed": 0, "running": 0,
                                  "ok_ms_sum": 0.0, "ok_n": 0})
        a["runs"] += n
        if status in a:
            a[status] += n
        if status in ("succeeded", "partial") and avg_ms is not None:   # 평균 시간은 끝까지 돈 실행만
            a["ok_ms_sum"] += float(avg_ms) * n
            a["ok_n"] += n

    def distinct_sessions(*conds) -> int:
        return db.scalar(
            select(func.count(func.distinct(AnalysisEvent.session_id)))
            .where(AnalysisEvent.started_at >= since, AnalysisEvent.session_id.is_not(None), *conds)
        ) or 0

    by_session: dict[int, list[AnalysisEvent]] = {}
    for ev in db.scalars(
        select(AnalysisEvent)
        .where(AnalysisEvent.started_at >= since, AnalysisEvent.session_id.is_not(None))
        .order_by(AnalysisEvent.started_at)
    ):
        by_session.setdefault(ev.session_id, []).append(ev)
    totals = [t for _, t, done in (_latest_run(evs) for evs in by_session.values()) if done and t is not None]

    return AnalysisStats(
        days=days,
        sessions=distinct_sessions(),
        completed=distinct_sessions(AnalysisEvent.step == "overall_feedback", AnalysisEvent.status == "succeeded"),
        failed_sessions=distinct_sessions(AnalysisEvent.status.in_(["failed", "partial"])),
        avg_total_ms=int(sum(totals) / len(totals)) if totals else None,
        steps=[
            StepStat(step=step, runs=a["runs"], succeeded=a["succeeded"], partial=a["partial"],
                     failed=a["failed"], running=a["running"],
                     avg_ms=int(a["ok_ms_sum"] / a["ok_n"]) if a["ok_n"] else None)
            for step, a in agg.items()
        ],
    )


class StepRun(BaseModel):
    status: str
    duration_ms: int | None
    model: str | None
    error: str | None
    started_at: datetime


class AnalysisListItem(BaseModel):
    session_id: int
    session_no: int
    project_title: str
    user_email: str
    user_name: str | None          # 프로필 이름 (선택 입력이라 없을 수 있음)
    user_affiliation: str | None
    status: str
    created_at: datetime
    duration_sec: float | None
    last_run_at: datetime | None
    has_failure: bool
    total_ms: int | None           # 최근 분석 1회의 총 소요 시간 (실행 중이면 None)
    completed: bool                # 최근 분석이 종합 피드백까지 성공했는지
    steps: dict[str, StepRun]      # 최근 분석 1회의 단계별 실행


class AnalysisList(BaseModel):
    total: int
    items: list[AnalysisListItem]


def _to_run(ev: AnalysisEvent) -> StepRun:
    return StepRun(status=ev.status, duration_ms=ev.duration_ms, model=ev.model, error=ev.error,
                   started_at=ev.started_at)


@router.get("/analyses", response_model=AnalysisList)
def list_analyses(
    only_failed: bool = False,
    email: str | None = None,
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: DbSession = Depends(get_db),
):
    """전체 회원의 세션을 최신순으로. 휴지통에 들어간 프로젝트의 세션도 포함한다 (관리자 확인용)."""
    q = (
        select(Session, Project.title, User)
        .join(Project, Project.project_id == Session.project_id)
        .join(User, User.user_id == Project.user_id)
    )
    if email:   # 이메일 또는 이름으로 검색
        pattern = f"%{email.strip()}%"
        q = q.where(or_(User.email.ilike(pattern), User.display_name.ilike(pattern)))
    if only_failed:
        failed_ids = select(AnalysisEvent.session_id).where(AnalysisEvent.status.in_(["failed", "partial"]))
        q = q.where(Session.session_id.in_(failed_ids))

    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.execute(q.order_by(Session.created_at.desc()).limit(limit).offset(offset)).all()
    ids = [sess.session_id for sess, _, _ in rows]

    events: dict[int, list[AnalysisEvent]] = {}
    if ids:
        for ev in db.scalars(
            select(AnalysisEvent).where(AnalysisEvent.session_id.in_(ids)).order_by(AnalysisEvent.started_at)
        ):
            events.setdefault(ev.session_id, []).append(ev)
    durations = dict(db.execute(
        select(VoiceRaw.session_id, VoiceRaw.total_duration).where(VoiceRaw.session_id.in_(ids))
    ).all()) if ids else {}
    summaries = dict(db.execute(
        select(SessionSummary.session_id, SessionSummary.total_duration).where(SessionSummary.session_id.in_(ids))
    ).all()) if ids else {}

    items = []
    for sess, title, user in rows:
        evs = events.get(sess.session_id, [])
        latest, total_ms, completed = _latest_run(evs)
        items.append(AnalysisListItem(
            session_id=sess.session_id,
            session_no=sess.session_no,
            project_title=title,
            user_email=user.email,
            user_name=user.display_name,
            user_affiliation=user.affiliation,
            status=sess.status,
            created_at=sess.created_at,
            duration_sec=durations.get(sess.session_id) or summaries.get(sess.session_id),
            last_run_at=evs[-1].started_at if evs else None,
            has_failure=any(ev.status in ("failed", "partial") for ev in evs),
            total_ms=total_ms,
            completed=completed,
            steps={step: _to_run(ev) for step, ev in latest.items()},
        ))
    return AnalysisList(total=total, items=items)


@router.get("/analyses/{session_id}")
def analysis_detail(
    session_id: int,
    db: DbSession = Depends(get_db),
    admin_id: int = Depends(require_admin),
):
    """세션 하나의 실행 기록 전체 + 분석 결과.

    분석 결과는 사용자 대시보드가 쓰는 조회 함수를 **세션 주인 id 로 그대로 호출**해서 만든다
    → 사용자가 보는 것과 똑같은 데이터. 영상은 넣지 않는다 (얼굴·목소리가 담긴 원본이라 관리자 화면에서도 제외).
    누가 어떤 세션을 열람했는지는 로그로 남긴다.
    """
    row = db.execute(
        select(Session, Project.title, Project.user_id, Project.deleted_at, User)
        .join(Project, Project.project_id == Session.project_id)
        .join(User, User.user_id == Project.user_id)
        .where(Session.session_id == session_id)
    ).first()
    if row is None:
        raise HTTPException(404, "session not found")
    sess, title, owner_id, deleted_at, user = row
    logger.info("관리자 열람: admin=%s session=%s owner=%s", admin_id, session_id, owner_id)

    events = db.scalars(
        select(AnalysisEvent).where(AnalysisEvent.session_id == session_id).order_by(AnalysisEvent.started_at)
    ).all()

    latest, total_ms, completed = _latest_run(list(events))
    run = None
    if latest:
        begin = min(ev.started_at for ev in latest.values())
        run = {
            "started_at": begin,
            "total_ms": total_ms,
            "completed": completed,
            # 타임라인: 각 단계가 분석 시작 후 몇 ms 에 시작해서 얼마나 걸렸는지
            "steps": [
                {"step": ev.step, "status": ev.status,
                 "offset_ms": int((ev.started_at - begin).total_seconds() * 1000),
                 "duration_ms": ev.duration_ms}
                for ev in sorted(latest.values(), key=lambda e: e.started_at)
            ],
        }

    results: dict = {}
    if deleted_at is None:   # 휴지통 프로젝트는 사용자 조회 함수가 404 를 내므로 결과는 생략
        def call(name, fn):
            try:
                results[name] = fn(session_id=session_id, db=db, user_id=owner_id)
            except HTTPException as e:
                results[name] = None
                logger.warning("관리자 결과 조회 실패 %s: %s", name, e.detail)

        call("voice_summary", session_routes.get_voice_summary)
        call("overall", session_routes.get_overall_feedback)
        call("segments", session_routes.get_segment_feedback)
        call("motion", session_routes.get_session_analysis)
        call("script", session_routes.get_script)

    return {
        "session_id": sess.session_id,
        "session_no": sess.session_no,
        "project_title": title,
        "project_trashed": deleted_at is not None,
        "user_email": user.email,
        "user_name": user.display_name,
        "user_affiliation": user.affiliation,
        "status": sess.status,
        "created_at": sess.created_at,
        "run": run,
        "events": [
            {"event_id": ev.event_id, "step": ev.step, "status": ev.status, "model": ev.model,
             "duration_ms": ev.duration_ms, "error": ev.error, "detail": ev.detail,
             "started_at": ev.started_at, "finished_at": ev.finished_at}
            for ev in events
        ],
        "results": results,
    }
