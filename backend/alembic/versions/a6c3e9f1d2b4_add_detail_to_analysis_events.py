"""add detail to analysis_events

Revision ID: a6c3e9f1d2b4
Revises: f2a8d4c6b1e3
Create Date: 2026-10-27 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'a6c3e9f1d2b4'
down_revision: Union[str, None] = 'f2a8d4c6b1e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('analysis_events', sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('analysis_events', 'detail')
