<div align="center">

# Podium
2026-CBNU CapstoneDesign
### **당신의 발표, AI가 다시 봅니다.**

발표 영상 하나로 음성·자세·시선·제스처까지<br/>
**구간별로 분석하고 회차마다 성장 추이를 보여주는** AI 발표 코치

</div>

---

## 프로젝트 소개

### 배경

> "발표 연습은 했는데, 뭘 고쳐야 할지 모르겠어요."

발표는 누구나 하지만, 제대로 피드백받을 기회는 거의 없습니다.<br/>
혼자 영상을 다시 봐도 **무엇이 문제인지** 짚어내기 어렵고, 매번 누군가에게 부탁할 수도 없습니다.

### 목표

**Podium은 그 자리를 대신합니다.**<br/>
영상 한 편을 업로드하면 AI 코치가 발표 전체를 다시 보고, **구간별로 무엇을 잘했고 무엇을 고쳐야 하는지** 알려줍니다. 연습할수록 성장이 데이터로 쌓이는 경험을 제공합니다.

### 핵심 기능

#### 1. 멀티모달 분석
업로드하면 끝. 음성·언어·동작을 동시에 분석합니다.

| 영역 | 분석 항목 |
|---|---|
| 🗣️ **음성** | 발화 속도(WPM) · 무음 구간 · 필러 단어 ("음", "어") |
| 📝 **언어** | STT 기반 문장 분리 · 의미 단위 구간 분리 |
| 👁️ **시선·자세** | 카메라 응시율 · 자세 안정성 |
| 🤲 **제스처** | 손동작 활용도 · 불필요한 반복 동작 |

#### 2. 구간별 분석과 피드백
발표를 의미 단위로 자동 분할하고, **각 구간마다 발표 습관 결과**와 개선 코멘트를 제공합니다.

#### 3. 회차별 성장 추이
같은 발표를 여러 번 연습할수록 진짜 가치가 드러납니다.<br/>
회차를 거듭하며 **어떤 지표가 좋아졌는지, 어디서 정체됐는지** 한눈에 확인하세요.

---

## 기술 스택

<div align="center">

**Frontend**<br/>
![Next.js](https://img.shields.io/badge/Next.js_14-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![TanStack Query](https://img.shields.io/badge/TanStack_Query-FF4154?style=flat-square&logo=reactquery&logoColor=white)

**Backend**<br/>
![Python](https://img.shields.io/badge/Python_3.11-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![SQLAlchemy](https://img.shields.io/badge/SQLAlchemy-D71F00?style=flat-square&logo=sqlalchemy&logoColor=white)

**AI / Analysis**<br/>
![OpenAI](https://img.shields.io/badge/GPT--4o-412991?style=flat-square&logo=openai&logoColor=white)
![Whisper](https://img.shields.io/badge/Whisper_large--v3-74AA9C?style=flat-square&logo=openai&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white)
![OpenCV](https://img.shields.io/badge/OpenCV-5C3EE8?style=flat-square&logo=opencv&logoColor=white)

**Infra**<br/>
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)
![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white)

</div>

---

## 개발 가이드 (팀원용)

### 사전 요구사항

- Docker Desktop (Postgres용)
- Python 3.11+ (3.13도 OK — `requirements-pipeline.txt` 설치 시 주의, 아래 [알려진 이슈](#알려진-이슈))
- Node.js 18+
- ffmpeg (전처리 검증/실행 시 필요): `brew install ffmpeg`

### 빠른 시작 (3개 터미널)

```bash
# 1. Postgres
docker compose up -d postgres

# 2. Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
alembic upgrade head                       # DB 테이블 생성 (clone 직후만)
uvicorn app.main:app --reload --port 8000

# 3. Frontend
cd frontend
npm install                                 # clone 직후만
cp .env.local.example .env.local
npm run dev
```

확인:
- http://localhost:8000/health → `{"status":"ok"}`
- http://localhost:8000/docs → Swagger UI
- http://localhost:3000 → Next.js 시작 페이지

### 전처리 (STEP 1) 동작 검증

현재 시점 백엔드가 진짜로 동작하는지 확인하는 가장 빠른 방법:

```bash
# 1. 프로젝트 생성
curl -X POST http://localhost:8000/projects \
  -H 'Content-Type: application/json' -d '{"title":"테스트"}'
# 응답에서 project_id 받기 (예: 1)

# 2. 브라우저로 시스템 내 촬영 (DEBUG 모드일 때만 /dev mount됨)
open "http://localhost:8000/dev/?project=1"
# Start recording → 30초+ 촬영 → Stop & finalize

# 3. 결과 확인
ls backend/uploads/1/     # chunks/, audio/, full_video.webm, full_audio.wav
docker compose exec postgres psql -U podium -d podium -c \
  "SELECT session_id, status FROM sessions;"
# status='preprocessed' 이면 성공
```

`/dev` mount(`backend/dev_static/`)는 Next.js 촬영 페이지가 생기면 제거 예정 (현재 임시).

---

## 폴더 구조

```
Podium/
├── backend/
│   ├── app/
│   │   ├── main.py                      FastAPI 엔트리
│   │   ├── core/                        config, database
│   │   ├── models/                      SQLAlchemy 10 테이블 (4파일 분할)
│   │   ├── schemas/                     Pydantic 요청/응답
│   │   ├── api/                         라우터 + 임시 더미 인증(_dev_auth.py)
│   │   ├── services/storage.py          파일 저장 헬퍼
│   │   └── pipeline/                    STEP 1~5 분석 파이프라인
│   ├── alembic/                         DB 마이그레이션
│   ├── uploads/                         영상/오디오 저장 (gitignored)
│   ├── requirements.txt                 API 서버용
│   └── requirements-pipeline.txt        AI 패키지 (whisper 등 — 별도 설치)
├── frontend/                            Next.js 14
├── docker-compose.yml                   Postgres 16
├── CLAUDE.md                            ★ 본인+AI용 상세 컨텍스트 (결정사항/구조/임시코드)
└── README.md                            ★ 이 파일
```

---

## 진행 상황 / 분담

### 팀 / 일정
- 인원 2명, 일정 약 2~3개월
- **사용자**: 파이프라인 STEP 1/3/4/5 + 백엔드 전체
- **팀원**: 파이프라인 STEP 2 (VLM) + 프론트엔드 전체

### 파이프라인 STEP 매핑
| STEP | 내용 | 담당 |
|---|---|---|
| 1 | 전처리 (청크 분할 → 오디오 추출 + full_audio.wav) | 사용자 ✅ |
| 2 | VLM 동작 분석 | 팀원 (진행 중) |
| 3 | Whisper STT + 음성 수치화 (filler/silence/wpm) | 사용자 |
| 4 | LLM 구간 분리 | 사용자 |
| 5 | LLM 종합 피드백 | 사용자 |

### 진행 방식
**하이브리드** — 파이프라인 PoC 병렬(~2주) → 수직 슬라이스(3주~) → 인증/폴리싱(후반).
슬라이스마다 API 계약 먼저 박고 백/프론트 병렬 진행.

상세 결정사항/임시 코드/다음 작업 후보는 [CLAUDE.md](./CLAUDE.md) 참고.

---

## 코딩 컨벤션

### 백엔드
- **새 모델**: `app/models/<domain>.py` → `__init__.py` re-export → `alembic revision --autogenerate -m "..."` → 검토 → `alembic upgrade head`
- **새 라우터**: `app/api/<domain>.py`에 `APIRouter` → `app/main.py`에서 `include_router`
- **DB 세션**: `Depends(get_db)`로 주입
- **환경변수**: `app.core.config.settings` 통해 접근 (직접 `os.getenv` X)

### Git
- 브랜치: `feature/<설명>` (예: `feature/pipeline-step2-vlm`)
- 커밋 메시지: 영문 + 명령형 ("Add X", "Fix Y")
- 본문 있을 땐 "Why" 중심
- 슬라이스 끝나면 PR → 짧은 리뷰 → main 머지 (1~2일 안에)
- gitignored: `_refs/`, `_legacy/`, `backend/uploads/*` (단 `.gitkeep` 유지), `.venv/`, `node_modules/`, `.next/`, `.env`

---

## 알려진 이슈

### Python 3.13 + openai-whisper 빌드 실패
`requirements-pipeline.txt` 설치 시 `ModuleNotFoundError: No module named 'pkg_resources'` 에러 발생 가능. STEP 3 작업 들어갈 때 셋 중 하나로 해결:
1. `pip install setuptools wheel` 먼저 시도
2. Python 3.11 별도 venv 만들기
3. `faster-whisper`로 교체 (3.13 호환 더 좋음)

---

## 추가 문서

| 문서 | 위치 | 비고 |
|---|---|---|
| 상세 컨텍스트 / 결정사항 / 다음 작업 | [CLAUDE.md](./CLAUDE.md) | git에 포함 |
| 환경 세팅 트러블슈팅 | `_refs/환경세팅.md` | gitignored — 팀 내부 공유 |
| Postgres / psql / DBeaver 사용법 | `_refs/Postgres사용법.md` | gitignored |
| ERD | `_refs/erd.dbml`, `_refs/erd.md` | gitignored |
| 프로젝트 기획 + 파이프라인 상세 | `_refs/프로젝트 설명.md`, `_refs/프레임워크.md` | gitignored |

`_refs/` 문서들은 로컬 전용. 팀 슬랙/메신저로 별도 공유.
