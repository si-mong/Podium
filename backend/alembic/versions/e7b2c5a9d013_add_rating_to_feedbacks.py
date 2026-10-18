"""add rating to feedbacks

Revision ID: e7b2c5a9d013
Revises: d4f1a8c2b7e9
Create Date: 2026-10-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7b2c5a9d013'
down_revision: Union[str, None] = 'd4f1a8c2b7e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # STEP 5 구간 등급(잘함/보통/개선필요) — 화면의 스티커용
    op.add_column('feedbacks', sa.Column('rating', sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column('feedbacks', 'rating')
