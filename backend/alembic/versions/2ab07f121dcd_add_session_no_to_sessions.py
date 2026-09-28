"""add session_no to sessions

Revision ID: 2ab07f121dcd
Revises: 8b4499cd29e3
Create Date: 2026-09-21 01:57:30.745760

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2ab07f121dcd'
down_revision: Union[str, None] = '8b4499cd29e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 회차 번호(session_no): 프로젝트 안에서 "N회차 연습"의 N. 예전에는 목록 순서로 매겨서 앞 회차를 지우면
    # 뒤 회차 이름이 당겨졌다. 이제 DB 에 저장해서 다른 회차를 지워도 번호가 그대로 유지된다.
    # 이미 있는 행이 있어서 먼저 NULL 허용으로 추가 → 값 채우기 → NOT NULL 로 바꾼다.
    op.add_column('sessions', sa.Column('session_no', sa.Integer(), nullable=True))

    # 기존 세션은 지금 화면에서 보이는 이름 그대로 이어지게: 프로젝트 안에서 session_id 오름차순으로 1, 2, 3 ...
    op.execute(
        """
        UPDATE sessions
        SET session_no = numbered.rn
        FROM (
            SELECT session_id,
                   ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY session_id) AS rn
            FROM sessions
        ) AS numbered
        WHERE sessions.session_id = numbered.session_id
        """
    )

    op.alter_column('sessions', 'session_no', nullable=False)
    op.create_unique_constraint('uq_sessions_project_session_no', 'sessions', ['project_id', 'session_no'])


def downgrade() -> None:
    op.drop_constraint('uq_sessions_project_session_no', 'sessions', type_='unique')
    op.drop_column('sessions', 'session_no')
