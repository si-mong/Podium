"""임시 더미 인증.

인증 시스템 구현 전까지 모든 요청을 "dev 사용자"로 처리한다.
- 서버 시작 시 lifespan에서 ensure_dev_user()로 시드.
- get_current_user_id()는 항상 dev 사용자의 user_id를 반환.

★ 실제 인증(JWT) 구현하면 이 모듈을 제거하고 의존성을 교체할 것.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.core.database import SessionLocal
from app.models import User


DEV_USER_EMAIL = "dev@podium.local"


def ensure_dev_user() -> int:
    """dev 사용자가 없으면 생성하고 user_id 반환."""
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == DEV_USER_EMAIL))
        if user is None:
            user = User(email=DEV_USER_EMAIL, password_hash="!disabled")
            db.add(user)
            db.commit()
            db.refresh(user)
        return user.user_id


def get_current_user_id(db: DbSession) -> int:
    user = db.scalar(select(User).where(User.email == DEV_USER_EMAIL))
    if user is None:
        # lifespan에서 시드되므로 정상 흐름에서는 발생하지 않음.
        raise RuntimeError("dev user not seeded — restart server")
    return user.user_id
