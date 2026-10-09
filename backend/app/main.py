from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import auth, projects, sessions
from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # 기본값 :3000 은 본 프론트엔드. :8001 은 devtools(STEP 실행/조회 테스트 페이지)가
    # 브라우저에서 직접 이 서버를 호출하기 위함 — devtools 자체는 DB 를 안 만짐.
    # 배포 환경에서는 .env 의 CORS_ORIGINS 로 프론트 도메인을 지정한다.
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(sessions.router)
# 업로드 영상은 로그인 확인을 거치는 GET /sessions/{id}/video (+ 재생 티켓) 로만 내려준다.
# 예전의 공개 /media 경로는 세션 번호만 바꾸면 남의 영상이 보여서 없앴다.


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
