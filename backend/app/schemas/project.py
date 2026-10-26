from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

from app.schemas.session import SessionRead


# DB 컬럼이 String(255) 이라 그보다 길면 Postgres 단에서 터진다(500).
# 여기서 막아 422 로 돌려주고, 빈 제목도 함께 거른다.
_Title = Annotated[str, StringConstraints(min_length=1, max_length=255, strip_whitespace=True)]


class ProjectCreate(BaseModel):
    title: _Title


# 목차 항목 하나는 구간 라벨(segments.label, String(32))로 저장되므로 30자까지.
OUTLINE_MAX_ITEMS = 12
OUTLINE_ITEM_MAX = 30


def clean_outline(items: list[str] | None) -> list[str] | None:
    """앞뒤 공백 제거, 빈 항목·중복 제거 (순서 유지). 남는 게 없으면 None = 목차 없음."""
    if items is None:
        return None
    out: list[str] = []
    for raw in items:
        item = " ".join(str(raw).split())
        if not item:
            continue
        if len(item) > OUTLINE_ITEM_MAX:
            raise ValueError(f"목차 항목은 {OUTLINE_ITEM_MAX}자까지 쓸 수 있어요: {item[:10]}…")
        if item not in out:
            out.append(item)
    if len(out) > OUTLINE_MAX_ITEMS:
        raise ValueError(f"목차는 {OUTLINE_MAX_ITEMS}개까지 넣을 수 있어요.")
    return out or None


class ProjectUpdate(BaseModel):
    """제목·목차 수정. 보낸 필드만 바꾼다. outline 에 [] 나 null 을 보내면 목차를 지운다."""

    title: _Title | None = None
    outline: list[str] | None = None

    _clean = field_validator("outline")(clean_outline)


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    project_id: int
    user_id: int
    title: str
    created_at: datetime
    outline: list[str] | None = None


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
