"""merge gesture timelines and auth branches

Revision ID: a9aef3a4a5ca
Revises: 6adea4c4aa0a, bf3493c04c16
fe-dashboard 에서 가져온 회차번호·제스처 마이그레이션(2ab07f121dcd → c9368cd4e173 → bf3493c04c16)이
8b4499cd29e3 에서 이어지는데, 같은 지점에서 main(로그인) 쪽도 6adea4c4aa0a 로 합쳐져 있어서 head 가 두 개가 됐다.
양쪽 파일은 그대로 두고 두 갈래를 하나로 묶기만 한다. DB 를 바꾸는 내용은 없다.

Create Date: 2026-09-28 23:25:51.532957

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a9aef3a4a5ca'
down_revision: Union[str, None] = ('6adea4c4aa0a', 'bf3493c04c16')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
