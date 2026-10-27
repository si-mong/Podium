"""구글 로그인 (OAuth 2.0 Authorization Code + PKCE).

  GET  /auth/google/login     -> 구글 로그인 화면으로 보냄
  GET  /auth/google/callback  -> 구글이 돌려보내는 곳. 회원을 찾거나 만들고 프론트로 돌려보냄
  POST /auth/oauth/exchange   -> 프론트가 받은 1회용 코드를 우리 토큰 쌍(access + refresh)으로 교환

흐름
  1. 프론트 "구글로 계속하기" → 브라우저가 /auth/google/login 으로 이동
  2. 여기서 state·PKCE 값을 만들어 **서명된 쿠키**에 넣고 구글로 보냄
  3. 구글 로그인 후 /auth/google/callback?code=..&state=.. 로 돌아옴
     → 쿠키의 state 와 비교(CSRF 방지) → code 를 구글 토큰으로 교환 → 이메일·sub 확인
  4. 회원을 찾거나 만들고, **60초짜리 1회용 코드**를 만들어 프론트 /auth/callback#code=.. 로 보냄
  5. 프론트가 그 코드로 /auth/oauth/exchange 를 불러 평소와 같은 토큰 쌍을 받는다

왜 토큰을 바로 URL 에 싣지 않나: 주소창·방문 기록에 오래 사는 refresh 토큰이 남는다.
1회용 코드는 60초 안에 한 번만 쓸 수 있고, `#` 뒤(fragment)라 서버 로그·Referer 에도 안 남는다.

회원 연결 규칙
  - (google, sub) 로 연결된 회원이 있으면 그 회원
  - 없으면 같은 이메일의 기존 회원(예전 이메일 가입)에 연결 — 구글이 확인한 이메일만 허용
  - 그것도 없으면 새 회원 (비밀번호 없음)
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.auth import _issue_pair
from app.core.config import settings
from app.core.database import get_db
from app.models import OAuthAccount, User
from app.schemas.auth import TokenPair

router = APIRouter(tags=["auth"])

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

STATE_COOKIE = "podium_oauth"
STATE_TTL_SEC = 600          # 구글 로그인 화면에서 머무를 수 있는 시간
LOGIN_CODE_TTL_SEC = 60
HTTP_TIMEOUT_SEC = 10


# ---------------------------------------------------------------------------
# 서명된 단기 토큰 (state 쿠키 / 1회용 로그인 코드)
# ---------------------------------------------------------------------------

def _sign(payload: dict, ttl_sec: int) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({**payload, "iat": now, "exp": now + timedelta(seconds=ttl_sec)},
                      settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _verify(token: str | None, expected_type: str) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    return payload if payload.get("type") == expected_type else None


# 1회용 코드 재사용 방지. uvicorn 워커가 1개라 프로세스 메모리로 충분하다
# (워커를 늘리면 DB 나 Redis 로 옮겨야 함). 코드는 60초면 어차피 만료된다.
_used_codes: dict[str, float] = {}
_used_lock = threading.Lock()


def _mark_used(jti: str) -> bool:
    """처음 쓰는 코드면 True. 이미 쓴 코드면 False."""
    now = time.time()
    with _used_lock:
        for k, t in list(_used_codes.items()):
            if now - t > LOGIN_CODE_TTL_SEC * 2:
                del _used_codes[k]
        if jti in _used_codes:
            return False
        _used_codes[jti] = now
        return True


# ---------------------------------------------------------------------------
# 라우터
# ---------------------------------------------------------------------------

def _safe_next(next_path: str | None) -> str:
    """로그인 후 갈 프론트 경로. 다른 사이트로 튀는 오픈 리다이렉트를 막으려고 '/경로'만 허용."""
    if next_path and next_path.startswith("/") and not next_path.startswith("//"):
        return next_path
    return "/dashboard"


def _redirect_uri() -> str:
    return f"{settings.api_public_url.rstrip('/')}/auth/google/callback"


def _to_frontend(path: str, fragment: dict) -> RedirectResponse:
    resp = RedirectResponse(f"{settings.frontend_url.rstrip('/')}{path}#{urlencode(fragment, quote_via=quote)}")
    resp.delete_cookie(STATE_COOKIE, path="/auth/google")
    return resp


def _fail(message: str) -> RedirectResponse:
    return _to_frontend("/login", {"error": message})


@router.get("/auth/google/login")
def google_login(next: str | None = None):
    if not (settings.google_client_id and settings.google_client_secret):
        raise HTTPException(503, "구글 로그인이 아직 설정되지 않았습니다 (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).")

    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)   # PKCE: code 가 새어도 이 값 없이는 토큰으로 못 바꾼다
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()

    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": _redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",        # 여러 구글 계정이 있으면 고르게
    }
    resp = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")
    resp.set_cookie(
        STATE_COOKIE,
        _sign({"type": "oauth_state", "state": state, "verifier": verifier, "next": _safe_next(next)}, STATE_TTL_SEC),
        max_age=STATE_TTL_SEC,
        httponly=True,
        secure=settings.api_public_url.startswith("https"),
        samesite="lax",                   # 구글에서 돌아오는 최상위 GET 이동에는 실린다
        path="/auth/google",
    )
    return resp


@router.get("/auth/google/callback")
def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: DbSession = Depends(get_db),
):
    if error:   # 사용자가 구글 화면에서 취소한 경우 등
        return _fail("구글 로그인이 취소됐어요." if error == "access_denied" else f"구글 로그인 실패: {error}")

    saved = _verify(request.cookies.get(STATE_COOKIE), "oauth_state")
    if saved is None or not state or not secrets.compare_digest(saved["state"], state):
        return _fail("로그인 요청이 만료됐거나 올바르지 않아요. 다시 시도해주세요.")
    if not code:
        return _fail("구글에서 로그인 정보를 받지 못했어요.")

    try:
        with httpx.Client(timeout=HTTP_TIMEOUT_SEC) as client:
            tok = client.post(GOOGLE_TOKEN_URL, data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
                "code_verifier": saved["verifier"],
            })
            tok.raise_for_status()
            # 토큰 엔드포인트에서 TLS 로 직접 받은 access token 으로 userinfo 를 조회 → 별도 서명 검증 불필요
            info = client.get(GOOGLE_USERINFO_URL,
                              headers={"Authorization": f"Bearer {tok.json()['access_token']}"})
            info.raise_for_status()
            profile = info.json()
    except (httpx.HTTPError, KeyError, ValueError):
        return _fail("구글 서버와 통신하지 못했어요. 잠시 후 다시 시도해주세요.")

    sub, email = profile.get("sub"), (profile.get("email") or "").lower()
    if not sub or not email or not profile.get("email_verified"):
        return _fail("구글 계정의 이메일이 확인되지 않아 로그인할 수 없어요.")

    user = _find_or_create_user(db, sub, email)
    login_code = _sign({"type": "login_code", "sub": str(user.user_id), "jti": uuid.uuid4().hex}, LOGIN_CODE_TTL_SEC)
    return _to_frontend("/auth/callback", {"code": login_code, "next": saved["next"]})


def _find_or_create_user(db: DbSession, sub: str, email: str) -> User:
    link = db.scalar(select(OAuthAccount).where(OAuthAccount.provider == "google", OAuthAccount.subject == sub))
    if link is not None:
        link.email = email
        db.commit()
        return link.user

    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, password_hash=None)
        db.add(user)
        db.flush()
    db.add(OAuthAccount(user_id=user.user_id, provider="google", subject=sub, email=email))
    db.commit()
    db.refresh(user)
    return user


class ExchangeRequest(BaseModel):
    code: str


@router.post("/auth/oauth/exchange", response_model=TokenPair)
def exchange_login_code(body: ExchangeRequest, db: DbSession = Depends(get_db)):
    payload = _verify(body.code, "login_code")
    if payload is None or not str(payload.get("sub", "")).isdigit() or not _mark_used(payload["jti"]):
        raise HTTPException(401, "로그인 코드가 만료됐거나 이미 사용됐어요. 다시 로그인해주세요.")
    user_id = int(payload["sub"])
    if db.get(User, user_id) is None:
        raise HTTPException(401, "계정을 찾을 수 없어요. 다시 로그인해주세요.")
    return _issue_pair(db, user_id)
