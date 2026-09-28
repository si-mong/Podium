"""add gesture_timelines to segment_analyses

Revision ID: bf3493c04c16
Revises: c9368cd4e173
Create Date: 2026-09-22 23:17:47.057106

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'bf3493c04c16'
down_revision: Union[str, None] = 'c9368cd4e173'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'segment_analyses',
        sa.Column('gesture_timelines', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('segment_analyses', 'gesture_timelines')
