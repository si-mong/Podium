# CLAUDE.md

이 파일은 Claude Code(또는 사람)가 새 세션에서 이 프로젝트를 이어서 작업할 때 빠르게 컨텍스트를 잡기 위한 가이드.

---

## 프로젝트 한 줄

**Podium** — 발표 영상을 시스템 내에서 촬영하면 VLM/LLM이 동작·발화·내용을 구간별로 분석하고 피드백을 제공하는 캡스톤 디자인 프로젝트 (2026 CBNU).

상세 기획 / 파이프라인 / DB 스키마 → `_refs/프로젝트 설명.md`, `_refs/프레임워크.md` (둘 다 gitignored, 로컬 전용)

---

## 기술 스택

- **Backend**: FastAPI + SQLAlchemy 2.0 + Alembic + PostgreSQL 16 (Docker)
- **Frontend**: Next.js 14 (App Router, TS, Tailwind)
- **AI/파이프라인** (아직 미설치): Whisper, librosa, OpenCV, pdfplumber, OpenAI GPT-4o
- **인증**: JWT (python-jose) — 아직 미구현

---

## 폴더 구조 (현재 상태)

```
Podium/
├── backend/
│   ├── app/
│   │   ├── main.py                    FastAPI 엔트리 (/health, CORS)
│   │   ├── core/
│   │   │   ├── config.py              pydantic-settings Settings
│   │   │   └── database.py            engine, SessionLocal, Base, get_db
│   │   ├── api/                       (빈 패키지 — 라우터 미작성)
│   │   ├── models/                    ★ 작성 완료 (10 테이블)
│   │   │   ├── user.py                User
│   │   │   ├── project.py             Project
│   │   │   ├── session.py             Session, Chunk
│   │   │   ├── analysis.py            SttSentence, VoiceRaw, Segment,
│   │   │   │                          SegmentAnalysis, Feedback, SessionSummary
│   │   │   └── __init__.py            (모든 모델 re-export — Alembic이 발견하도록)
│   │   ├── schemas/                   (빈 — Pydantic 응답 스키마 미작성)
│   │   ├── services/                  (빈)
│   │   └── pipeline/                  (빈)
│   ├── alembic/                       ★ 초기화 완료
│   │   ├── env.py                     settings.database_url + Base.metadata 연결
│   │   └── versions/
│   │       └── 444442f442c2_create_initial_tables.py  ★ 첫 마이그레이션 (10 테이블)
│   ├── alembic.ini                    sqlalchemy.url 비움 (env.py에서 동적 로드)
│   ├── uploads/                       (영상 저장 — gitignore)
│   ├── requirements.txt               API 서버용 (Alembic 포함)
│   ├── requirements-pipeline.txt      AI 패키지 (whisper 등 — 파이프라인 작업 시점에 설치)
│   └── .env.example
│
├── frontend/                          Next.js 기본 스캐폴드만 (페이지 미작성)
│
├── docker-compose.yml                 Postgres 16 (:5432, podium/podium/podium)
├── CLAUDE.md                          (이 파일)
├── README.md
├── .gitignore
│
├── _legacy/                           중간발표 데모 (gitignore, 참고용)
└── _refs/                             기획 문서 + 환경세팅 가이드 (gitignore)
```

---

## 자주 쓰는 명령어

### 환경 시작 (3개 터미널)
```bash
# 1. Postgres
docker compose up -d postgres

# 2. Backend (cwd = backend/)
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000

# 3. Frontend (cwd = frontend/)
npm run dev
```

### Alembic
```bash
# cwd = backend/, venv 활성화 필요
alembic revision --autogenerate -m "<설명>"   # 모델 변경 → 마이그레이션 파일 생성
alembic upgrade head                          # DB에 적용
alembic downgrade -1                          # 한 단계 롤백
alembic current                               # 현재 적용된 버전
alembic history                               # 마이그레이션 이력
```

### DB 직접 접속 (psql)
```bash
docker compose exec postgres psql -U podium -d podium
# \dt           테이블 목록
# \d users      테이블 구조
# \q            나가기
```

### 동작 확인
- http://localhost:8000/health → `{"status":"ok"}`
- http://localhost:8000/docs → Swagger UI
- http://localhost:3000 → Next.js 시작 페이지

### 상세 환경세팅
→ `_refs/환경세팅.md` (트러블슈팅 포함)

---

## DB 스키마 핵심 결정

10개 테이블 — `_refs/프로젝트 설명.md` 스키마 그대로 매핑.

| 결정 | 값 | 이유 |
|---|---|---|
| PK 타입 | `BigInteger` autoincrement | 단순함 |
| 타임스탬프 | `created_at`만 (`server_default=now()`) | 일단 최소화, 필요한 곳에 `updated_at` 추가 |
| 외래키 | `ondelete="CASCADE"` (DB) + ORM `cascade="all, delete-orphan"` | 양방향 |
| 예외: `session_summaries.best/worst_segment_id` | `SET NULL` | segment 지워져도 summary는 살아남게 |
| JSON 컬럼 | PostgreSQL `JSONB` | `silence_segments`, `filler_words`, `overall_scores` |
| 시간 | `Float` (초) | t_start, t_end |
| status | `String(32)` 기본값 `"processing"` | Enum 정리는 추후 |
| 1:1 관계 | 부모 ID를 PK로 (별도 PK 없음) | `voice_raws`, `segment_analyses`, `feedbacks`, `session_summaries` |

### 모델 도메인 분리 방식
4분할 (A안 채택):
- `user.py`, `project.py`, `session.py`, `analysis.py`
- (대안 B: 6분할 — 분석 파이프라인 단계별로 더 잘게 — 채택 안 함. 1:1 관계 테이블들을 한 파일에 두는 게 자연스러움)

---

## 진행 상황

### ✅ 완료
- 기존 중간발표 데모를 `_legacy/`로 이동
- Backend FastAPI 스캐폴드 (`app/{main,core,api,models,schemas,services,pipeline}`)
- Frontend Next.js 14 스캐폴드 (TS + Tailwind + App Router)
- Postgres docker-compose
- `requirements.txt` (API용) / `requirements-pipeline.txt` (AI용) 분리
- `.gitignore` 정비 (`_refs/`, `_legacy/`, `uploads/*` 등)
- `_refs/환경세팅.md` 가이드 작성
- **SQLAlchemy 모델 10개 작성** (user/project/session/analysis 4파일로 분리)
- **Alembic 초기화 + 첫 마이그레이션 생성/적용** (Postgres에 11 테이블 실재)

### 🟡 이 시점 git 상태
- 현재 브랜치: `main`
- staged (커밋 대기 중):
  - `backend/alembic.ini`, `backend/alembic/{README,env.py,script.py.mako}`
  - `backend/alembic/versions/444442f442c2_create_initial_tables.py`
  - `backend/app/models/{user,project,session,analysis,__init__}.py`
- 다음 세션 시작 시 → 위 staged 변경을 적절한 단위로 커밋부터 (예: "Add SQLAlchemy models (10 tables)" + "Initialize Alembic and apply initial migration" 둘로 쪼개기)

### ⏭️ 다음 작업 후보 (WBS 순서)
1. **인증 API** (WBS 2단계) — `POST /auth/signup`, `POST /auth/login`, JWT 발급, `get_current_user` 의존성
2. **프로젝트/세션 CRUD** — `GET /projects`, `POST /projects`, `GET /projects/{id}/sessions` 등
3. **청크 업로드 엔드포인트** — `_legacy/backend/main.py`의 데모 로직을 새 구조로 포팅
4. **파이프라인 STEP 1~2** (WBS 3단계) — 전처리 + Whisper STT. 이때 `requirements-pipeline.txt` 설치 필요 (Python 3.13 + whisper 빌드 이슈 있음 — 아래 참고)

### ⚠️ 알려진 이슈
- **Python 3.13 + openai-whisper 빌드 실패** (`ModuleNotFoundError: No module named 'pkg_resources'`).
  해결 후보: ① `pip install setuptools wheel` 먼저 ② Python 3.11 별도 venv ③ `faster-whisper`로 교체.
  파이프라인 작업 들어갈 때 결정.

---

## 코딩 컨벤션 / 패턴

### 백엔드
- 새 모델 추가 시: `app/models/<domain>.py` 작성 → `app/models/__init__.py`에 re-export → `alembic revision --autogenerate -m "..."` → 파일 검토 → `alembic upgrade head`
- 새 API 추가 시: `app/api/<domain>.py`에 `APIRouter` → `app/main.py`에서 `include_router`. (아직 라우터 0개)
- DB 세션은 `Depends(get_db)`로 주입 (FastAPI 패턴)
- 환경변수는 `app.core.config.settings`로 접근, 절대 `os.getenv` 직접 호출 X

### git
- 커밋 메시지는 영문, 명령형 ("Add X", "Fix Y")
- 본문 있을 땐 "Why" 중심으로
- 관련 변경은 묶고, 무관한 건 분리
- `_refs/`, `_legacy/`, `backend/uploads/`, `backend/.venv/`, `node_modules/`, `.next/` 는 gitignored

---

## 모르는 거 있으면 먼저 볼 곳

| 알고 싶은 것 | 어디 |
|---|---|
| 환경 세팅 / 트러블슈팅 | `_refs/환경세팅.md` |
| 프로젝트 전체 기획 + 파이프라인 | `_refs/프로젝트 설명.md` |
| 기술스택 / 데이터 모델 사양 | `_refs/프레임워크.md` |
| 중간발표 데모 코드 (참고용) | `_legacy/backend/main.py`, `_legacy/frontend/index.html` |
