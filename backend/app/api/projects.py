"""프로젝트 라우터.

  POST   /projects                  -> 생성
  GET    /projects                  -> 내 프로젝트 목록 (세션 포함, 휴지통 제외)
  PATCH  /projects/{id}             -> 제목 수정
  DELETE /projects/{id}             -> **휴지통으로 이동** (복원 가능)
  GET    /projects/trash            -> 휴지통 목록
  POST   /projects/{id}/restore     -> 휴지통에서 복원
  DELETE /projects/{id}/purge       -> 영구 삭제 (DB + 파일, 복구 불가)

휴지통 설계는 app/models/project.py 의 deleted_at 주석 참고.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession, selectinload

from app.api._deps import get_current_user_id, get_owned_project
from app.core.database import get_db
from app.models import Project
from app.schemas.project import (
    ProjectCreate,
    ProjectRead,
    ProjectTrashItem,
    ProjectUpdate,
    ProjectWithSessions,
)
from app.services import storage


router = APIRouter(prefix="/projects", tags=["projects"])


# ---------------------------------------------------------------------------
# 목록 / 생성
# ---------------------------------------------------------------------------

@router.get("", response_model=list[ProjectWithSessions])
def list_projects(
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """내 프로젝트 목록. 각 프로젝트의 세션(회차)을 최신순으로 함께 반환.

    휴지통에 있는 프로젝트는 제외된다 — 보려면 GET /projects/trash.
    """
    return db.scalars(
        select(Project)
        .options(selectinload(Project.sessions))
        .where(Project.user_id == user_id, Project.deleted_at.is_(None))
        .order_by(Project.created_at.desc())
    ).all()


@router.post("", response_model=ProjectRead, status_code=201)
def create_project(
    body: ProjectCreate,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    project = Project(user_id=user_id, title=body.title)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


# ---------------------------------------------------------------------------
# 휴지통
#
# ★ 라우트 순서 주의: "/trash" 는 "/{project_id}" 보다 **먼저** 선언돼야 한다.
#   FastAPI 는 등록 순서대로 매칭하므로 반대면 "trash" 가 project_id 로 먹힌다.
#   (지금은 GET /projects/{id} 가 없어 충돌하지 않지만, 나중에 추가될 때를 대비)
# ---------------------------------------------------------------------------

@router.get("/trash", response_model=list[ProjectTrashItem])
def list_trash(
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """휴지통에 있는 프로젝트를 **버린 순서(최신순)** 로 반환."""
    return db.scalars(
        select(Project)
        .options(selectinload(Project.sessions))
        .where(Project.user_id == user_id, Project.deleted_at.is_not(None))
        .order_by(Project.deleted_at.desc())
    ).all()


@router.post("/{project_id}/restore", response_model=ProjectRead)
def restore_project(
    project_id: int,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """휴지통에서 꺼낸다. 하위 세션도 함께 다시 보이게 된다.

    이미 정상 상태인 프로젝트에 호출해도 200 을 준다 — 되돌리는 동작이라
    관대하게 처리한다(더블클릭·중복 요청에 안전). 파괴적인 /purge 는 반대로 엄격하다.
    """
    project = get_owned_project(db, project_id, user_id, include_trashed=True)
    project.deleted_at = None
    db.commit()
    db.refresh(project)
    return project


# ---------------------------------------------------------------------------
# 수정 / 삭제
# ---------------------------------------------------------------------------

@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    project_id: int,
    body: ProjectUpdate,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """제목 수정. 현재 수정 가능한 필드는 title 뿐이다.

    세션·분석 결과에는 영향을 주지 않는다 — 프로젝트는 회차를 묶는 이름표일 뿐.
    """
    project = get_owned_project(db, project_id, user_id)
    project.title = body.title
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
def trash_project(
    project_id: int,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """프로젝트를 휴지통으로 보낸다. **데이터는 지우지 않는다.**

    하위 세션에는 아무 표시도 하지 않는다 — 부모가 휴지통이면 자동으로 가려지고,
    이렇게 해야 복원 시 "원래 개별 삭제됐던 세션"이 되살아나지 않는다.

    완전히 없애려면 휴지통에서 DELETE /projects/{id}/purge.
    """
    project = get_owned_project(db, project_id, user_id)
    project.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.delete("/{project_id}/purge", status_code=204)
def purge_project(
    project_id: int,
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    """영구 삭제. 프로젝트와 **하위 세션 전부**를 지운다. 되돌릴 수 없다.

    **휴지통에 있는 프로젝트만** 지울 수 있다. 실수로 이 엔드포인트를 직접 부르는 것을
    막기 위한 장치 — 정상 프로젝트를 없애려면 휴지통을 반드시 거쳐야 한다.

    DB 는 CASCADE 로 정리되지만 업로드 파일은 FK 를 타지 않으므로 직접 지운다.
    세션 id 를 먼저 확보하는 이유: db.delete() 이후에는 관계가 비어 경로를 알 수 없다.
    DB 커밋 → 파일 삭제 순서는 DELETE /sessions/{id} 와 동일 (반대면 커밋 실패 시 파일만 유실).
    """
    project = get_owned_project(db, project_id, user_id, with_sessions=True, include_trashed=True)
    if project.deleted_at is None:
        raise HTTPException(
            400,
            "휴지통에 있는 프로젝트만 영구 삭제할 수 있습니다. "
            "먼저 DELETE /projects/{id} 로 휴지통에 넣으세요.",
        )

    session_ids = [s.session_id for s in project.sessions]

    db.delete(project)   # cascade로 sessions/chunks/segments/... 자동 삭제
    db.commit()

    for session_id in session_ids:
        storage.delete_session_files(session_id)
