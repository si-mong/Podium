"""add oauth_accounts, make users.password_hash nullable

Revision ID: f2a8d4c6b1e3
Revises: e7b3c1d9a4f2
Create Date: 2026-10-23 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2a8d4c6b1e3'
down_revision: Union[str, None] = 'e7b3c1d9a4f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 구글 로그인 계정은 비밀번호가 없다.
    op.alter_column('users', 'password_hash', existing_type=sa.String(length=255), nullable=True)
    op.create_table(
        'oauth_accounts',
        sa.Column('oauth_account_id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('provider', sa.String(length=32), nullable=False),
        sa.Column('subject', sa.String(length=255), nullable=False),
        sa.Column('email', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.user_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('oauth_account_id'),
        sa.UniqueConstraint('provider', 'subject', name='uq_oauth_accounts_provider_subject'),
    )
    op.create_index(op.f('ix_oauth_accounts_user_id'), 'oauth_accounts', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_oauth_accounts_user_id'), table_name='oauth_accounts')
    op.drop_table('oauth_accounts')
    # 되돌릴 때 비밀번호 없는(구글) 계정이 있으면 NOT NULL 로 못 바꾼다 → 로그인 불가 값으로 채운다.
    op.execute("UPDATE users SET password_hash = '!oauth-only' WHERE password_hash IS NULL")
    op.alter_column('users', 'password_hash', existing_type=sa.String(length=255), nullable=False)
