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
    whisper_model: str = "large-v3"


settings = Settings()
