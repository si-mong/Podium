"""add outline to projects and sessions

Revision ID: c8e4a2f6d1b9
Revises: b5d2e8f1a3c7
Create Date: 2026-10-27 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c8e4a2f6d1b9'
down_revision: Union[str, None] = 'b5d2e8f1a3c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 발표 목차 (선택). 기존 프로젝트·회차는 NULL = 목차 없음 → 지금까지처럼 기본 라벨로 구간 분리.
    op.add_column('projects', sa.Column('outline', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('sessions', sa.Column('outline', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('sessions', 'outline')
    op.drop_column('projects', 'outline')
