from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # App
    app_name: str = "Podium"
    debug: bool = False
    # 쉼표로 구분한 허용 origin 목록. 배포 시 .env 에 프론트 도메인을 넣는다.
    # 예: CORS_ORIGINS=https://podium.vercel.app,https://podium.example.com
    cors_origins: str = "http://localhost:3000,http://localhost:8001"

    # Database
    database_url: str = "postgresql+psycopg://podium:podium@localhost:5432/podium"

    # Auth
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    # access 토큰 수명. 짧을수록 탈취 피해가 줄지만 갱신 요청이 잦아진다.
    jwt_expire_minutes: int = 60
    # refresh 토큰 수명 = 로그인 유지 기간. 이 기간이 지나면 다시 로그인해야 한다.
    jwt_refresh_expire_days: int = 14

    # 구글 로그인 (Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID)
    google_client_id: str = ""
    google_client_secret: str = ""
    # 구글이 로그인 후 돌려보낼 주소를 만들 때 쓰는 이 API 서버의 외부 주소.
    # 프록시(Caddy) 뒤라 요청에서 추론하면 http 로 잡히므로 명시한다.
    api_public_url: str = "http://localhost:8000"
    # 로그인이 끝나면 돌려보낼 프론트 주소
    frontend_url: str = "http://localhost:3000"

    # Storage
    upload_dir: Path = Path("./uploads")

    # External APIs
    openai_api_key: str = ""
    gemini_api_key: str = ""      # STEP 2 VLM · STEP 4 구간분리
    # STEP 3 STT 모델. `hf:` 접두사면 transformers 런타임(비유창성 태그 O),
    # 그 외에는 faster-whisper(CTranslate2). 자세한 비교는
    # app/pipeline/step3_voice_analysis.py 모듈 주석 참고.
    whisper_model: str = "hf:rearleg/SeloWhisper-ko-disfluency"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
