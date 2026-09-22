from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    projects: Mapped[list["Project"]] = relationship(  # noqa: F821
        back_populates="user",
        cascade="all, delete-orphan",
    )
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class RefreshToken(Base):
    """발급된 refresh 토큰의 흔적 — 취소(로그아웃/회전)를 가능하게 하는 유일한 장치.

    토큰 본문은 저장하지 않는다. JWT 는 서명돼 있어 위조가 불가능하므로 **식별자(jti)만**
    있으면 "이 토큰은 더 못 쓴다"를 판정할 수 있다. 본문을 DB 에 두면 유출 시 그대로
    로그인 수단이 되므로 오히려 위험하다.

    revoked_at 이 채워지면 그 토큰은 죽는다. 회전(refresh 1회 사용 후 폐기)과
    로그아웃 모두 이 컬럼을 쓴다.
    """

    __tablename__ = "refresh_tokens"

    jti: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.user_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped["User"] = relationship(back_populates="refresh_tokens")
