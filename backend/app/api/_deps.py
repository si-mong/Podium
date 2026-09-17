"""라우터 공용 의존성 — 인증 + 소유권 검사.

## 인증
`get_current_user_id` 가 `Authorization: Bearer <access_token>` 헤더를 검증해
user_id 를 돌려준다. 토큰이 없거나 틀리면 401. 라우터는 이 값을 소유권 검사에 넘긴다.

## 소유권
프로젝트/세션은 **전부 "내 것인지" 확인한 뒤에만** 만진다. 검사 로직이 라우터마다
복제되면 한 곳만 고쳐지는 사고가 나므로 여기로 모은다.

없는 리소스와 남의 리소스를 **둘 다 404** 로 처리하는 것이 규칙이다. 403 을 주면
"그 id 는 존재한다"는 사실이 새어나간다. (인증 실패 401 과는 구분된다 — 401 은
"당신이 누군지 모르겠다", 404 는 "그런 건 없다")

**휴지통에 있는 프로젝트도 404 다.** 휴지통 전용 라우트(목록/복원/영구삭제)만
include_trashed=True 로 열어준다. 세션은 자기 deleted_at 을 갖지 않고 **부모
프로젝트의 상태를 따른다** — 프로젝트가 휴지통이면 그 하위 세션도 전부 가려진다.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession, selectinload

from app.core.database import get_db
from app.core.security import ACCESS_TYPE, decode_token
from app.models import Project, Session, User


# auto_error=False: 헤더가 없을 때 FastAPI 기본 403 대신 우리 401 을 주기 위함.
# 인증이 안 된 것은 403(권한 없음)이 아니라 401(신원 미확인)이다.
_bearer = HTTPBearer(auto_error=False, description="POST /auth/login 으로 받은 access_token")


def get_current_user_id(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: DbSession = Depends(get_db),
) -> int:
    unauthorized = HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "인증이 필요합니다.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if credentials is None:
        raise unauthorized

    payload = decode_token(credentials.credentials, ACCESS_TYPE)
    if payload is None:
        raise unauthorized

    user_id = int(payload["sub"])
    # 토큰은 유효한데 계정이 지워진 경우 — 서명만 믿으면 유령 사용자가 API 를 쓴다.
    if db.get(User, user_id) is None:
        raise unauthorized
    return user_id


def get_owned_project(
    db: DbSession,
    project_id: int,
    user_id: int,
    *,
    with_sessions: bool = False,
    include_trashed: bool = False,
) -> Project:
    opts = [selectinload(Project.sessions)] if with_sessions else []
    project = db.scalar(
        select(Project).options(*opts).where(Project.project_id == project_id)
    )
    if project is None or project.user_id != user_id:
        raise HTTPException(404, "project not found")
    if project.deleted_at is not None and not include_trashed:
        # 휴지통에 있는 건 "없는 것"과 똑같이 취급. 복원 전에는 수정도 촬영도 불가.
        raise HTTPException(404, "project not found")
    return project


def get_owned_session(
    db: DbSession,
    session_id: int,
    user_id: int,
    *,
    with_chunks: bool = False,
) -> Session:
    opts = [selectinload(Session.project)]
    if with_chunks:
        opts.append(selectinload(Session.chunks))
    session = db.scalar(
        select(Session).options(*opts).where(Session.session_id == session_id)
    )
    if session is None or session.project.user_id != user_id:
        raise HTTPException(404, "session not found")
    if session.project.deleted_at is not None:
        # 부모가 휴지통이면 세션도 가려진다 (세션 자체엔 deleted_at 이 없다).
        raise HTTPException(404, "session not found")
    return session
