"""add session_comparisons

Revision ID: b8d4f2a6c9e1
Revises: a6c3e9f1d2b4
Create Date: 2026-10-27 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b8d4f2a6c9e1'
down_revision: Union[str, None] = 'a6c3e9f1d2b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'session_comparisons',
        sa.Column('comparison_id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('base_session_id', sa.BigInteger(), nullable=True),
        sa.Column('target_session_id', sa.BigInteger(), nullable=True),
        sa.Column('base_session_no', sa.Integer(), nullable=False),
        sa.Column('target_session_no', sa.Integer(), nullable=False),
        sa.Column('metrics_diff', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('segment_alignment', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('llm_feedback', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('base_analyzed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('target_analyzed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.project_id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['base_session_id'], ['sessions.session_id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['target_session_id'], ['sessions.session_id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('comparison_id'),
        sa.UniqueConstraint('base_session_id', 'target_session_id', name='uq_session_comparisons_pair'),
    )
    op.create_index(op.f('ix_session_comparisons_project_id'), 'session_comparisons', ['project_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_session_comparisons_project_id'), table_name='session_comparisons')
    op.drop_table('session_comparisons')
