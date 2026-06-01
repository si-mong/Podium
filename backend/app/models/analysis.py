from sqlalchemy import BigInteger, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class SttSentence(Base):
    __tablename__ = "stt_sentences"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    t_start: Mapped[float] = mapped_column(Float, nullable=False)
    t_end: Mapped[float] = mapped_column(Float, nullable=False)

    session: Mapped["Session"] = relationship(back_populates="stt_sentences")  # noqa: F821


class VoiceRaw(Base):
    __tablename__ = "voice_raws"

    session_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        primary_key=True,
    )
    total_duration: Mapped[float] = mapped_column(Float, nullable=False)
    silence_segments: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    filler_words: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    session: Mapped["Session"] = relationship(back_populates="voice_raw")  # noqa: F821


class Segment(Base):
    __tablename__ = "segments"

    segment_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    t_start: Mapped[float] = mapped_column(Float, nullable=False)
    t_end: Mapped[float] = mapped_column(Float, nullable=False)
    slide_index: Mapped[int | None] = mapped_column(Integer, nullable=True)

    session: Mapped["Session"] = relationship(back_populates="segments")  # noqa: F821
    analysis: Mapped["SegmentAnalysis | None"] = relationship(
        back_populates="segment",
        cascade="all, delete-orphan",
        uselist=False,
    )
    feedback: Mapped["Feedback | None"] = relationship(
        back_populates="segment",
        cascade="all, delete-orphan",
        uselist=False,
    )


class SegmentAnalysis(Base):
    """구간(segment) 단위 종합 분석 결과.

    STEP 4(LLM 구간 분리) 후 청크 단위 결과(chunk_analyses)를 segment 시간 범위로 집계해 저장.
    """
    __tablename__ = "segment_analyses"

    segment_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("segments.segment_id", ondelete="CASCADE"),
        primary_key=True,
    )
    stt_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    wpm: Mapped[float | None] = mapped_column(Float, nullable=True)
    silence_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    filler_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # VLM 동작 분석 (구간 집계): 카테고리별 카운트 dict.
    # 키셋은 step2_video_analysis.py 의 카테고리 enum과 일치.
    gesture_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    posture_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    eye_contact_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    motion_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    segment: Mapped["Segment"] = relationship(back_populates="analysis")


class ChunkAnalysis(Base):
    """청크 단위 VLM 분석 결과 (캐시 역할).

    VLM 호출이 비싸므로 청크별 결과를 영구 저장. STEP 4 후 segment 시간 범위로
    집계해 SegmentAnalysis 에 옮겨짐. 회차별 청크 단위 비교에도 활용.
    """
    __tablename__ = "chunk_analyses"

    chunk_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("chunks.chunk_id", ondelete="CASCADE"),
        primary_key=True,
    )
    # semi-enum 자유 텍스트 (한정 옵션 — step2_video_analysis.py 프롬프트 참고)
    posture: Mapped[str | None] = mapped_column(String(32), nullable=True)
    eye_contact: Mapped[str | None] = mapped_column(String(32), nullable=True)
    gesture: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 정적 enum 카운트
    gesture_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    chunk: Mapped["Chunk"] = relationship(back_populates="analysis")  # noqa: F821


class Feedback(Base):
    __tablename__ = "feedbacks"

    segment_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("segments.segment_id", ondelete="CASCADE"),
        primary_key=True,
    )
    score_delivery: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_fluency: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_motion: Mapped[float | None] = mapped_column(Float, nullable=True)
    fb_delivery: Mapped[str | None] = mapped_column(Text, nullable=True)
    fb_fluency: Mapped[str | None] = mapped_column(Text, nullable=True)
    fb_motion: Mapped[str | None] = mapped_column(Text, nullable=True)
    fb_overall: Mapped[str | None] = mapped_column(Text, nullable=True)

    segment: Mapped["Segment"] = relationship(back_populates="feedback")


class SessionSummary(Base):
    __tablename__ = "session_summaries"

    session_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        primary_key=True,
    )
    total_duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    segment_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    overall_scores: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    total_filler_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    avg_wpm: Mapped[float | None] = mapped_column(Float, nullable=True)
    best_segment_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("segments.segment_id", ondelete="SET NULL"),
        nullable=True,
    )
    worst_segment_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("segments.segment_id", ondelete="SET NULL"),
        nullable=True,
    )

    session: Mapped["Session"] = relationship(back_populates="summary")  # noqa: F821
