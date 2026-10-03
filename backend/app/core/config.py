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
    # access 토큰 수명. 짧을수록 탈취 피해가 줄지만 갱신 요청이 잦아진다.
    jwt_expire_minutes: int = 60
    # refresh 토큰 수명 = 로그인 유지 기간. 이 기간이 지나면 다시 로그인해야 한다.
    jwt_refresh_expire_days: int = 14

    # Storage
    upload_dir: Path = Path("./uploads")

    # External APIs
    openai_api_key: str = ""
    gemini_api_key: str = ""      # STEP 2 VLM · STEP 4 구간분리
    # STEP 5 피드백 LLM. 모델 비교 테스트용 — .env 에서 바꾸고 서버를 재시작하면 적용된다.
    # provider: "gemini" 또는 "openai" / model: 그 회사의 모델 이름 (예: gemini-2.5-pro, gpt-4o)
    step5_provider: str = "gemini"
    step5_model: str = "gemini-2.5-flash"
    # STEP 3 STT 모델. `hf:` 접두사면 transformers 런타임(비유창성 태그 O),
    # 그 외에는 faster-whisper(CTranslate2). 자세한 비교는
    # app/pipeline/step3_voice_analysis.py 모듈 주석 참고.
    whisper_model: str = "hf:rearleg/SeloWhisper-ko-disfluency"
    # STEP 3 를 GPU 서버에 맡길 때 그 서버 주소 (예: http://10.198.138.104:18002).
    # 비워두면 지금처럼 이 컴퓨터에서 직접 돌린다. 서버 코드는 gpu_server/stt_server.py.
    stt_remote_url: str = ""


settings = Settings()
