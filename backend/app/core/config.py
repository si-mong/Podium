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

    # Database
    database_url: str = "postgresql+psycopg://podium:podium@localhost:5432/podium"

    # Auth
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24

    # Storage
    upload_dir: Path = Path("./uploads")

    # External APIs
    openai_api_key: str = ""
    # STEP 3 STT 모델. `hf:` 접두사면 transformers 런타임(비유창성 태그 O),
    # 그 외에는 faster-whisper(CTranslate2). 자세한 비교는
    # app/pipeline/step3_voice_analysis.py 모듈 주석 참고.
    whisper_model: str = "hf:rearleg/SeloWhisper-ko-disfluency"


settings = Settings()
