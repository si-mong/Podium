"""인증 라우터 — 회원가입 / 로그인 / 갱신 / 로그아웃.

  POST /auth/signup    -> 계정 생성
  POST /auth/login     -> access + refresh 발급
  POST /auth/refresh   -> refresh 로 새 쌍 발급 (기존 refresh 는 폐기 = 회전)
  POST /auth/logout    -> refresh 무효화
  GET  /auth/me        -> 현재 로그인한 사용자

토큰 구조와 회전 근거는 app/core/security.py 모듈 주석 참고.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api._deps import get_current_user_id
from app.core.database import get_db
from app.core.security import (
    REFRESH_TYPE,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models import RefreshToken, User
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    SignupRequest,
    TokenPair,
    UserRead,
)


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=UserRead, status_code=201)
def signup(body: SignupRequest, db: DbSession = Depends(get_db)):
    """계정 생성. 토큰은 주지 않는다 — 이어서 /auth/login 을 호출할 것.

    이메일 중복은 409 로 돌려준다. `users.email` 에 UNIQUE 제약이 걸려 있어
    동시 요청이 겹쳐도 DB 가 최종 방어선이 된다.
    """
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(409, "이미 가입된 이메일입니다.")

    user = User(email=email, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenPair)
def login(body: LoginRequest, db: DbSession = Depends(get_db)):
    """이메일 + 비밀번호 → 토큰 쌍.

    이메일이 없든 비밀번호가 틀리든 **같은 401 문구**를 준다. 구분해서 알려주면
    "이 이메일은 가입돼 있다"는 사실이 새어나가 계정 열거에 쓰인다.
    """
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다.")

    return _issue_pair(db, user.user_id)


@router.post("/refresh", response_model=TokenPair)
def refresh(body: RefreshRequest, db: DbSession = Depends(get_db)):
    """refresh 토큰으로 새 쌍을 발급하고 **쓴 토큰은 즉시 폐기**한다(회전).

    회전을 하는 이유: refresh 는 오래 살기 때문에 탈취되면 피해가 길다. 한 번 쓰면
    죽게 해두면 탈취자와 정상 사용자 중 **한쪽만** 갱신에 성공하고, 다른 쪽은 401 을
    받아 재로그인하게 되어 이상 징후가 드러난다.
    """
    row = _consume_refresh(db, body.refresh_token)
    return _issue_pair(db, row.user_id)


@router.post("/logout", status_code=204)
def logout(body: RefreshRequest, db: DbSession = Depends(get_db)):
    """refresh 토큰을 무효화한다.

    ⚠️ **이미 발급된 access 토큰은 만료까지 계속 유효하다.** JWT 는 무상태라
    서버가 회수할 수 없기 때문 — 그래서 access 수명을 짧게(기본 60분) 잡았다.
    프론트는 로그아웃 시 저장해둔 access 토큰도 함께 버려야 한다.

    이미 폐기됐거나 형식이 틀린 토큰이어도 204 를 준다. 로그아웃은 "이 토큰이
    더는 안 통하게 해달라"는 요청이고, 그 상태는 어느 쪽이든 이미 달성돼 있다.
    """
    payload = decode_token(body.refresh_token, REFRESH_TYPE)
    if payload is None:
        return
    row = db.get(RefreshToken, payload.get("jti"))
    if row is not None and row.revoked_at is None:
        row.revoked_at = datetime.now(timezone.utc)
        db.commit()


@router.get("/me", response_model=UserRead)
def me(
    db: DbSession = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    return db.get(User, user_id)


# ---------------------------------------------------------------------------
# 내부 헬퍼
# ---------------------------------------------------------------------------

def _issue_pair(db: DbSession, user_id: int) -> TokenPair:
    access, expires_in = create_access_token(user_id)
    refresh_token, jti, expires_at = create_refresh_token(user_id)

    db.add(RefreshToken(jti=jti, user_id=user_id, expires_at=expires_at))
    db.commit()

    return TokenPair(
        access_token=access,
        refresh_token=refresh_token,
        expires_in=expires_in,
    )


def _consume_refresh(db: DbSession, token: str) -> RefreshToken:
    """refresh 토큰을 검증하고 폐기 표시까지 한 뒤 행을 반환. 실패는 전부 401."""
    invalid = HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "refresh 토큰이 유효하지 않습니다. 다시 로그인하세요.",
    )

    payload = decode_token(token, REFRESH_TYPE)   # 서명·만료·종류 검증
    if payload is None:
        raise invalid

    row = db.get(RefreshToken, payload.get("jti"))
    if row is None or row.revoked_at is not None:
        # 발급 기록이 없거나 이미 쓴 토큰 — 회전된 옛 토큰을 다시 쓴 경우가 여기 걸린다.
        raise invalid

    row.revoked_at = datetime.now(timezone.utc)
    db.commit()
    return row
