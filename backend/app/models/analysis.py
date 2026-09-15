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
    # 반복(말더듬). silence_segments / filler_words 와 같은 구조의 배열:
    # [{t_start, t_end, duration, kind("exact"|"stem"), count, text}, ...]
    repetitions: Mapped[list | None] = mapped_column(JSONB, nullable=True)

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

    STEP 4(LLM 구간 분리) 후 영상분석 결과(video_analyses)를 segment 시간 범위로 집계해 저장.
    """
    __tablename__ = "segment_analyses"

    segment_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("segments.segment_id", ondelete="CASCADE"),
        primary_key=True,
    )
    stt_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 한국어는 어절(WPM)이 아니라 **음절(SPM)** 기준. 띄어쓰기 정책에 따라 어절 수가
    # 크게 흔들리기 때문. 두 값을 나누면 "말은 빠른데 자주 멈춘다" 같은 진단이 가능:
    speaking_rate_spm: Mapped[float | None] = mapped_column(Float, nullable=True)      # 무음 포함
    articulation_rate_spm: Mapped[float | None] = mapped_column(Float, nullable=True)  # 무음 제외
    silence_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    filler_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    repetition_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # VLM 동작 분석 (구간 집계): 카테고리별 카운트 dict.
    # 키셋은 step2_video_analysis.py 의 카테고리 enum과 일치.
    gesture_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    posture_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    eye_contact_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    motion_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    segment: Mapped["Segment"] = relationship(back_populates="analysis")


class VideoAnalysis(Base):
    """영상분석(STEP 2 VLM) 결과 — 스마트 청크 1개당 1행.

    청크 단위를 `chunks`(30초 고정 업로드 단위)에 매달지 않고 t_start/t_end 로
    직접 들고 있다. 영상분석은 동작 시작 시점부터 자르는 동적 청킹이라
    업로드 격자와 경계가 일치하지 않기 때문. 음성분석이 나중에 다른 윈도우를
    쓰더라도 서로 영향받지 않는다. (stt_sentences 와 동일한 패턴)

    VLM 호출이 비싸므로 영구 저장하고, STEP 4 후 segment 시간 범위로 집계해
    SegmentAnalysis 로 옮긴다. 재분석 시 session_id 로 전체 삭제 후 재삽입.
    """
    __tablename__ = "video_analyses"

    analysis_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 원본 영상(full_video.webm) 기준 시간 범위.
    t_start: Mapped[float] = mapped_column(Float, nullable=False)
    t_end: Mapped[float] = mapped_column(Float, nullable=False)
    # 청킹 종류: intro / motion / outro (step2_chunking.SmartChunk.kind)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)

    # semi-enum 자유 텍스트 (한정 옵션 — step2_video_analysis.py 프롬프트 참고)
    posture: Mapped[str | None] = mapped_column(String(32), nullable=True)
    eye_contact: Mapped[str | None] = mapped_column(String(32), nullable=True)
    gesture: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 정적 enum 카운트 (_GESTURE_KEYS 7종)
    gesture_counts: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    session: Mapped["Session"] = relationship(back_populates="video_analyses")  # noqa: F821


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
    total_repetition_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    avg_speaking_rate_spm: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_articulation_rate_spm: Mapped[float | None] = mapped_column(Float, nullable=True)
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
