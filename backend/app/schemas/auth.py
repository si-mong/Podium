"""인증 요청/응답 스키마.

회원가입은 구글 로그인으로만 한다 (app/api/auth_google.py). 이메일 가입 스키마는 없앴다.
"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr


class LoginRequest(BaseModel):
    """이메일 로그인 입력 — 로컬 개발(DEBUG)에서만 쓴다. 예전 계정·개발용 계정 확인용."""

    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenPair(BaseModel):
    """로그인·갱신 공통 응답.

    refresh 는 **한 번 쓰면 폐기**되고 새 값이 내려온다(회전). 프론트는 응답을 받을
    때마다 저장해둔 refresh 를 교체해야 한다 — 옛 값으로 다시 부르면 401 이다.
    """

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int          # access 토큰이 만료되기까지 남은 초


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: int
    email: str
    is_admin: bool
    created_at: datetime
