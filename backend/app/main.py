from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import auth, media, projects, sessions
from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # :3000 은 본 프론트엔드. :8001 은 devtools(STEP 실행/조회 테스트 페이지)가
    # 브라우저에서 직접 이 서버를 호출하기 위함 — devtools 자체는 DB 를 안 만짐.
    allow_origins=["http://localhost:3000", "http://localhost:8001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(sessions.router)

# 업로드된 영상/오디오 파일을 프론트엔드에서 직접 재생할 수 있도록 서빙.
# 예: uploads/1/full_video.webm -> http://localhost:8000/media/1/full_video.webm
# media.router 는 Range 요청(영상 특정 시각으로 이동)을 지원하고, 아래 StaticFiles 보다 먼저 매칭된다.
# StaticFiles 는 하위 폴더 파일(예: chunks/chunk_001.webm)을 위해 남겨둔다.
# ⚠️ TODO(로그인 연동 때): 여기는 로그인 확인이 없어서 세션 번호만 알면 누구나 영상을 볼 수 있다.
#    대시보드를 GET /sessions/{id}/video + 재생 티켓(sessions.py)으로 바꾼 뒤 이 두 줄(media)을 지울 것.
app.include_router(media.router)
settings.upload_dir.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(settings.upload_dir)), name="media")


@app.get("/health")
def health():
    return {"status": "ok"}


# DEBUG 모드일 때만 검증용 정적 페이지를 /dev 로 서빙.
# 사용: 브라우저에서 http://localhost:8000/dev/?project=<project_id>
# (실제 파일: backend/dev_static/recorder.html — html=True라 /dev/가 index 역할)
# Next.js 본 프론트엔드가 촬영 페이지를 만들면 이 mount + dev_static 디렉터리 제거.
if settings.debug:
    _dev_static_dir = Path(__file__).resolve().parents[1] / "dev_static"
    if _dev_static_dir.exists():
        app.mount(
            "/dev",
            StaticFiles(directory=str(_dev_static_dir), html=True),
            name="dev",
        )
