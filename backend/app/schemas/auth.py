"""인증 요청/응답 스키마.

회원가입은 구글 로그인으로만 한다 (app/api/auth_google.py). 이메일 가입 스키마는 없앴다.
"""
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, StringConstraints, field_validator


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


# 발표 목적. 화면의 선택지와 같다 (frontend/src/app/profile/page.tsx 의 PURPOSES).
Purpose = Literal["class", "interview", "conference", "work", "other"]


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: int
    email: str
    is_admin: bool
    created_at: datetime
    display_name: str | None
    affiliation: str | None
    purpose: Purpose | None
    profile_completed_at: datetime | None


def _blank_to_none(value: str | None) -> str | None:
    """앞뒤 공백을 지우고, 비어 있으면 None — "지우기"와 "안 적음"을 같게 다룬다."""
    if value is None:
        return None
    value = value.strip()
    return value or None


class ProfileUpdate(BaseModel):
    """PATCH /auth/me 입력. 전부 선택이고, 보낸 필드만 바꾼다 (빈 문자열·null 은 지우기).

    빈 본문 {} 은 "건너뛰기" — 아무것도 안 바꾸고 프로필 화면을 거쳤다는 표시만 남긴다.
    """

    display_name: Annotated[str, StringConstraints(max_length=50)] | None = None
    affiliation: Annotated[str, StringConstraints(max_length=100)] | None = None
    purpose: Purpose | None = None

    _strip = field_validator("display_name", "affiliation")(_blank_to_none)
