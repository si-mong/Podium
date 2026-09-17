"""비밀번호 해싱 · JWT 발급/검증.

## 비밀번호
`bcrypt` 를 직접 쓴다. requirements 에 있던 `passlib` 은 1.7.4 이후 유지보수가
멈춰 bcrypt 5.x 와 호환이 깨졌다(`module 'bcrypt' has no attribute '__about__'`).

**bcrypt 는 72바이트까지만 본다.** 그 뒤는 조용히 잘리므로 긴 비밀번호의 뒷부분이
무시되는 보안 함정이 된다. 한글은 글자당 3바이트라 24자면 한계에 닿는다. 그래서
bcrypt 에 넣기 전에 **SHA-256 → base64** 로 한 번 접는다(항상 44바이트). 이렇게 하면
길이 제한이 사라지고 한글 비밀번호도 온전히 반영된다.

## 토큰
- **access**  — 짧게 산다. 모든 API 요청에 실려 가고 서버는 서명만 검증한다(무상태).
- **refresh** — 길게 살고 access 재발급에만 쓴다. `jti` 를 DB(`refresh_tokens`)에
  기록해 **로그아웃·회전 시 무효화**할 수 있게 한다. JWT 는 그 자체로는 취소가
  불가능하므로, 취소가 필요한 쪽만 상태를 갖는 구조다.

두 토큰은 payload 의 `type` 으로 구분한다. access 토큰으로 /auth/refresh 를 부르거나
그 반대를 하면 거부된다 — 구분이 없으면 탈취된 access 토큰이 무기한 갱신에 쓰인다.
"""
from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings


ACCESS_TYPE = "access"
REFRESH_TYPE = "refresh"
VIDEO_TYPE = "video"      # 영상 재생 전용 단기 티켓 — create_video_ticket 주석 참고

VIDEO_TICKET_TTL_SEC = 300


# ---------------------------------------------------------------------------
# 비밀번호
# ---------------------------------------------------------------------------

def _prehash(password: str) -> bytes:
    """bcrypt 72바이트 한계를 우회 — 길이와 무관하게 44바이트로 접는다."""
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_prehash(password), password_hash.encode("ascii"))
    except ValueError:
        # 해시 형식이 깨진 경우(수동 수정, dev 시드의 "!disabled" 등) — 로그인 실패 처리.
        return False


# ---------------------------------------------------------------------------
# 토큰
# ---------------------------------------------------------------------------

def _encode(payload: dict) -> str:
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: int) -> tuple[str, int]:
    """(토큰, 만료까지 남은 초) 반환. 초를 함께 주면 프론트가 갱신 시점을 잡기 쉽다."""
    expires_in = settings.jwt_expire_minutes * 60
    now = datetime.now(timezone.utc)
    token = _encode({
        "sub": str(user_id),
        "type": ACCESS_TYPE,
        "iat": now,
        "exp": now + timedelta(seconds=expires_in),
    })
    return token, expires_in


def create_refresh_token(user_id: int) -> tuple[str, str, datetime]:
    """(토큰, jti, 만료시각) 반환. jti 는 호출부가 DB 에 기록해 취소 가능하게 만든다."""
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=settings.jwt_refresh_expire_days)
    jti = uuid.uuid4().hex
    token = _encode({
        "sub": str(user_id),
        "type": REFRESH_TYPE,
        "jti": jti,
        "iat": now,
        "exp": expires_at,
    })
    return token, jti, expires_at


def decode_token(token: str, expected_type: str) -> dict | None:
    """서명·만료·종류를 모두 검증. 하나라도 어긋나면 None (호출부에서 401)."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    if not str(payload.get("sub", "")).isdigit():
        return None
    return payload


def create_video_ticket(user_id: int, session_id: int) -> tuple[str, int]:
    """영상 재생 전용 단기 토큰. (티켓, 남은 초) 반환.

    **왜 따로 필요한가.** `<video src="...">` 는 브라우저가 직접 요청을 보내므로
    Authorization 헤더를 붙일 수 없다. 그렇다고 access 토큰을 쿼리스트링에 실으면
    서버 로그·브라우저 기록·Referer 에 **모든 API 를 열 수 있는 열쇠**가 남는다.

    그래서 권한을 좁힌 티켓을 쓴다:
      - 수명 5분 (access 60분 대비)
      - `sid` 로 **특정 세션 하나**에만 유효 — 다른 세션 영상에는 못 쓴다
      - `type` 이 "video" 라 일반 API 인증에는 통하지 않는다

    URL 이 새어나가도 5분 뒤 죽고, 그 사이에도 해당 영상 하나만 열린다.
    """
    now = datetime.now(timezone.utc)
    token = _encode({
        "sub": str(user_id),
        "sid": session_id,
        "type": VIDEO_TYPE,
        "iat": now,
        "exp": now + timedelta(seconds=VIDEO_TICKET_TTL_SEC),
    })
    return token, VIDEO_TICKET_TTL_SEC
