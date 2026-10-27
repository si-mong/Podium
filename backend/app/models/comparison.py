from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SessionComparison(Base):
    """AI 비교 피드백 (두 회차 비교의 ③ 피드백 이행 추적) — 회차 쌍 하나당 한 줄.

    지표 비교(①)·구간 비교(②)는 저장된 분석 결과로 그때그때 계산하고, LLM 을 부르는 ③ 만 저장한다.
    ①·② 도 생성 당시 값을 스냅샷으로 같이 남긴다 — 회차를 지우거나 재분석해도 당시 비교를 그대로 볼 수 있게.
    회차가 지워지면 그 칸만 비운다(SET NULL). 폴더가 영구 삭제되면 같이 지운다(CASCADE).

    base/target_analyzed_at: 생성할 때 두 회차의 마지막 분석 완료 시각. 지금 값과 다르면
    재분석된 것이므로 화면에서 "다시 만들기" 를 띄운다 (app/services/compare.py 의 analyzed_at).
    """
    __tablename__ = "session_comparisons"
    __table_args__ = (UniqueConstraint("base_session_id", "target_session_id", name="uq_session_comparisons_pair"),)

    comparison_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("projects.project_id", ondelete="CASCADE"), nullable=False, index=True
    )
    base_session_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("sessions.session_id", ondelete="SET NULL"), nullable=True
    )
    target_session_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("sessions.session_id", ondelete="SET NULL"), nullable=True
    )
    # 회차가 지워져도 목록에 "2회차 → 3회차" 로 보이도록 번호를 따로 남긴다
    base_session_no: Mapped[int] = mapped_column(Integer, nullable=False)
    target_session_no: Mapped[int] = mapped_column(Integer, nullable=False)
    metrics_diff: Mapped[list | None] = mapped_column(JSONB, nullable=True)        # ① 스냅샷
    segment_alignment: Mapped[list | None] = mapped_column(JSONB, nullable=True)   # ② 스냅샷 (스크립트 제외)
    llm_feedback: Mapped[dict | None] = mapped_column(JSONB, nullable=True)        # ③ {headline, items}
    base_analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    target_analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # done / error (생성은 요청 안에서 끝까지 기다리므로 processing 상태는 두지 않는다)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
