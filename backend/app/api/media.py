"""업로드된 영상/오디오 파일 서빙 (Range 요청 지원).

왜 따로 만들었나:
  브라우저 <video> 는 "1분 30초 지점부터 주세요"를 HTTP Range 헤더로 요청한다.
  기본 StaticFiles(starlette 0.38)는 이걸 무시하고 파일 전체를 200 으로 돌려줘서,
  스크립트 문장을 눌러 특정 시각으로 이동하면 항상 0초부터 재생됐다.
  (같은 문제를 vlm_test 오디오에서 겪음 — vlm_test/DEV_NOTES.md 3번)

이 라우터는 main.py 에서 `/media` StaticFiles 마운트보다 **먼저** 등록해야 우선 적용된다.
"""
import mimetypes

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.core.config import settings

router = APIRouter(tags=["media"])

CHUNK_SIZE = 64 * 1024  # 한 번에 읽어서 보내는 크기


def _iter_file(path, start: int, length: int):
    """파일의 start 위치부터 length 바이트를 조금씩 읽어서 내보낸다.

    조각마다 파일을 열고 바로 닫는다. 파일을 계속 열어 두면, 재생하던 브라우저가 연결을 끊은 뒤에도
    잠시 열려 있어서 Windows 에서 그 세션을 삭제할 때 "파일이 사용 중"으로 실패한다.
    """
    position = start
    remaining = length
    while remaining > 0:
        with open(path, "rb") as f:
            f.seek(position)
            data = f.read(min(CHUNK_SIZE, remaining))
        if not data:
            break
        position += len(data)
        remaining -= len(data)
        yield data


@router.get("/media/{session_id}/{filename}")
def get_media(session_id: int, filename: str, request: Request):
    path = (settings.upload_dir / str(session_id) / filename).resolve()

    # uploads 폴더 밖의 파일(예: filename 이 ".." )은 못 읽게 막는다.
    if settings.upload_dir.resolve() not in path.parents or not path.is_file():
        raise HTTPException(404, "file not found")

    file_size = path.stat().st_size
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = {"Accept-Ranges": "bytes"}

    range_header = request.headers.get("range", "")
    if not range_header.startswith("bytes="):
        # Range 요청이 아니면 전체를 보낸다.
        headers["Content-Length"] = str(file_size)
        return StreamingResponse(_iter_file(path, 0, file_size), media_type=media_type, headers=headers)

    # "bytes=1000-" (끝까지) 또는 "bytes=1000-1999" 형태.
    start_text, _, end_text = range_header[len("bytes="):].partition("-")
    try:
        start = int(start_text) if start_text else 0
        end = int(end_text) if end_text else file_size - 1
    except ValueError:
        raise HTTPException(416, "invalid range")
    end = min(end, file_size - 1)
    if start > end:
        raise HTTPException(416, "range not satisfiable", headers={"Content-Range": f"bytes */{file_size}"})

    length = end - start + 1
    headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    headers["Content-Length"] = str(length)
    return StreamingResponse(
        _iter_file(path, start, length), status_code=206, media_type=media_type, headers=headers
    )
