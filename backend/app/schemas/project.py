from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.schemas.session import SessionRead


# DB 컬럼이 String(255) 이라 그보다 길면 Postgres 단에서 터진다(500).
# 여기서 막아 422 로 돌려주고, 빈 제목도 함께 거른다.
_Title = Annotated[str, StringConstraints(min_length=1, max_length=255, strip_whitespace=True)]


class ProjectCreate(BaseModel):
    title: _Title


class ProjectUpdate(BaseModel):
    """제목 수정. 현재 프로젝트에서 사용자가 바꿀 수 있는 필드는 title 하나뿐."""

    title: _Title


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: int
    user_id: int
    title: str
    created_at: datetime


class ProjectWithSessions(ProjectRead):
    """프로젝트 + 소속 세션(연습 회차) 목록.

    목록 화면에서 "프로젝트마다 몇 회차 연습했는지"를 바로 보여주기 위해
    세션을 함께 내린다. 청크까지는 내리지 않는다(회차당 수십 개라 목록엔 과함) —
    청크가 필요하면 GET /sessions/{id} 를 쓸 것.
    """

    sessions: list[SessionRead] = []


class ProjectTrashItem(ProjectWithSessions):
    """휴지통 목록 항목.

    `sessions` 를 그대로 물려받는다 — 복원/영구삭제 확인창에서 "회차 N개가 함께
    처리됩니다" 를 보여주려면 개수가 필요하고, 프론트는 `sessions.length` 만 읽으면 된다.
    """

    deleted_at: datetime
