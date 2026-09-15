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


class VoiceAnalysisResult(BaseModel):
    """STEP 3 음성분석 결과 요약. 상세 수치는 voice_raws / stt_sentences 에 저장됨."""
    session_id: int
    status: str
    model: str                      # 실제 사용한 STT 모델 (설정으로 교체 가능)
    total_duration: float
    sentence_count: int
    silence_count: int
    filler_count: int
    repetition_count: int
    speaking_rate_spm: float        # 무음 포함 — 전체 템포
    articulation_rate_spm: float    # 무음 제외 — 조음 속도
    elapsed_sec: float


class MotionAnalysisResult(BaseModel):
    session_id: int
    status: str
    chunk_count: int      # 스마트 청킹이 만든 청크 수 (업로드 청크 수와 무관)
    analyzed_count: int
    covered_sec: float    # VLM 이 실제로 본 총 길이 — 절감률 확인용
    json_output_path: str
