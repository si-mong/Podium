"""rename session_summaries overall_scores to llm_feedback

Revision ID: ba342bb649d8
Revises: 868def7d88f9
Create Date: 2026-09-18 18:13:59.232173

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ba342bb649d8'
down_revision: Union[str, None] = '868def7d88f9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # rename — 기존 값 보존 (autogenerate 였으면 drop+add 로 잡아서 데이터가 날아감)
    op.alter_column('session_summaries', 'overall_scores', new_column_name='llm_feedback')


def downgrade() -> None:
    op.alter_column('session_summaries', 'llm_feedback', new_column_name='overall_scores')
