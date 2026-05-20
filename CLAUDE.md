# CLAUDE.md

이 파일은 Claude Code(또는 사람)가 새 세션에서 이 프로젝트를 이어서 작업할 때 빠르게 컨텍스트를 잡기 위한 가이드.

---

## 프로젝트 한 줄

**Podium** — 발표 영상을 시스템 내에서 촬영하면 VLM/LLM이 동작·발화·내용을 구간별로 분석하고 피드백을 제공하는 캡스톤 디자인 프로젝트 (2026 CBNU).

상세 기획 / 파이프라인 / DB 스키마 → `_refs/프로젝트 설명.md`, `_refs/프레임워크.md` (둘 다 gitignored, 로컬 전용)

---

## 팀 / 일정 / 분담

- 인원: 2명
- 일정: 약 2~3개월
- 분담:
  - **사용자(주)**: 파이프라인 STEP 1/3/4/5 + 백엔드 전체
  - **팀원**: 파이프라인 STEP 2 (VLM) + 프론트엔드 전체

### 개발 방식 — 하이브리드

1. **(현재 단계) 파이프라인 PoC 병렬** — 사용자=전처리/STT, 팀원=VLM. 함수 단위로 동작 검증
2. **수직 슬라이스** — 매주 한 기능을 (DB→API→파이프라인→프론트) 끝까지 구현해 데모 가능한 상태 유지
3. **인증** — 후반부에 `_dev_auth.py`를 JWT로 교체 (반나절 작업으로 예상)

이유: 사용자가 백엔드+파이프라인 병목. 통합을 마지막에 미루면 폭발 → 슬라이스로 분산.

### 협업 패턴 — "API 계약 먼저"

각 슬라이스 시작 시 사용자가 **빈 라우터 스텁 + 응답 스키마**부터 박아두면, 팀원이 그 사이 프론트 시작 가능. FastAPI `/docs`가 자동 OpenAPI라 더미 응답만으로 프론트 작업 가능.

---

## 파이프라인 STEP 번호 매핑 (★ 변경됨)

```
STEP 1  전처리 (청크 분할 → 오디오 추출 + full_audio.wav)   사용자
STEP 2  VLM 동작 분석                                       팀원   ← (예전 STEP 4)
STEP 3  Whisper STT + 음성 수치화                           사용자  ← (예전 STEP 2)
STEP 4  LLM 구간 분리                                       사용자  ← (예전 STEP 3)
STEP 5  LLM 종합 피드백                                     사용자
```

의존성 그래프(번호와 무관):
```
STEP 1 (청크) ─┬─> STEP 2 VLM (청크별)
               └─> STEP 3 STT (full_audio)
                       └─> STEP 4 구간분리
                              └─> STEP 5 종합 (STEP 2+3 결과 다 사용)
```

→ STEP 1만 끝나면 사용자(STEP 3 이후)와 팀원(STEP 2)이 진짜 병렬 가능.

---

## 기술 스택

- **Backend**: FastAPI + SQLAlchemy 2.0 + Alembic + PostgreSQL 16 (Docker)
- **Frontend**: Next.js 14 (App Router, TS, Tailwind) — 페이지 미작성
- **AI/파이프라인 (`requirements-pipeline.txt`)**: Whisper, librosa, OpenCV, pdfplumber, OpenAI GPT-4o — 미설치
- **인증**: 임시 더미(`_dev_auth.py`). 실제 JWT는 후반부

---

## 폴더 구조 (현재 상태)

```
Podium/
├── backend/
│   ├── app/
│   │   ├── main.py                    FastAPI 엔트리 (lifespan, CORS, router include, DEBUG시 /legacy mount)
│   │   ├── core/
│   │   │   ├── config.py              pydantic-settings Settings
│   │   │   └── database.py            engine, SessionLocal, Base, get_db
│   │   ├── api/                       ★
│   │   │   ├── _dev_auth.py           ★ 임시 더미 사용자(dev@podium.local) — 실제 인증 만들면 제거
│   │   │   ├── projects.py            GET/POST /projects
│   │   │   └── sessions.py            세션 라이프사이클 5개 엔드포인트
│   │   ├── models/                    SQLAlchemy 10 테이블 (4파일 분할)
│   │   │   ├── user.py, project.py, session.py, analysis.py, __init__.py
│   │   ├── schemas/                   ★
│   │   │   ├── project.py
│   │   │   └── session.py
│   │   ├── services/                  ★
│   │   │   └── storage.py             세션별 파일 경로/IO 헬퍼
│   │   └── pipeline/                  ★
│   │       └── step1_preprocess.py    ffmpeg: 청크 wav 추출 + concat + ffprobe duration
│   ├── alembic/
│   │   ├── env.py                     settings.database_url + Base.metadata 연결
│   │   └── versions/
│   │       └── 444442f442c2_create_initial_tables.py    첫 마이그레이션 (10 테이블)
│   ├── alembic.ini                    sqlalchemy.url 비움 (env.py에서 동적 로드)
│   ├── uploads/<session_id>/          영상/오디오 저장 (gitignored, .gitkeep만 트래킹)
│   │   ├── chunks/chunk_NNN.webm
│   │   ├── audio/chunk_NNN.wav
│   │   ├── full_video.webm
│   │   └── full_audio.wav
│   ├── dev_static/                    ★ DEBUG일 때 /dev로 임시 mount되는 검증용 정적 페이지 (시스템 촬영). Next.js 촬영 페이지 생기면 제거
│   │   └── index.html
│   ├── requirements.txt               API 서버용
│   ├── requirements-pipeline.txt      AI 패키지 (파이프라인 작업 시 별도 설치)
│   └── .env.example                   DEBUG=true 기본
│
├── frontend/                          Next.js 기본 스캐폴드만 (페이지 미작성)
│
├── docker-compose.yml                 Postgres 16 (:5432, podium/podium/podium)
├── CLAUDE.md
├── README.md
├── .gitignore
│
├── _legacy/                           중간발표 데모 (gitignored, 참고용)
└── _refs/                             기획 문서 + 가이드 (gitignored)
    ├── 프로젝트 설명.md
    ├── 프레임워크.md
    ├── 환경세팅.md
    ├── Postgres사용법.md
    ├── erd.dbml                       dbdiagram.io용
    └── erd.md                         Mermaid 버전
```

---

## API 엔드포인트 (현재)

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 헬스체크 |
| GET | `/projects` | dev 사용자의 프로젝트 목록 |
| POST | `/projects` | 프로젝트 생성 (`{"title": "..."}`) |
| POST | `/projects/{project_id}/sessions/start` | 세션 시작 (DB 행 + uploads/ 폴더 생성) |
| POST | `/sessions/{session_id}/chunks?chunk_index=N` | 30초 webm 청크 업로드 (multipart) |
| POST | `/sessions/{session_id}/video` | 전체 연속 webm 업로드 (Stop 시 1회) |
| POST | `/sessions/{session_id}/end` | ffmpeg 전처리 → `full_audio.wav` 생성, status='preprocessed' |
| GET | `/sessions/{session_id}` | 세션 + chunks 배열 |
| DELETE | `/sessions/{session_id}` | DB 행 cascade 삭제 + uploads/ 폴더 삭제 |

DEBUG 모드일 때 `/dev/?project=<id>` mount — `backend/dev_static/index.html` 임시 서빙 (전처리 검증용). 슬라이스 1에서 Next.js 촬영 페이지 만들면 mount + `dev_static/` 디렉터리 제거.

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

### 전처리 동작 검증 (지금까지 만든 것)
```bash
# 0. uvicorn 떠있어야 하고 .env에 DEBUG=true 필요. ffmpeg 시스템에 설치 필요.

# 1. 프로젝트 생성 (Swagger 또는 curl)
curl -X POST http://localhost:8000/projects \
  -H 'Content-Type: application/json' -d '{"title":"테스트"}'
# → 응답에서 project_id 받기 (예: 1)

# 2. 브라우저로 촬영 (시스템 내 촬영이 본 흐름이라 진짜 촬영으로 검증)
open "http://localhost:8000/dev/?project=1"
# Start recording → 30초+ 촬영 → Stop & finalize

# 3. 결과 확인
ls -la backend/uploads/1/    # chunks/, audio/, full_video.webm, full_audio.wav
docker compose exec postgres psql -U podium -d podium -c "
SELECT s.session_id, s.project_id, s.status, count(c.chunk_id) AS chunks
FROM sessions s LEFT JOIN chunks c USING(session_id)
GROUP BY s.session_id;
"
```

### Alembic
```bash
# cwd = backend/, venv 활성화 필요
alembic revision --autogenerate -m "<설명>"   # 모델 변경 → 마이그레이션 파일 생성
alembic upgrade head                          # DB에 적용
alembic downgrade -1                          # 한 단계 롤백
alembic current                               # 현재 적용된 버전
```

### DB 직접 접속 → `_refs/Postgres사용법.md`

---

## DB 스키마 핵심 결정

10개 테이블 — `_refs/프로젝트 설명.md` 스키마 그대로 매핑.

| 결정 | 값 | 이유 |
|---|---|---|
| PK 타입 | `BigInteger` autoincrement | 단순함 |
| 타임스탬프 | `created_at`만 (`server_default=now()`) | 필요한 곳에 `updated_at` 추가 |
| 외래키 | `ondelete="CASCADE"` (DB) + ORM `cascade="all, delete-orphan"` | 양방향 |
| 예외: `session_summaries.best/worst_segment_id` | `SET NULL` | segment 지워져도 summary 살아남게 |
| JSON 컬럼 | PostgreSQL `JSONB` | `silence_segments`, `filler_words`, `overall_scores` |
| 시간 | `Float` (초) | t_start, t_end |
| status | `String(32)` 기본값 `"processing"` | Enum 정리는 추후 |
| 1:1 관계 | 부모 ID를 PK로 (별도 PK 없음) | `voice_raws`, `segment_analyses`, `feedbacks`, `session_summaries` |

**모델 도메인 분리**: 4분할 (`user.py`, `project.py`, `session.py`, `analysis.py`). 1:1 관계 테이블들은 부모 모델 옆에 묶어둠.

**파일 저장 구조**: `uploads/<session_id>/...` 평탄형 (project_id 안 끼움). 이유: session_id가 전역 unique → 경로 도출 O(1). 코드 단순.

---

## 진행 상황

### ✅ 완료
- 인프라: Backend/Frontend 스캐폴드, Postgres docker, requirements 분리
- DB: SQLAlchemy 모델 10개 + Alembic 초기 마이그레이션 적용
- 전처리 (STEP 1):
  - `pipeline/step1_preprocess.py` — ffmpeg 청크 wav 추출 + concat + ffprobe duration
  - `services/storage.py` — 파일 경로/IO
  - `schemas/project.py`, `schemas/session.py`
  - `api/projects.py`, `api/sessions.py` — 9개 엔드포인트
  - `api/_dev_auth.py` — 임시 더미 사용자 시드 (lifespan에서 자동 실행)
  - `backend/dev_static/index.html` — 시스템 촬영 검증용 정적 페이지 (DEBUG일 때 `/dev` mount)
- **전처리 end-to-end 검증 통과** — 시스템 촬영 → 청크/영상 저장 → DB 행 → ffmpeg 전처리 → full_audio.wav 생성

### 🟡 현재 브랜치
- `feature/pipeline-step1` (PR 만들 예정 → main 머지)
- 머지되면 팀원이 main에서 `feature/pipeline-step2-vlm` 분기해서 VLM 작업 시작

### ⏭️ 다음 작업 후보

**파이프라인 PoC 단계 마무리** (~2주):
1. **사용자**: STEP 3 (Whisper STT + 음성 수치화 — filler/silence/wpm)
   - `requirements-pipeline.txt` 설치 필요 → Python 3.13 + whisper 이슈 해결 우선
   - 함수 단위로 검증 (input: full_audio.wav, output: STT 문장 + voice_raw dict)
2. **팀원**: STEP 2 (VLM 동작 분석) — `pipeline/step2_motion.py` 파일 추가
   - 함수 시그니처 합의 예: `analyze_motion(chunk_paths: list[Path]) -> dict`

**수직 슬라이스 단계** (3주~):
- 슬라이스 1: 영상 업로드 + STT 자막 표시 (사용자 백 / 팀원 프론트)
- 슬라이스 2: VLM 동작 분석 통합
- 슬라이스 3: STEP 4 LLM 구간 분리
- 슬라이스 4: STEP 5 LLM 종합 피드백
- 슬라이스 5: 회차 비교 + 추세

**후반부**:
- 인증 (`_dev_auth.py` → JWT 교체, `/legacy` mount 제거)
- 폴리싱 + 발표 준비

### ⚠️ 알려진 이슈
- **Python 3.13 + openai-whisper 빌드 실패** (`ModuleNotFoundError: No module named 'pkg_resources'`).
  해결 후보: ① `pip install setuptools wheel` 먼저 ② Python 3.11 별도 venv ③ `faster-whisper`로 교체.
  STEP 3 작업 시작 시 결정.

---

## 코딩 컨벤션 / 패턴

### 백엔드
- **새 모델**: `app/models/<domain>.py` 작성 → `app/models/__init__.py`에 re-export → `alembic revision --autogenerate -m "..."` → 파일 검토 → `alembic upgrade head`
- **새 라우터**: `app/api/<domain>.py`에 `APIRouter` → `app/main.py`에서 `include_router`
- **소유권 체크**: 라우터 진입 시 `_get_owned_session` 같은 헬퍼로 dev 사용자 소유 확인 (인증 만들면 JWT로 교체)
- **DB 세션**: `Depends(get_db)`로 주입
- **환경변수**: `app.core.config.settings`로 접근. `os.getenv` 직접 호출 X
- **임시 코드** (`_dev_auth.py`, `/legacy` mount): 파일명/경로에 `_` prefix나 명시 주석으로 임시성 표시

### git
- 커밋 메시지: 영문, 명령형 ("Add X", "Fix Y")
- 본문 있을 땐 "Why" 중심
- 관련 변경은 묶고, 무관한 건 분리
- 슬라이스 끝나면 PR → 짧은 리뷰 → main 머지 (1~2일 안에)
- gitignored: `_refs/`, `_legacy/`, `backend/uploads/*` (단 `.gitkeep`은 유지), `backend/.venv/`, `node_modules/`, `.next/`, `.env`

---

## 모르는 거 있으면 먼저 볼 곳

| 알고 싶은 것 | 어디 |
|---|---|
| 환경 세팅 / 트러블슈팅 | `_refs/환경세팅.md` |
| Postgres / psql / DBeaver 사용 | `_refs/Postgres사용법.md` |
| ERD (dbdiagram.io / Mermaid) | `_refs/erd.dbml`, `_refs/erd.md` |
| 프로젝트 전체 기획 + 파이프라인 | `_refs/프로젝트 설명.md` |
| 기술스택 / 데이터 모델 사양 | `_refs/프레임워크.md` |
| 중간발표 데모 코드 (참고용) | `_legacy/backend/main.py`, `_legacy/frontend/index.html` |
