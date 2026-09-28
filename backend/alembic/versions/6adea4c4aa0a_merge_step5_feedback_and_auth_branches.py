"""merge step5 feedback and auth branches

Revision ID: 6adea4c4aa0a
Revises: 8b4499cd29e3, 8ee3b7ffaf70
Create Date: 2026-09-28 23:12:44.260972

main(로그인·휴지통 마이그레이션)과 feat/pipeline-step5(피드백 마이그레이션)가 둘 다
3a2c868476b7 에서 갈라져 head 가 두 개가 됐다. 그대로면 `alembic upgrade head` 가
"Multiple head revisions" 에러를 내므로, 양쪽 파일은 그대로 두고 두 갈래를 하나로 묶기만 한다.
DB 를 바꾸는 내용은 없다 (upgrade/downgrade 모두 비어 있음).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6adea4c4aa0a'
down_revision: Union[str, None] = ('8b4499cd29e3', '8ee3b7ffaf70')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
