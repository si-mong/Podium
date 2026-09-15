"""개발용 테스트 서버 — STEP 2(영상) / STEP 3(음성) 통합 진입점.

기존에는 포트가 갈려 있었다 (vlm_test 8001, stt_test 8002). 테스트할 때마다
서버를 두 개 띄우고 포트를 바꿔 들어가야 해서 번거로웠다.
이제 부모 앱에 두 앱을 **마운트**해 한 포트에서 메뉴로 오간다.

    uvicorn devtools.server:app --reload --port 8000

    /vlm/...    STEP 2 영상 분석 (구 8001)
    /voice/...  STEP 3 음성 분석 (구 8002)

마운트 때문에 하위 앱의 절대 경로(`/api/...`)가 부모로 새므로, 각 프런트엔드는
`static/base.js` 가 심는 `APP_BASE` 로 fetch/EventSource 를 보정한다.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from stt_test.server import app as voice_app
from vlm_test.server import app as vlm_app

app = FastAPI(title="Podium 개발 테스트")

# 공용 정적 자산 — 모든 페이지가 같은 nav/shim 을 쓰도록 부모에서 한 번만 서빙.
# 하위 앱 어디서 불러도 절대경로 /shared/... 로 도달하므로 prefix 보정이 필요 없다.
app.mount("/shared", StaticFiles(directory=str(Path(__file__).parent / "static")), name="shared")

app.mount("/vlm", vlm_app)
app.mount("/voice", voice_app)


@app.get("/", include_in_schema=False)
def index() -> RedirectResponse:
    return RedirectResponse("/voice/")
