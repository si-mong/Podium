"""add profile to users

Revision ID: b5d2e8f1a3c7
Revises: e7b3c1d9a4f2
Create Date: 2026-10-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b5d2e8f1a3c7'
down_revision: Union[str, None] = 'e7b3c1d9a4f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 전부 NULL 허용 — 기존 회원은 profile_completed_at 이 비어 있어 다음 로그인 때 프로필 화면을 한 번 본다.
    op.add_column('users', sa.Column('display_name', sa.String(length=50), nullable=True))
    op.add_column('users', sa.Column('affiliation', sa.String(length=100), nullable=True))
    op.add_column('users', sa.Column('purpose', sa.String(length=20), nullable=True))
    op.add_column('users', sa.Column('profile_completed_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'profile_completed_at')
    op.drop_column('users', 'purpose')
    op.drop_column('users', 'affiliation')
    op.drop_column('users', 'display_name')
