"""replace chunk_analyses with video_analyses (session + time range)

영상분석 청크는 동작 시작 시점부터 자르는 동적 단위라, 30초 고정 업로드
단위인 chunks 와 경계가 맞지 않는다. chunk_id FK 를 떼고 session_id +
t_start/t_end 로 직접 시간 범위를 들게 한다 (stt_sentences 와 동일한 패턴).

STEP 4 집계가 어차피 시간 범위 기준이라 join 이 오히려 줄고, 재분석 시
session_id 로 지우고 다시 넣으면 되므로 stale 행 문제도 사라진다.

기존 chunk_analyses 데이터는 이관하지 않는다 (STEP 2 검증용 결과뿐이고,
청킹 정책이 바뀌어 시간 범위 의미가 달라졌으므로 재분석이 맞다).

Revision ID: c1a7d3e9f204
Revises: b856588e40a8
Create Date: 2026-08-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'c1a7d3e9f204'
down_revision: Union[str, None] = 'b856588e40a8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table('chunk_analyses')

    op.create_table(
        'video_analyses',
        sa.Column('analysis_id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('session_id', sa.BigInteger(), nullable=False),
        sa.Column('t_start', sa.Float(), nullable=False),
        sa.Column('t_end', sa.Float(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('posture', sa.String(length=32), nullable=True),
        sa.Column('eye_contact', sa.String(length=32), nullable=True),
        sa.Column('gesture', sa.String(length=32), nullable=True),
        sa.Column('gesture_counts', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.session_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('analysis_id'),
    )
    op.create_index(
        op.f('ix_video_analyses_session_id'), 'video_analyses', ['session_id'], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_video_analyses_session_id'), table_name='video_analyses')
    op.drop_table('video_analyses')

    op.create_table(
        'chunk_analyses',
        sa.Column('chunk_id', sa.BigInteger(), nullable=False),
        sa.Column('posture', sa.String(length=32), nullable=True),
        sa.Column('eye_contact', sa.String(length=32), nullable=True),
        sa.Column('gesture', sa.String(length=32), nullable=True),
        sa.Column('gesture_counts', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['chunk_id'], ['chunks.chunk_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('chunk_id'),
    )
