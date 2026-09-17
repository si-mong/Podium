"""인증 요청/응답 스키마.

회원가입 입력 규칙을 여기서 전부 강제한다. **로그인에는 같은 규칙을 걸지 않는다** —
정책이 바뀌어도 기존 사용자가 로그인하지 못하게 되는 일을 막기 위함이다.
"""
from datetime import datetime
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
)


# 길이 상한은 bcrypt 제약이 아니라 **요청 본문 폭주 방지**용이다.
# (bcrypt 72바이트 한계는 security.py 의 SHA-256 prehash 로 이미 해소)
_Password = Annotated[str, StringConstraints(min_length=8, max_length=128)]


def _reject_non_ascii_email(value: str) -> str:
    """이메일은 ASCII 주소만 허용.

    한글 도메인(`a@한국.kr`)과 한글 로컬파트(`한글@example.com`) 모두 거부한다.
    **도메인만 막으면 로컬파트로 우회된다.**

    punycode 로 적어 넣어도(`a@xn--3e0b707e.kr`) email-validator 가 유니코드로
    되돌리므로 이 검사에 함께 걸린다.
    """
    if not value.isascii():
        raise ValueError(
            "이메일에는 영문·숫자만 사용할 수 있습니다. (한글 등 비ASCII 주소 불가)"
        )
    return value


class SignupRequest(BaseModel):
    email: EmailStr
    password: _Password = Field(
        description="8~128자. 영문자·숫자·특수기호만 사용 가능하며 공백은 넣을 수 없음",
    )

    _check_email = field_validator("email")(_reject_non_ascii_email)

    @field_validator("password")
    @classmethod
    def _check_password_charset(cls, value: str) -> str:
        """출력 가능한 ASCII(0x21~0x7E)만 허용 — 영문자·숫자·특수기호.

        공백과 한글·이모지를 막는다. 공백을 따로 먼저 검사하는 이유는 **원인을 구분해
        알려주기 위함** — "허용되지 않는 문자"라고만 하면 사용자가 무엇을 지워야 할지 모른다.

        참고: 이 규칙 하나로 "공백 8칸"이 비밀번호로 통과하던 구멍도 함께 막힌다.
        """
        if any(ch.isspace() for ch in value):
            raise ValueError("비밀번호에 공백을 포함할 수 없습니다.")
        if not all("\x21" <= ch <= "\x7e" for ch in value):
            raise ValueError(
                "비밀번호는 영문자·숫자·특수기호만 사용할 수 있습니다. (한글·이모지 불가)"
            )
        return value


class LoginRequest(BaseModel):
    """로그인 입력.

    ⚠️ 비밀번호에 길이·문자 제약을 **일부러 걸지 않는다.** 가입 정책이 강화돼도
    그전에 가입한 사용자는 계속 로그인할 수 있어야 한다. 검증은 가입 시점의 일이다.
    """

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
    created_at: datetime
