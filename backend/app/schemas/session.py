from datetime import datetime
from typing import List, Optional

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
    full_video_path: Optional[str]
    pdf_path: Optional[str]
    created_at: datetime


class SessionDetail(SessionRead):
    chunks: List[ChunkRead] = []


class UploadResult(BaseModel):
    ok: bool = True
    size_bytes: int


class PreprocessResult(BaseModel):
    session_id: int
    status: str
    full_audio_path: str
    total_duration_sec: Optional[float]
    chunk_count: int


class MotionAnalysisResult(BaseModel):
    session_id: int
    status: str
    chunk_count: int      # 스마트 청킹이 만든 청크 수 (업로드 청크 수와 무관)
    analyzed_count: int
    covered_sec: float    # VLM 이 실제로 본 총 길이 — 절감률 확인용
    json_output_path: str
