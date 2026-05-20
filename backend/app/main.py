from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import projects, sessions
from app.api._dev_auth import ensure_dev_user
from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    ensure_dev_user()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(sessions.router)


@app.get("/health")
def health():
    return {"status": "ok"}


# DEBUG 모드일 때만 _legacy 프론트엔드를 /legacy 로 서빙 (전처리 동작 검증용).
# 사용: 브라우저에서 http://localhost:8000/legacy/?project=<project_id>
# Next.js 본 프론트엔드가 촬영 페이지를 만들면 이 mount는 제거.
if settings.debug:
    _legacy_dir = Path(__file__).resolve().parents[2] / "_legacy" / "frontend"
    if _legacy_dir.exists():
        app.mount(
            "/legacy",
            StaticFiles(directory=str(_legacy_dir), html=True),
            name="legacy",
        )
