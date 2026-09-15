"""add repetition columns and split speech rate into spm

Revision ID: b2e93e11bdc0
Revises: c1a7d3e9f204
Create Date: 2026-09-16 01:46:22.975529

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'b2e93e11bdc0'
down_revision: Union[str, None] = 'c1a7d3e9f204'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """반복(말더듬) 컬럼 추가 + 발화속도를 음절 기준 두 지표로 분리.

    wpm → speaking_rate_spm 은 **이름 변경(alter_column)** 으로 처리한다.
    autogenerate 는 drop + add 로 잡지만 그러면 기존 값이 사라진다.
    한국어는 어절(WPM)이 아니라 음절(SPM)이 안정적이라 이름을 바로잡는 것이고,
    데이터의 의미는 그대로이므로 보존해야 한다.
    """
    # --- 반복(말더듬) ---
    op.add_column("voice_raws", sa.Column("repetitions", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("segment_analyses", sa.Column("repetition_count", sa.Integer(), nullable=True))
    op.add_column("session_summaries", sa.Column("total_repetition_count", sa.Integer(), nullable=True))

    # --- 발화속도: 이름 변경 + 조음 속도 추가 ---
    op.alter_column("segment_analyses", "wpm", new_column_name="speaking_rate_spm")
    op.add_column("segment_analyses", sa.Column("articulation_rate_spm", sa.Float(), nullable=True))

    op.alter_column("session_summaries", "avg_wpm", new_column_name="avg_speaking_rate_spm")
    op.add_column("session_summaries", sa.Column("avg_articulation_rate_spm", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("session_summaries", "avg_articulation_rate_spm")
    op.alter_column("session_summaries", "avg_speaking_rate_spm", new_column_name="avg_wpm")
    op.drop_column("segment_analyses", "articulation_rate_spm")
    op.alter_column("segment_analyses", "speaking_rate_spm", new_column_name="wpm")

    op.drop_column("session_summaries", "total_repetition_count")
    op.drop_column("segment_analyses", "repetition_count")
    op.drop_column("voice_raws", "repetitions")
