from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession, selectinload

from app.api._dev_auth import get_current_user_id
from app.core.database import get_db
from app.models import Project
from app.schemas.project import ProjectCreate, ProjectRead, ProjectUpdate
from app.services import storage


router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectRead])
def list_projects(db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    return db.scalars(
        select(Project)
        .options(selectinload(Project.sessions))
        .where(Project.user_id == user_id)
        .order_by(Project.created_at.desc())
    ).all()


@router.post("", response_model=ProjectRead, status_code=201)
def create_project(body: ProjectCreate, db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    project = Project(user_id=user_id, title=body.title)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(project_id: int, body: ProjectUpdate, db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    project = db.scalar(
        select(Project).options(selectinload(Project.sessions)).where(Project.project_id == project_id)
    )
    if project is None or project.user_id != user_id:
        raise HTTPException(404, "project not found")

    project.title = body.title
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    project = db.get(Project, project_id)
    if project is None or project.user_id != user_id:
        raise HTTPException(404, "project not found")

    session_ids = [s.session_id for s in project.sessions]
    db.delete(project)  # cascade로 sessions/chunks/... 자동 삭제
    db.commit()
    for session_id in session_ids:
        storage.delete_session_files(session_id)
