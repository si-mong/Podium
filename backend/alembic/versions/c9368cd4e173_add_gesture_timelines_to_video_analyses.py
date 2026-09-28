"""add gesture_timelines to video_analyses

Revision ID: c9368cd4e173
Revises: 2ab07f121dcd
Create Date: 2026-09-22 23:10:46.696452

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'c9368cd4e173'
down_revision: Union[str, None] = '2ab07f121dcd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'video_analyses',
        sa.Column('gesture_timelines', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('video_analyses', 'gesture_timelines')
