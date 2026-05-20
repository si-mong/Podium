from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api._dev_auth import get_current_user_id
from app.core.database import get_db
from app.models import Project
from app.schemas.project import ProjectCreate, ProjectRead


router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectRead])
def list_projects(db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    return db.scalars(
        select(Project).where(Project.user_id == user_id).order_by(Project.created_at.desc())
    ).all()


@router.post("", response_model=ProjectRead, status_code=201)
def create_project(body: ProjectCreate, db: DbSession = Depends(get_db)):
    user_id = get_current_user_id(db)
    project = Project(user_id=user_id, title=body.title)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project
