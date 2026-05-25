"""세션 라이프사이클 라우터.

흐름:
  POST /projects/{project_id}/sessions/start    -> 빈 세션 생성
  POST /sessions/{id}/chunks?chunk_index=N      -> 30초 webm 청크 업로드 (반복)
  POST /sessions/{id}/video                     -> 전체 연속 webm 업로드 (Stop 시 1회)
  POST /sessions/{id}/end                       -> 오디오 추출 + concat (전처리만 완료)
  POST /sessions/{id}/analyze/motion            -> STEP 2 VLM 동작 분석 (별도 호출)
  GET    /sessions/{id}                         -> 메타 + 청크 목록
  DELETE /sessions/{id}                         -> 세션 (DB + 파일) 삭제
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession, selectinload

from app.api._dev_auth import get_current_user_id
from app.core.database import get_db
from app.models import Chunk, ChunkAnalysis, Project, Session
from app.pipeline.step1_preprocess import concat_audio, extract_chunk_audio, probe_duration
from app.schemas.session import (
    MotionAnalysisResult,
    PreprocessResult,
    SessionDetail,
    SessionRead,
    UploadResult,
)
from app.services import storage


CHUNK_DURATION_SEC = 30


router = APIRouter(tags=["sessions"])


# ---------------------------------------------------------------------------
# 생성
# ---------------------------------------------------------------------------

@router.post(
    "/projects/{project_id}/sessions/start",
    response_model=SessionRead,
    status_code=201,
)
def start_session(project_id: int, db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)

    project = db.get(Project, project_id)
    if project is None or project.user_id != user_id:
        raise HTTPException(404, "project not found")

    session = Session(project_id=project_id, status="recording")
    db.add(session)
    db.commit()
    db.refresh(session)

    storage.init_session_dirs(session.session_id)
    return session


# ---------------------------------------------------------------------------
# 업로드
# ---------------------------------------------------------------------------

@router.post("/sessions/{session_id}/chunks", response_model=UploadResult)
async def upload_chunk(
    session_id: int,
    chunk_index: int,
    file: UploadFile = File(...),
    db: DbSession = Depends(get_db),
):
    session = _get_owned_session(db, session_id)

    path = storage.chunk_path(session_id, chunk_index)
    data = await file.read()
    size = storage.write_bytes(path, data)

    # 같은 chunk_index 재업로드(네트워크 재시도 등) 시 기존 행 갱신.
    existing = db.scalar(
        select(Chunk).where(
            Chunk.session_id == session_id, Chunk.chunk_index == chunk_index
        )
    )
    rel_path = str(path.relative_to(_settings_upload_dir()))
    if existing is None:
        db.add(Chunk(
            session_id=session_id,
            chunk_index=chunk_index,
            file_path=rel_path,
            t_start=chunk_index * CHUNK_DURATION_SEC,
            t_end=(chunk_index + 1) * CHUNK_DURATION_SEC,
        ))
    else:
        existing.file_path = rel_path
    db.commit()

    return UploadResult(size_bytes=size)


@router.post("/sessions/{session_id}/video", response_model=UploadResult)
async def upload_full_video(
    session_id: int,
    file: UploadFile = File(...),
    db: DbSession = Depends(get_db),
):
    session = _get_owned_session(db, session_id)

    path = storage.full_video_path(session_id)
    data = await file.read()
    size = storage.write_bytes(path, data)

    session.full_video_path = str(path.relative_to(_settings_upload_dir()))
    db.commit()

    return UploadResult(size_bytes=size)


# ---------------------------------------------------------------------------
# 전처리 종료 (오디오 추출 + concat)
# ---------------------------------------------------------------------------

@router.post("/sessions/{session_id}/end", response_model=PreprocessResult)
def end_session(session_id: int, db: DbSession = Depends(get_db)):
    session = _get_owned_session(db, session_id)

    chunks = db.scalars(
        select(Chunk).where(Chunk.session_id == session_id).order_by(Chunk.chunk_index)
    ).all()
    if not chunks:
        raise HTTPException(400, "no chunks uploaded")

    upload_dir = _settings_upload_dir()
    wav_paths = []
    chunk_webm_paths = []
    for c in chunks:
        webm = upload_dir / c.file_path
        wav = storage.chunk_audio_path(session_id, c.chunk_index)
        extract_chunk_audio(webm, wav)
        wav_paths.append(wav)
        chunk_webm_paths.append(webm)

    full_audio = storage.full_audio_path(session_id)
    concat_audio(wav_paths, full_audio)
    total_duration = probe_duration(full_audio)

    # STEP 2 VLM 호출은 분리된 라우터(/analyze/motion)에서 수행.
    # /end 는 전처리만 책임지므로 응답 시간 짧고 timeout 위험 없음.
    session.status = "preprocessed"
    db.commit()

    return PreprocessResult(
        session_id=session_id,
        status=session.status,
        full_audio_path=str(full_audio.relative_to(upload_dir)),
        total_duration_sec=total_duration,
        chunk_count=len(chunks),
    )


# ---------------------------------------------------------------------------
# STEP 2: VLM 동작 분석 (별도 호출, /end 이후)
# ---------------------------------------------------------------------------

@router.post(
    "/sessions/{session_id}/analyze/motion",
    response_model=MotionAnalysisResult,
)
def analyze_motion(session_id: int, db: DbSession = Depends(get_db)):
    """청크 영상에 대해 VLM 동작 분석을 수행하고 chunk_analyses 테이블에 저장.

    /end (전처리) 이후 호출. 비싼 호출이라 idempotent하지 않음 — 호출당 Gemini 청구 발생.
    재호출 시 기존 chunk_analyses 행은 덮어씀.
    """
    session = _get_owned_session(db, session_id)
    if session.status not in ("preprocessed", "analyzed"):
        raise HTTPException(400, f"session status must be preprocessed (got {session.status!r}); call /end first")

    chunks = db.scalars(
        select(Chunk).where(Chunk.session_id == session_id).order_by(Chunk.chunk_index)
    ).all()
    if not chunks:
        raise HTTPException(400, "no chunks uploaded")

    upload_dir = _settings_upload_dir()
    chunk_paths = [upload_dir / c.file_path for c in chunks]

    # lazy import — google-genai 가 미설치된 환경에서도 API 서버는 정상 동작.
    from app.pipeline import step2_video_analysis

    result = step2_video_analysis.run(
        session_id=session_id,
        chunk_paths=chunk_paths,
        output_dir=storage.session_dir(session_id),
    )

    # VLM 결과를 chunk_analyses 에 저장 (UPSERT — 같은 chunk_id 재호출 시 덮어씀).
    # result["VLM_segment_result"] 의 인덱스 i 가 chunks[i] 와 대응.
    vlm_items = result.get("VLM_segment_result", [])
    for chunk, item in zip(chunks, vlm_items):
        existing = db.get(ChunkAnalysis, chunk.chunk_id)
        fields = dict(
            posture=item.get("posture"),
            eye_contact=item.get("eye_contact"),
            gesture=item.get("gesture"),
            gesture_counts=item.get("gesture_counts"),
            notes=item.get("notes"),
        )
        if existing is None:
            db.add(ChunkAnalysis(chunk_id=chunk.chunk_id, **fields))
        else:
            for k, v in fields.items():
                setattr(existing, k, v)

    session.status = "analyzed"
    db.commit()

    return MotionAnalysisResult(
        session_id=session_id,
        status=session.status,
        chunk_count=len(chunks),
        analyzed_count=len(vlm_items),
        json_output_path=str((storage.session_dir(session_id) / "vlm_analysis.json").relative_to(upload_dir)),
    )


# ---------------------------------------------------------------------------
# VLM 분석 결과 조회
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}/analysis")
def get_session_analysis(session_id: int, db: DbSession = Depends(get_db)):
    """세션의 VLM 분석 결과를 청크별로 반환."""
    session = _get_owned_session(db, session_id)

    chunks = db.scalars(
        select(Chunk).where(Chunk.session_id == session_id).order_by(Chunk.chunk_index)
    ).all()

    analyses = []
    for chunk in chunks:
        ca = db.get(ChunkAnalysis, chunk.chunk_id)
        if ca is not None:
            analyses.append({
                "chunk_index": chunk.chunk_index,
                "t_start": chunk.t_start,
                "t_end": chunk.t_end,
                "posture": ca.posture,
                "eye_contact": ca.eye_contact,
                "gesture": ca.gesture,
                "notes": ca.notes,
                "gesture_counts": ca.gesture_counts,
            })

    return {"session_id": session_id, "status": session.status, "analyses": analyses}


# ---------------------------------------------------------------------------
# 조회 / 삭제
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(session_id: int, db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    session = db.scalar(
        select(Session)
        .options(selectinload(Session.chunks), selectinload(Session.project))
        .where(Session.session_id == session_id)
    )
    if session is None or session.project.user_id != user_id:
        raise HTTPException(404, "session not found")
    return session


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: int, db: DbSession = Depends(get_db)):
    session = _get_owned_session(db, session_id)
    db.delete(session)  # cascade로 chunks/segments/... 자동 삭제
    db.commit()
    storage.delete_session_files(session_id)


# ---------------------------------------------------------------------------
# 내부 헬퍼
# ---------------------------------------------------------------------------

def _get_owned_session(db: DbSession, session_id: int) -> Session:
    user_id = get_current_user_id(db)
    session = db.scalar(
        select(Session)
        .options(selectinload(Session.project))
        .where(Session.session_id == session_id)
    )
    if session is None or session.project.user_id != user_id:
        raise HTTPException(404, "session not found")
    return session


def _settings_upload_dir():
    # config의 upload_dir이 Path임을 보장. 매 호출 가져와 테스트 시 패치 쉬움.
    from app.core.config import settings
    return settings.upload_dir
