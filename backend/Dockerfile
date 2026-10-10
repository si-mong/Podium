# Podium API 서버 (FastAPI + 분석 파이프라인) 운영용 이미지.
# 빌드는 서버(EC2, x86)에서 직접 한다 — 맥(ARM)에서 빌드하면 아키텍처가 달라진다.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models

# ffmpeg/ffprobe: STEP 1·2 전처리와 청크 추출에 필요
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch 는 CPU 전용 휠을 먼저 설치한다. PyPI 기본 휠은 CUDA 가 딸려와 2.5GB 를 넘는다.
RUN pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt requirements-pipeline.txt ./
RUN pip install -r requirements.txt -r requirements-pipeline.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app

EXPOSE 8000

# 시작할 때 DB 마이그레이션을 먼저 적용한다.
# 워커는 1개 — STT 모델(약 3GB)이 워커마다 따로 메모리에 올라가기 때문.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1"]
