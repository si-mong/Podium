from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Project(Base):
    __tablename__ = "projects"

    project_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.user_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # 휴지통. NULL = 정상, 값 있음 = 휴지통에 있음(= 조회에서 가려짐).
    # 행을 실제로 지우지 않으므로 복원이 가능하다. 영구 삭제는 DELETE .../purge.
    #
    # ★ 프로젝트를 휴지통에 넣을 때 **하위 세션에는 아무것도 찍지 않는다.**
    #   찍으면 복원 시 "원래 개별 삭제됐던 세션"까지 되살아난다. 세션이 보이는지는
    #   부모의 이 컬럼으로 판단한다 (app/api/_deps.py).
    #
    # 보관 기간(예: 30일 후 자동 영구삭제)은 아직 구현하지 않았다. 이 컬럼만 있으면
    # 언제든 배치로 계산 가능하다.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    user: Mapped["User"] = relationship(back_populates="projects")  # noqa: F821
    sessions: Mapped[list["Session"]] = relationship(  # noqa: F821
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Session.created_at.desc()",   # 최근 회차부터 — 목록 화면 기본 정렬
    )
