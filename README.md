# Podium

2026-CBNU CapstoneDesign — presentation analysis

---

## Preprocessing Demo (mid-presentation scope)

발표 분석 시스템의 **전처리 단계**만 동작하는 데모.
범위: `촬영 시작 → 30초 청크 실시간 분할 → 촬영 종료 → 청크별 오디오 추출 + full_audio.wav 합치기` (VLM 호출 직전 상태까지).

### Setup (M-series Mac)

```bash
# 1. ffmpeg 확인 (없으면 brew install ffmpeg)
ffmpeg -version

# 2. 백엔드 의존성
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Run

```bash
# backend/ 에서
uvicorn main:app --reload --port 8000
```

브라우저로 `http://localhost:8000` 접속 → **Start recording** → 발표 → **Stop & finalize**.

> 카메라/마이크 권한은 `localhost` 또는 HTTPS에서만 허용됩니다.

### What happens

```
브라우저 (MediaRecorder × 2, 같은 MediaStream 공유)
  ├─ chunk recorder: 30초마다 회전 → 독립 .webm 청크 (VLM/음성 분석용)
  │    └─ 청크 생성 즉시 업로드 (POST /sessions/{id}/chunks)
  └─ full recorder: 전체 연속 녹화 (스트리밍/재생용)
       └─ Stop 시 한 번에 업로드 (POST /sessions/{id}/video)

종료 시 (POST /sessions/{id}/end)
  └─ 각 chunk_NNN.webm → chunk_NNN.wav (16kHz mono)
  └─ ffmpeg concat → full_audio.wav
  └─ meta.json 업데이트 (status: "preprocessed")
```

### Output

`backend/data/<session_id>/`
- `chunks/chunk_000.webm`, `chunk_001.webm`, …  ← VLM 분석용 (분석 후 삭제 예정)
- `audio/chunk_000.wav`, `audio/chunk_001.wav`, …
- `full_video.webm` ← UI 재생/스트리밍용, 영구 보관
- `full_audio.wav` ← Whisper에 넣을 준비 완료
- `meta.json` ← 청크 인덱스 + t_start/t_end + 총 duration + full_video_path

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/sessions/start` | 새 세션 생성 |
| POST | `/sessions/{id}/chunks?chunk_index=N` | 30초 청크 업로드 (multipart) |
| POST | `/sessions/{id}/video` | 전체 영상 업로드 (multipart, Stop 시 1회) |
| POST | `/sessions/{id}/end` | 오디오 추출 + 합치기 (VLM 호출 직전 상태) |
| GET  | `/sessions/{id}` | 메타 조회 |
| DELETE | `/sessions/{id}` | 세션 삭제 |

### Notes / TODOs (중간발표 후)

- 청크 단위는 30초 고정 (`CHUNK_DURATION_SEC` in `backend/main.py`).
- 실제 청크 길이는 MediaRecorder 플러시 타이밍에 따라 약간 변동 가능. 현재는 `t_start/t_end`를 이상적인 값으로 기록하고, 정확한 길이는 ffprobe로 보정해야 정밀해짐.
- 저장은 로컬 FS + JSON. 발표 후 Postgres로 마이그레이션 예정.
- 인증, PDF 업로드, 동시 세션 격리는 범위 외.
