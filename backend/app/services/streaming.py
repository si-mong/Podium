"""HTTP Range 응답 — 영상 구간 재생용.

`<video>` 는 사용자가 재생 위치를 옮길 때마다 `Range: bytes=...` 헤더로 **파일의 일부만**
요청한다. 서버가 이를 무시하고 매번 전체를 내려주면 10분 발표(수십 MB)에서 구간 이동이
사실상 불가능해진다. 그래서 206 Partial Content 를 직접 구현한다.

Starlette 0.38 의 FileResponse 는 Range 를 처리하지 않는다(상위 버전에서 추가됨).
버전을 올리는 대신 여기서 처리해 동작을 명시적으로 통제한다.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse


CHUNK_SIZE = 1024 * 1024        # 1MiB — 메모리에 한 번에 올리는 양
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _read_range(path: Path, start: int, end: int) -> Iterator[bytes]:
    """[start, end] (양끝 포함) 구간만 흘려보낸다."""
    remaining = end - start + 1
    with path.open("rb") as f:
        f.seek(start)
        while remaining > 0:
            data = f.read(min(CHUNK_SIZE, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def range_response(
    path: Path,
    request: Request,
    media_type: str,
    filename: str | None = None,
) -> FileResponse | StreamingResponse:
    """Range 헤더가 있으면 206, 없으면 200 전체 응답.

    ⚠️ `path` 는 **서버가 DB 값으로 조립한 경로여야 한다.** 클라이언트가 보낸 문자열을
    그대로 넘기면 경로 탈출로 남의 파일을 읽을 수 있다. 호출부에서 소유권 검사를
    먼저 끝낼 것.
    """
    file_size = path.stat().st_size
    range_header = request.headers.get("range")

    # Range 없음 → 전체. Accept-Ranges 를 붙여야 브라우저가 이후 구간 요청을 시도한다.
    if not range_header:
        return FileResponse(
            path,
            media_type=media_type,
            filename=filename,
            headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"},
        )

    m = _RANGE_RE.match(range_header.strip())
    if not m:
        # multipart range(`bytes=0-9,20-29`) 등 미지원 형식 — 전체를 주는 게 규격상 안전.
        return FileResponse(path, media_type=media_type, filename=filename,
                            headers={"Accept-Ranges": "bytes"})

    raw_start, raw_end = m.group(1), m.group(2)
    if raw_start == "" and raw_end == "":
        raise _unsatisfiable(file_size)

    if raw_start == "":
        # `bytes=-500` = 마지막 500바이트. 브라우저가 webm 메타데이터를 찾을 때 쓴다.
        length = int(raw_end)
        if length <= 0:
            raise _unsatisfiable(file_size)
        start = max(0, file_size - length)
        end = file_size - 1
    else:
        start = int(raw_start)
        end = int(raw_end) if raw_end else file_size - 1
        end = min(end, file_size - 1)

    if start >= file_size or start > end:
        raise _unsatisfiable(file_size)

    return StreamingResponse(
        _read_range(path, start, end),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
        },
    )


def _unsatisfiable(file_size: int) -> HTTPException:
    """416 — 파일 범위를 벗어난 요청. 규격상 실제 크기를 알려줘야 한다."""
    return HTTPException(
        416,
        "요청한 범위가 파일 크기를 벗어납니다.",
        headers={"Content-Range": f"bytes */{file_size}"},
    )
