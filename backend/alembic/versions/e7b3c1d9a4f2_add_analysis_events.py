"""add analysis_events

Revision ID: e7b3c1d9a4f2
Revises: d4f1a8c2b7e9
Create Date: 2026-10-18 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7b3c1d9a4f2'
down_revision: Union[str, None] = 'd4f1a8c2b7e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'analysis_events',
        sa.Column('event_id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('session_id', sa.BigInteger(), nullable=True),
        sa.Column('user_id', sa.BigInteger(), nullable=True),
        sa.Column('step', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('model', sa.String(length=128), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.session_id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['user_id'], ['users.user_id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('event_id'),
    )
    op.create_index(op.f('ix_analysis_events_session_id'), 'analysis_events', ['session_id'], unique=False)
    op.create_index(op.f('ix_analysis_events_user_id'), 'analysis_events', ['user_id'], unique=False)
    op.create_index(op.f('ix_analysis_events_started_at'), 'analysis_events', ['started_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_analysis_events_started_at'), table_name='analysis_events')
    op.drop_index(op.f('ix_analysis_events_user_id'), table_name='analysis_events')
    op.drop_index(op.f('ix_analysis_events_session_id'), table_name='analysis_events')
    op.drop_table('analysis_events')
