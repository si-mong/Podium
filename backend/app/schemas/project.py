from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.session import SessionRead


class ProjectCreate(BaseModel):
    title: str


class ProjectUpdate(BaseModel):
    title: str


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: int
    user_id: int
    title: str
    created_at: datetime
    sessions: list[SessionRead] = []
