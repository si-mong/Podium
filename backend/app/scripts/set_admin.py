"""관리자 지정/해제 — 서버에서만 실행한다.

    python -m app.scripts.set_admin user@example.com          # 관리자로 지정
    python -m app.scripts.set_admin user@example.com --revoke # 관리자 해제

운영(Docker)에서는:
    docker compose -f docker-compose.prod.yml exec api python -m app.scripts.set_admin user@example.com

관리자 권한은 API 로 열어두지 않는다. 서버 접속 권한이 있는 사람만 줄 수 있어야
"관리자가 관리자를 만든다"는 경로가 공격 대상이 되지 않는다.
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import User


def main() -> int:
    parser = argparse.ArgumentParser(description="관리자 지정/해제")
    parser.add_argument("email")
    parser.add_argument("--revoke", action="store_true", help="관리자 권한 해제")
    args = parser.parse_args()

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == args.email.lower()))
        if user is None:
            print(f"가입된 계정이 없습니다: {args.email} (먼저 회원가입하세요)")
            return 1
        user.is_admin = not args.revoke
        db.commit()
        print(f"{user.email}: {'관리자 해제' if args.revoke else '관리자 지정'} 완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
