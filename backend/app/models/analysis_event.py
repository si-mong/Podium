from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AnalysisEvent(Base):
    """분석 단계 실행 기록 — 단계 하나를 한 번 실행할 때마다 한 줄.

    관리자 화면에서 "어느 단계가 몇 초 걸렸고, 어디서 왜 실패했는지"를 보려고 남긴다.
    예전에는 이 정보가 서버 로그에만 찍히고 사라졌다.

    세션이나 회원이 지워져도 기록은 남긴다(SET NULL) — 실패 통계가 삭제로 사라지지 않게.
    """
    __tablename__ = "analysis_events"

    event_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("sessions.session_id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True, index=True
    )
    # preprocess / motion / voice / segments / segment_feedback / overall_feedback
    step: Mapped[str] = mapped_column(String(32), nullable=False)
    # running / succeeded / partial(일부 구간 실패) / failed
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 단계 안의 세부 시간 (예: 음성 분석의 무음 검출 / GPU 대기 / 인식 / 필러). 단계마다 키가 다르다.
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
