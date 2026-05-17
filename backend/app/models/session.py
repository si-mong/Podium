from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Session(Base):
    __tablename__ = "sessions"

    session_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.project_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="processing")
    full_video_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    pdf_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    project: Mapped["Project"] = relationship(back_populates="sessions")  # noqa: F821
    chunks: Mapped[list["Chunk"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="Chunk.chunk_index",
    )
    stt_sentences: Mapped[list["SttSentence"]] = relationship(  # noqa: F821
        back_populates="session",
        cascade="all, delete-orphan",
    )
    voice_raw: Mapped["VoiceRaw | None"] = relationship(  # noqa: F821
        back_populates="session",
        cascade="all, delete-orphan",
        uselist=False,
    )
    segments: Mapped[list["Segment"]] = relationship(  # noqa: F821
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="Segment.t_start",
    )
    summary: Mapped["SessionSummary | None"] = relationship(  # noqa: F821
        back_populates="session",
        cascade="all, delete-orphan",
        uselist=False,
    )


class Chunk(Base):
    __tablename__ = "chunks"

    chunk_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    file_path: Mapped[str] = mapped_column(String(512), nullable=False)
    t_start: Mapped[float] = mapped_column(Float, nullable=False)
    t_end: Mapped[float] = mapped_column(Float, nullable=False)

    session: Mapped["Session"] = relationship(back_populates="chunks")
