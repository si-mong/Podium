"""add is_admin to users

Revision ID: d4f1a8c2b7e9
Revises: a9aef3a4a5ca
Create Date: 2026-10-15 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4f1a8c2b7e9'
down_revision: Union[str, None] = 'a9aef3a4a5ca'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 기존 회원은 전부 일반 회원(false)으로 채워진다.
    op.add_column('users', sa.Column('is_admin', sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    op.drop_column('users', 'is_admin')
