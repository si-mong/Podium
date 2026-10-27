"""분석 단계 실행 기록 (analysis_events).

분석 라우터에 `@tracked("voice", model=...)` 를 붙이면 실행할 때마다 시작·종료·소요 시간·
성공 여부·에러 메시지(응답에 `timings` 가 있으면 세부 시간도)가 한 줄 남는다. 관리자 화면(GET /admin/analyses)이 이 기록을 읽는다.

원칙
- **기록 때문에 분석이 실패하면 안 된다.** 기록 쓰기가 실패하면 경고 로그만 남기고 넘어간다.
- 요청의 DB 세션과 **별도 세션**으로 쓴다. 분석이 예외로 끝나 요청 트랜잭션이 롤백돼도 실패 기록은 남아야 한다.
- 본인 세션일 때만 기록한다. 남의 세션 번호로 찔러본 404 요청까지 실패로 쌓이면 통계가 오염된다.
"""
from __future__ import annotations

import functools
import logging
import time
from datetime import datetime, timezone
from typing import Callable

from fastapi import HTTPException

from app.core.database import SessionLocal
from app.models import AnalysisEvent, Project, Session

logger = logging.getLogger(__name__)

ERROR_MAX_CHARS = 2000


def _start(session_id: int | None, user_id: int | None, step: str, model: str | None) -> int | None:
    if session_id is None or user_id is None:
        return None
    db = SessionLocal()
    try:
        owner = db.query(Project.user_id).join(Session, Session.project_id == Project.project_id) \
            .filter(Session.session_id == session_id).scalar()
        if owner != user_id:
            return None
        ev = AnalysisEvent(session_id=session_id, user_id=user_id, step=step, status="running", model=model)
        db.add(ev)
        db.commit()
        return ev.event_id
    except Exception:  # noqa: BLE001
        logger.warning("analysis_events 시작 기록 실패 (session=%s step=%s)", session_id, step, exc_info=True)
        return None
    finally:
        db.close()


def _finish(event_id: int | None, status: str, error: str | None, t0: float, detail: dict | None = None) -> None:
    if event_id is None:
        return
    db = SessionLocal()
    try:
        ev = db.get(AnalysisEvent, event_id)
        if ev is not None:
            ev.status = status
            ev.error = error[:ERROR_MAX_CHARS] if error else None
            ev.duration_ms = int((time.perf_counter() - t0) * 1000)
            ev.finished_at = datetime.now(timezone.utc)
            ev.detail = detail
            db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("analysis_events 종료 기록 실패 (event=%s)", event_id, exc_info=True)
    finally:
        db.close()


def _partial_error(result) -> str | None:
    """구간별 피드백처럼 일부만 실패해도 200 으로 끝나는 응답에서 실패 구간을 찾는다."""
    if not isinstance(result, dict):
        return None
    failed = [s for s in result.get("segments") or [] if isinstance(s, dict) and s.get("error")]
    if not failed:
        return None
    detail = "; ".join(f"{s.get('title') or s.get('segment_id')}: {s['error']}" for s in failed[:3])
    return f"구간 {len(failed)}개 실패 — {detail}"


def _detail(result) -> dict | None:
    """응답에 `timings`(단계 안 세부 시간)가 있으면 기록에 같이 남긴다. 지금은 음성 분석만."""
    timings = result.get("timings") if isinstance(result, dict) else getattr(result, "timings", None)
    return timings if isinstance(timings, dict) else None


def tracked(step: str, model: Callable[[], str | None] | None = None):
    """분석 라우터용 데코레이터. 라우터는 `session_id`, `user_id` 키워드 인자를 받아야 한다.

    model: 실행 시점에 사용 모델을 돌려주는 함수 (설정이 바뀌면 그대로 따라가도록 lazy).
    """
    def deco(fn):
        @functools.wraps(fn)   # FastAPI 가 원래 함수의 시그니처(의존성)를 그대로 읽도록
        def wrapper(*args, **kwargs):
            try:
                model_name = model() if model else None
            except Exception:  # noqa: BLE001
                model_name = None
            event_id = _start(kwargs.get("session_id"), kwargs.get("user_id"), step, model_name)
            t0 = time.perf_counter()
            try:
                result = fn(*args, **kwargs)
            except HTTPException as e:
                _finish(event_id, "failed", f"HTTP {e.status_code}: {e.detail}", t0)
                raise
            except Exception as e:
                _finish(event_id, "failed", f"{type(e).__name__}: {e}", t0)
                raise
            partial = _partial_error(result)
            _finish(event_id, "partial" if partial else "succeeded", partial, t0, _detail(result))
            return result
        return wrapper
    return deco
