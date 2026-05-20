from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ChunkRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    chunk_id: int
    chunk_index: int
    file_path: str
    t_start: float
    t_end: float


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: int
    project_id: int
    status: str
    full_video_path: str | None
    pdf_path: str | None
    created_at: datetime


class SessionDetail(SessionRead):
    chunks: list[ChunkRead] = []


class UploadResult(BaseModel):
    ok: bool = True
    size_bytes: int


class PreprocessResult(BaseModel):
    session_id: int
    status: str
    full_audio_path: str
    total_duration_sec: float | None
    chunk_count: int
