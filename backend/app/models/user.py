from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String, UniqueConstraint, false, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    # 구글 로그인으로 만든 계정은 비밀번호가 없다(NULL). 이메일 가입은 없앴고,
    # 예전 이메일 계정과 개발용 계정만 값이 있다 — 비밀번호 로그인은 DEBUG 에서만 열린다.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 관리자 여부. 회원가입·API 로는 바꿀 수 없고 서버에서 `python -m app.scripts.set_admin`
    # 으로만 지정한다 — 화면에서 스스로 관리자가 되는 경로를 아예 두지 않기 위함.
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # 프로필 — 전부 선택 입력. 첫 로그인 직후 /profile 에서 받고, 건너뛰어도 된다.
    # 전화번호처럼 쓸 곳이 없는 정보는 일부러 받지 않는다 (개인정보 최소 수집).
    display_name: Mapped[str | None] = mapped_column(String(50), nullable=True)
    affiliation: Mapped[str | None] = mapped_column(String(100), nullable=True)   # 소속·학과(분야)
    purpose: Mapped[str | None] = mapped_column(String(20), nullable=True)        # 발표 목적 (schemas.auth.Purpose)
    # 프로필 화면을 한 번 거쳤는지(저장이든 건너뛰기든). NULL 이면 로그인 직후 프로필 화면으로 보낸다.
    profile_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    projects: Mapped[list["Project"]] = relationship(  # noqa: F821
        back_populates="user",
        cascade="all, delete-orphan",
    )
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )
    oauth_accounts: Mapped[list["OAuthAccount"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class OAuthAccount(Base):
    """소셜 로그인 연결 — (제공자, 제공자 쪽 사용자 id) 하나가 우리 회원 하나에 붙는다.

    이메일이 아니라 `subject`(구글의 sub)로 찾는다. 이메일은 사용자가 바꿀 수 있지만
    sub 는 그 구글 계정에 고정이다. 나중에 카카오·네이버를 붙여도 provider 값만 늘어난다.
    """

    __tablename__ = "oauth_accounts"
    __table_args__ = (UniqueConstraint("provider", "subject", name="uq_oauth_accounts_provider_subject"),)

    oauth_account_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)      # "google"
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 마지막 로그인 때의 이메일 (참고용)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped["User"] = relationship(back_populates="oauth_accounts")


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
