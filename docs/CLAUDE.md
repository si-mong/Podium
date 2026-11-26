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
    - **사용자(주)**: 파이프라인 + 백엔드 전체
    - **팀원**: 파이프라인 + 프론트엔드 전체

### 개발 방식 — 하이브리드

1. **(현재 단계) 파이프라인 PoC 병렬** — 사용자=전처리/STT, 팀원=VLM. 함수 단위로 동작 검증
2. **수직 슬라이스** — 매주 한 기능을 (DB→API→파이프라인→프론트) 끝까지 구현해 데모 가능한 상태 유지
3. **인증** — ~~후반부에 `_dev_auth.py`를 JWT로 교체~~ **완료 (2026-09-18)**. `_dev_auth.py` 제거, JWT + refresh 회전

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
STEP 5  LLM 종합 피드백                                     팀원   ← (2026-09-18 변경)
```

의존성 그래프(번호와 무관):
```
STEP 1 (청크) ─┬─> STEP 2 VLM (청크별)
               └─> STEP 3 STT (full_audio)
                       └─> STEP 4 구간분리
                              └─> STEP 5 종합 (STEP 2+3 결과 다 사용)
```

→ STEP 1만 끝나면 사용자(STEP 3·4)와 팀원(STEP 2)이 진짜 병렬 가능. STEP 5는 팀원 담당이며 STEP 2~4 결과가 모두 필요하므로 마지막.

---

## 기술 스택

- **Backend**: FastAPI + SQLAlchemy 2.0 + Alembic + PostgreSQL 16 (Docker)
- **Frontend**: Next.js 14 (App Router, TS, Tailwind) — 페이지 미작성
- **AI/파이프라인 (`requirements-pipeline.txt`)**: Whisper, librosa, OpenCV, pdfplumber, OpenAI GPT-4o — 미설치
- **인증**: JWT (python-jose) + bcrypt. access 60분 / refresh 14일 회전. `app/core/security.py`, `app/api/auth.py`

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
│   │   │   ├── _deps.py               ★ 인증(Bearer) + 소유권 검사 공용 의존성
│   │   │   ├── auth.py                signup / login / refresh / logout / me
│   │   │   ├── projects.py            프로젝트 CRUD + 휴지통
│   │   │   └── sessions.py            세션 라이프사이클 + 분석 트리거
│   │   ├── models/                    SQLAlchemy 15 테이블 (6파일 분할) — ERD: docs/Dev-DB-erd.md
│   │   │   ├── user.py, project.py, session.py, analysis.py, comparison.py, analysis_event.py, __init__.py
│   │   ├── schemas/                   ★
│   │   │   ├── project.py
│   │   │   └── session.py
│   │   ├── services/                  ★
│   │   │   └── storage.py             세션별 파일 경로/IO 헬퍼
│   │   └── pipeline/                  ★
│   │       ├── step1_preprocess.py    ffmpeg: 청크 wav 추출 + concat + ffprobe duration
│   │       ├── step2_chunking.py      스마트 청킹 v2: motion 시계열 → 동적 청크 계획 → ffmpeg 추출
│   │       └── step2_video_analysis.py  Gemini VLM 동작 분석 (청크 병렬)
│   ├── alembic/
│   │   ├── env.py                     settings.database_url + Base.metadata 연결
│   │   └── versions/
│   │       ├── 444442f442c2_create_initial_tables.py    첫 마이그레이션 (10 테이블)
│   │       ├── b856588e40a8_add_chunk_analyses_...py     chunk_analyses 추가
│   │       └── c1a7d3e9f204_replace_chunk_analyses_...py chunk_analyses → video_analyses
│   ├── alembic.ini                    sqlalchemy.url 비움 (env.py에서 동적 로드)
│   ├── uploads/<session_id>/          영상/오디오 저장 (gitignored, .gitkeep만 트래킹)
│   │   ├── chunks/chunk_NNN.webm      업로드 청크 (30초 고정)
│   │   ├── audio/chunk_NNN.wav
│   │   ├── vlm_chunks/chunk_NNN.mp4   스마트 청킹 산출물 (재분석 시 덮어씀)
│   │   ├── full_video.webm            ← 스마트 청킹의 입력
│   │   ├── full_audio.wav
│   │   └── vlm_analysis.json
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
    └── (ERD 는 docs/Dev-DB-erd.md 로 이동)
```

---

## API 엔드포인트 (현재)

2026-11-27 기준 `backend/app/api/` 전체. 인증 표시 없는 건 전부 Bearer 토큰 필요 + 소유권 검사(`_deps.py`).
요청·응답 예시·에러·상태 머신은 **`docs/Dev-API명세.md`**, 필드 타입의 최종 진실은 서버의 `/docs`(OpenAPI).

**인증** (`auth.py`, `auth_google.py`)

| Method | Path | 설명 |
|---|---|---|
| GET | `/auth/providers` | 켜진 소셜 로그인 목록 (토큰 불필요) |
| GET | `/auth/google/login` → `/auth/google/callback` | 구글 로그인 리다이렉트 흐름 (토큰 불필요) |
| POST | `/auth/oauth/exchange` | 콜백이 넘긴 일회용 코드 → 토큰 쌍 |
| POST | `/auth/login` | 이메일+비밀번호 로그인 — **DEBUG 에서만** (이메일 가입은 없앰) |
| POST | `/auth/refresh` | refresh 회전 (1회 사용 후 폐기) |
| POST | `/auth/logout` | refresh 토큰 취소 |
| GET / PATCH | `/auth/me` | 내 정보 조회 / 프로필 저장 |

**폴더·추이** (`projects.py`)

| Method | Path | 설명 |
|---|---|---|
| GET | `/projects` | 내 폴더 목록 + 각 폴더의 세션 |
| POST | `/projects` | 폴더 생성 |
| PATCH | `/projects/{id}` | 이름 변경 |
| DELETE | `/projects/{id}` | 휴지통으로 (`deleted_at`) |
| GET | `/projects/trash` | 휴지통 목록 |
| POST | `/projects/{id}/restore` | 휴지통에서 복원 |
| DELETE | `/projects/{id}/purge` | 영구 삭제 (DB cascade + 파일) |
| GET | `/projects/{id}/trend` | 회차별 종합 추이 (성장 추이 그래프) |

**회차 비교** (`compare.py`)

| Method | Path | 설명 |
|---|---|---|
| GET | `/projects/{id}/compare?base=&target=` | 지표 비교(①) + 구간 정렬 비교(②) + 스크립트 — 저장 없이 그때그때 계산 |
| POST | `/projects/{id}/compare/feedback` | AI 비교 피드백(③) 생성 → `session_comparisons` 저장 |
| GET | `/projects/{id}/comparisons` | 지난 AI 비교 기록 목록 |
| DELETE | `/projects/{id}/comparisons/{comparison_id}` | 비교 기록 삭제 |

**세션 — 촬영·업로드** (`sessions.py`)

| Method | Path | 설명 |
|---|---|---|
| POST | `/projects/{id}/sessions/start` | 세션 시작 (회차 번호 부여 + uploads/ 폴더) |
| GET | `/projects/{id}/sessions` | 폴더의 세션 목록 |
| POST | `/sessions/{id}/chunks?chunk_index=N` | 30초 webm 청크 업로드 |
| POST | `/sessions/{id}/video` | 전체 연속 webm 업로드 (Stop 시 1회) |
| POST | `/sessions/{id}/video/rotate` | 촬영 후 방향 선택 → 서버에서 영상 회전 |
| POST | `/sessions/{id}/video/ticket` | `<video>` 태그용 단기 재생 티켓 발급 |
| GET | `/sessions/{id}/video` | 영상 스트리밍 (Range 지원, `?download=1` 이면 다운로드) |
| POST | `/sessions/{id}/end` | STEP 1 전처리 (ffmpeg → `full_audio.wav`), status=`preprocessed` |
| GET | `/sessions/{id}` | 세션 상세 + chunks |
| DELETE | `/sessions/{id}` | DB cascade 삭제 + uploads/ 폴더 삭제 |

**세션 — 분석 단계** (프론트 `frontend/src/utils/analysis.ts` 가 아래 순서로 호출. 단계마다 `analysis_events` 기록)

| 순서 | Method | Path | 설명 |
|---|---|---|---|
| 1 | POST | `/sessions/{id}/analyze/voice` | STEP 3 STT(SeloWhisper, Modal GPU) + 무음·필러·반복 → `stt_sentences`, `voice_raws` |
| 2 | POST | `/sessions/{id}/analyze/segments` | STEP 4 구간 분리(gpt-4.1) → `segments` + `segment_analyses` 음성 지표 |
| 3 | POST | `/sessions/{id}/analyze/motion-by-segment` | STEP 2 구간 기준 청킹(최대 1분) + VLM 동작 분석 → `video_analyses` 후 구간 집계 |
| 4 | POST | `/sessions/{id}/analyze/segment-feedback` | STEP 5 구간별 피드백(gpt-4.1) → `feedbacks` |
| 5 | POST | `/sessions/{id}/analyze/overall-feedback` | STEP 5 종합 피드백 → `session_summaries.llm_feedback` |
| – | POST | `/sessions/{id}/analyze/motion` | (구) 스마트 청킹 v2 기반 동작 분석. 프론트는 더 이상 안 씀 |

**세션 — 결과 조회**

| Method | Path | 설명 |
|---|---|---|
| GET | `/sessions/{id}/analysis` | 영상분석 결과 시간순 |
| GET | `/sessions/{id}/voice-summary` | 음성 지표 요약 |
| GET | `/sessions/{id}/script` | 인터랙티브 스크립트 (문장 + 무음·필러·반복) |
| GET | `/sessions/{id}/segment-feedback` | 구간별 AI 피드백 |
| GET | `/sessions/{id}/overall-feedback` | 종합 피드백 |
| GET | `/sessions/{id}/segments/trend` | 구간별 지표 그래프 데이터 |

**관리자** (`admin.py`, 전부 `is_admin` 필요)

| Method | Path | 설명 |
|---|---|---|
| GET | `/admin/health` | API 키 설정 여부 + 단계별 사용 모델 |
| POST | `/admin/health/{target}` | 외부 API(LLM·VLM·Modal) 실제 연결 점검 |
| GET | `/admin/analyses/stats` | 단계별 소요 시간·실패율 통계 |
| GET | `/admin/analyses` | 전체 회원 세션 목록 (최신순) |
| GET | `/admin/analyses/{session_id}` | 세션 하나의 실행 기록 + 분석 결과 |

**기타**: `GET /health` 헬스체크. DEBUG 모드일 때만 `/dev/?project=<id>` 에 `backend/dev_static/` 검증용 촬영 페이지가 mount 된다.

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

**15개 테이블** (2026-11-27 기준). 전체 ERD(Mermaid)·컬럼·삭제 정책 → **`docs/Dev-DB-erd.md`**. 변경 이력 → `docs/DB변경사항.md`.

| 영역 | 테이블 | 모델 파일 |
|---|---|---|
| 인증 | `users`, `oauth_accounts`, `refresh_tokens` | `user.py` |
| 콘텐츠 | `projects`, `sessions`, `chunks` | `project.py`, `session.py` |
| 분석 원본 | `video_analyses`, `stt_sentences`, `voice_raws` | `analysis.py` |
| 구간·종합 | `segments`, `segment_analyses`, `feedbacks`, `session_summaries` | `analysis.py` |
| 비교 | `session_comparisons` | `comparison.py` |
| 운영 | `analysis_events` | `analysis_event.py` |

| 결정 | 값 | 이유 |
|---|---|---|
| PK 타입 | `BigInteger` autoincrement (`refresh_tokens` 만 `jti` 문자열) | 단순함 |
| 타임스탬프 | `timestamptz`, `created_at` 은 `server_default=now()` | 필요한 곳에만 추가 |
| 소유 데이터 FK | `ondelete="CASCADE"` (DB) + ORM `cascade="all, delete-orphan"` | 회원 → 폴더 → 회차 → 분석 결과 |
| 기록성 FK | `SET NULL` | `session_summaries.best/worst_segment_id`, `session_comparisons.base/target_session_id`, `analysis_events.session_id/user_id` — 삭제돼도 요약·비교·통계 보존 |
| 폴더 삭제 | soft delete (`projects.deleted_at`) | 휴지통 복원. 하위 세션엔 아무것도 안 찍음 (`app/api/_deps.py`) |
| 회차 번호 | `sessions.session_no`, `(project_id, session_no)` 유일 | 앞 회차 지워도 번호 안 당겨지게 |
| JSON 컬럼 | PostgreSQL `JSONB` | 이벤트 배열·카운트 dict·LLM 출력. 정렬·집계용 값만 일반 컬럼으로 뺌 |
| 시간 | `Float` (초) | t_start, t_end |
| 카테고리·status | `String` semi-enum (DB enum 안 씀) | 허용 값은 코드에서 관리 → 값 바뀌어도 마이그레이션 불필요 |
| 1:1 관계 | 부모 ID를 PK로 (별도 PK 없음) | `voice_raws`, `segment_analyses`, `feedbacks`, `session_summaries` |
| 말 속도 | 음절 기준 SPM (`speaking_rate` 무음 포함 / `articulation_rate` 제외) | 한국어는 어절 수가 띄어쓰기에 따라 흔들림 |

**모델 도메인 분리**: 6분할 (`user.py`, `project.py`, `session.py`, `analysis.py`, `comparison.py`, `analysis_event.py`). 1:1 관계 테이블들은 부모 모델 옆에 묶어둠.

**파일 저장 구조**: `uploads/<session_id>/...` 평탄형 (project_id 안 끼움). 이유: session_id가 전역 unique → 경로 도출 O(1). 코드 단순.

### STEP 2 (VLM) 관련 결정 (2026-05-21)
- **`segment_analyses`** motion 필드 변경: posture/eye_contact/gesture (text) → `*_counts` JSONB 3개. **segment 단위 집계용** (STEP 4 후 채워짐).
- **호출 시점**: 옵션 B 채택 — `/sessions/{id}/analyze/motion` **별도 라우터** (`/end`는 전처리만). 이유: VLM이 수십초~분 단위라 `/end`에 묶으면 timeout 위험.
- **lazy import**: `from app.pipeline import step2_chunking, step2_video_analysis`를 라우터 함수 안에서 호출 → google-genai / opencv 미설치인 API 서버도 정상 기동.
- **VLM = Gemini 2.5-flash** (OpenAI GPT-4o 아님). `GEMINI_API_KEY` 필요.
- **카테고리 enum**: posture/eye_contact/gesture는 semi-enum 자유 텍스트 (프롬프트에서 4종/3종/4종 옵션 강제).
- 자세한 비교/결정 근거 → `_refs/카테고리 enum 저장 방침.md`

### ★ "청크"의 세 가지 의미 — 층 분리 (2026-08-18)

`청크`가 전송/영상분석/음성분석 세 층에서 다른 뜻으로 쓰이고 있었다. 스키마가
전송 청크와 영상분석 청크를 FK 하나로 묶고 있어서 스마트 청킹을 붙일 수 없었다.

| 층 | 뜻 | 단위 | 어디 |
|---|---|---|---|
| 전송 | 녹화 중 스트리밍 업로드 | 30초 **고정** | `chunks` 테이블, `chunks/chunk_NNN.webm` |
| 영상분석 | 동작 구간 | **동적** 20초 (intro/motion/outro) | `step2_chunking.py`, `video_analyses` 테이블 |
| 음성분석 | (미래) 정적 윈도우 | 미정 | 아직 없음 |

**규칙: 분석 결과 테이블은 "무엇을 분석했나"로 이름 짓고, 자른 단위는
`t_start`/`t_end` 컬럼이 표현한다.** 그래야 영상/음성이 각자 청킹 정책을 골라도
서로 안 부딪힌다. `chunks` 는 전송 단위라는 원래 뜻으로 두고, 분석 테이블은
`chunk` 라는 단어를 쓰지 않는다.

- **`chunk_analyses` → `video_analyses`** (리비전 `c1a7d3e9f204`): `chunk_id` FK 제거,
  `analysis_id` PK + `session_id` FK + `t_start`/`t_end`/`kind` 추가. `stt_sentences`
  가 이미 쓰던 패턴과 동일해짐.
- **부수 효과 (버그 수정)**: 기존 코드는 `chunk_id` UPSERT 라 재분석 시 청크 수가
  줄면 이전 회차 행이 남았다. 이제 `DELETE WHERE session_id` → INSERT.
- `Chunk.analysis` relationship 제거, `Session.video_analyses` 추가.

### 스마트 청킹 통합 (2026-08-18)
- `/analyze/motion` 입력이 **업로드 청크 → `full_video.webm`** 으로 바뀜. 스마트 청킹은
  동작 시작 임의 시점부터 자르므로 30초 격자에 갇히면 안 된다. full_video 없으면 400.
- 흐름: `step2_chunking.plan_and_extract()` (motion 시계열 → 청크 계획 → ffmpeg 추출,
  `vlm_chunks/`) → `step2_video_analysis.run()` (Gemini 병렬) → `video_analyses` 저장.
- `plan[i]` 와 `VLM_segment_result[i]` 가 같은 청크임이 계약 (청크 파일명이 0패딩
  1-based 라 사전순 = 시간순).
- **gesture_counts 7종** 으로 확정 (vlm_test PoC 결과). 이전 9종에서:
  `hand_movement`→`explanatory_gesture`, `negative_hand_movement`→`distracting_gesture`,
  `arms_crossed`→`closed_posture`, `head_nodding`/`leaning_forward` 제거.
- ffmpeg 는 `-c copy` 가 아니라 **재인코딩**(libx264 ultrafast). MediaRecorder webm 은
  키프레임이 희소해 copy 로 자르면 청크 앞부분이 깨진다.
- 튜닝값: `motion_thresh=3.5`, `hysteresis_frames=5`, `chunk_duration=20`, `sample_fps=5`.
  → **임계값은 재검토 중**. 아래 참고.

### ⚠️ webm 의 CAP_PROP_FPS 함정 (2026-08-19 수정)

**MediaRecorder 가 만든 webm 은 OpenCV 에 `CAP_PROP_FPS = 1000` 을 돌려준다.**
프레임레이트가 아니라 Matroska 타임베이스(1ms)다. `CAP_PROP_FRAME_COUNT` 도
프레임 수가 아니라 밀리초를 돌려준다 (102초 영상 → 102546, 실제 프레임은 3078).

원래 코드는 `step = src_fps // sample_fps` 로 프레임을 건너뛰었는데, 이러면
`step = 200` 이 되어 **6.7초 간격**으로 비교하게 된다. 0.2초 간격을 가정한
`motion_thresh` 가 완전히 무의미해진다 (motion 평균이 임계값의 7배로 나옴).

**수정**: `video_motion_timeline()` 이 프레임 인덱스가 아니라 **타임스탬프
(`CAP_PROP_POS_MSEC`)** 로 샘플링한다. 컨테이너 메타데이터가 틀려도 실제 0.2초
간격이 보장된다. `_sane_fps()` 는 1~120 범위 밖의 FPS 를 거부하고 30 으로 폴백
(타임스탬프가 아예 없는 컨테이너용). 건너뛸 프레임은 `grab()` 으로 색변환을 생략한다.

**`vlm_test/scoring.py` 에도 같은 버그가 남아 있다** (`motion_score()` 77~88행,
`video_motion_timeline()` 206~216행). mp4 를 올릴 땐 안 터지지만 `/smart-preview`
에 webm 을 넣으면 똑같이 망가진 시계열이 나온다. 임계값 튜닝 시 주의.

> STEP 3 도 같은 webm 을 다룬다. 오디오 경로는 ffmpeg 을 쓰므로 무관하지만,
> OpenCV 로 webm 을 여는 코드를 새로 짤 때는 이 함정을 먼저 떠올릴 것.

### 임계값 실측 — 3.5 는 시스템 촬영본에 안 맞음 (2026-08-19)

`motion_thresh=3.5` 는 vlm_test 에서 **업로드한 mp4** 로 튜닝한 값이다. 5월 시스템
촬영본(1280x720 webcam webm) 3개로 재측정하니 motion **중앙값이 3~4** 였다.
즉 3.5 가 중앙값 한복판이라 샘플의 절반이 "동작 중"으로 잡힌다.
노이즈 바닥(p10)은 약 1.5 로 vlm_test 와 비슷하다.

| thresh | s1 | s3 | s4 |
|---|---|---|---|
| **3.5** (현재) | 22.9% | 16.2% | 15.5% |
| 7.0 | 30.7% | 39.4% | 41.5% |
| **8.0** | 41.2% | 39.4% | 41.5% |
| 12.0 | 24.6% | 62.1% | 41.5% |

8.0 에서 세 영상 모두 ~40% 로 안정적. 12 이상은 청크 시작점이 크게 밀리면서
배치가 뒤바뀌어 들쭉날쭉해진다(s1 이 24.6%→62.3%).

**아직 3.5 그대로 두었다.** 표본이 3개뿐이고, 임계값을 올리면 진짜 동작을 놓칠
위험도 같이 오르므로 실제 영상 확인 후 결정하기로 함. 값은
`step2_chunking.py:29 MOTION_THRESH` 한 곳만 고치면 전체 반영된다
(`/analyze/motion` 은 이 인자를 넘기지 않는다). vlm_test 에는 별도 사본이 있다.

---

## VLM 정적 테스트 도구 (`backend/vlm_test/`) ★ test/vlm 브랜치

본 흐름(시스템 촬영 → sessions API)과 **완전히 분리된** 검증용 도구. DB 연결 없음. 2026-09-16 부터 STEP 3 음성 테스트 도구와 **한 서버로 통합**되어 `http://localhost:8001/vlm/` 에서 접속. 이미 촬영된 영상 파일을 업로드해 VLM(Gemini) 동작 분석과 **청킹 정책 실험**을 빠르게 반복하기 위한 도구. STEP 2 본격 통합 전 PoC 단계.

### 실행
```bash
# cwd = backend/
pip install -r requirements-vlm.txt        # google-genai, python-dotenv, opencv-python-headless
# .env 에 GEMINI_API_KEY 필요 (https://aistudio.google.com/apikey)
# 통합 개발 테스트 서버 (STEP 2 /vlm, STEP 3 /voice)
uvicorn devtools.server:app --reload --port 8001
```

> 포트 8000 은 본 API 서버(`app.main:app`)라 겹치면 안 됨.

### 모듈 구성
| 파일 | 책임 |
|---|---|
| `server.py` | FastAPI 엔드포인트 + SSE 푸시 + `/media`,`/static` mount. DB 안 씀. job별 `work/<job_id>/` 에 결과 저장 |
| `analyzer.py` | Gemini 호출 로직. `run_analysis`(30초 고정 청크) / `run_smart_analysis`(스마트 청킹). 둘 다 `_process_one_chunk` 공유 (업로드→분석→재시도→파싱). `gemini-2.5-flash`, `response_mime_type=application/json`, 청크 병렬(ThreadPoolExecutor), 청크당 `MAX_RETRIES=5` |
| `scoring.py` | VLM **호출 전** 경량 스코어 + 청킹 계획. OpenCV motion_score + ffmpeg audio dB. 스마트 청킹 핵심 로직 |
| `static/*.html`, `nav.js` | 9개 페이지 (분석/프리뷰/스마트 + 각 history). 바닐라 JS, SSE 수신 |

### 페이지 (브라우저)
| URL | 용도 |
|---|---|
| `/` | 영상 업로드 → 30초 고정 청크 → Gemini 분석. SSE 실시간 |
| `/preview` | **VLM 호출 없이** 청크별 motion/audio 스코어만. 임계값 슬라이더로 절감률 시뮬 |
| `/smart-preview` | v2 스마트 청킹 PoC. 영상 전체 motion 시계열 + 청크 계획 시각화 (슬라이더 튜닝, 서버 왕복 없이 JS 계산) |
| `/smart-analyze` | **★ 스마트 청킹 + VLM 통합** — 동적 청크 → ffmpeg 추출 → Gemini. 본 파이프라인 STEP 2 후보 |
| `/{...}/history` | 각 종류별 완료 케이스 목록 + 상세 재현 |

### 핵심 결정 — 청킹 정책 (스코어링)
- **목적**: VLM 호출은 청크당 5~30초 + 비용 → 의미 없는 청크를 **호출 전에** 걸러 절감.
- **motion_score** (`scoring.py`): 5fps 다운샘플 + 그레이스케일 + `cv2.absdiff` 프레임 차 평균. 경험적 분포 — 1~2 거의 정지, 2~5 서서 말함, 5~10 가벼운 손동작, 10~20 활발, 20+ 큰 이동.
- **audio_db**: ffmpeg `volumedetect` mean_volume. 무음 판정 보조.
- **v1 `classify_chunks`** (고정 30초 청크 KEEP/SKIP): `is_static = motion<thresh AND audio<thresh`. 동적=무조건 KEEP, 정적 연속이면 SKIP, 시작/끝/주기적(`max_consec_skip=4`) 강제 KEEP.
- **v2 `smart_chunk_plan`** (교수 면담 피드백): 고정 청크 대신 **동작 시작 시점부터** `chunk_duration`(기본 20s) 청크를 잘라냄. 정적 구간은 청크 자체를 안 만들어 ffmpeg+VLM 둘 다 절감.
    - `intro` 0~chunk_duration 강제 / `motion` hysteresis(`hysteresis_frames=5` 연속 초과) 감지 후 시작 / `outro` 마지막 chunk_duration 강제. 정적은 길어도 강제 청크 안 만듦(4B 실험).
    - 튜닝 파라미터: `motion_thresh=3.5`, `hysteresis_frames=5`, `chunk_duration=20` (smart-analyze 쿼리스트링으로 조정).

### 결과 저장 (`work/<job_id>/`, gitignored)
`meta.json`(kind: analyze/preview/smart-preview/smart-analyze) + `input.<ext>` + `chunks/` + 종류별 산출물(`result.json`/`preview.json`/`smart.json`) + `log.jsonl`(SSE 이벤트 로그, history 재현·소요시간 계산에 사용).

### 본 파이프라인과의 관계 (2026-08-18 역이식 완료)
- `vlm_test/`는 **버려질 실험장**. v2 청킹 정책과 7종 프롬프트가 본 파이프라인으로 **역이식 끝남**:
    - `scoring.py` v2 로직 → `app/pipeline/step2_chunking.py`
    - `analyzer.py:_PROMPT` + `_GESTURE_KEYS` 7종 → `app/pipeline/step2_video_analysis.py`
- v1 `classify_chunks`(고정 30초 KEEP/SKIP)는 **폐기** — 옮기지 않았다.
- 역이식 시 달라진 점: webm 원본이라 ffmpeg `-c copy` 대신 재인코딩, `end_sec` 를
  영상 길이로 clamp, ffprobe 실패 시 `duration_fallback`(full_audio 길이) 사용.
- 이제 vlm_test 는 **튜닝 파라미터 실험용으로만** 유지. 본 파이프라인이 정답.

---

## 진행 상황

> 2026-11-27 기준. 세부 결정 근거는 위 섹션들과 `docs/Dev-*.md`, 이력은 git log / PR 참고.

### ✅ 완료 — 전체 흐름이 운영 중
- **배포**: https://podium-it.co.kr — 프론트 Vercel(Next.js 14), 백엔드 AWS EC2 Docker(Caddy + FastAPI + PostgreSQL). 배포는 main 기준 (`deploy/`, `docs/_CD.md`)
- **파이프라인 STEP 1~5 전부 연결** (프론트가 단계를 순서대로 호출, 위 API 표 참고)
    - STEP 1 전처리: ffmpeg 청크 wav 추출 + concat
    - STEP 2 동작: 구간 기준 청킹(`step2_segment_chunking.py`, 최대 1분) + Gemini VLM(`gemini-3.8-flash`). 스마트 청킹 v2(`/analyze/motion`)는 남아 있지만 프론트는 안 씀
    - STEP 3 음성: SeloWhisper(`hf:rearleg/SeloWhisper-ko-disfluency`) STT 를 Modal 서버리스 GPU 에서 실행 + 무음·필러·반복(말더듬) 검출, 말 속도는 음절(SPM) 기준
    - STEP 4 구간 분리: gpt-4.1 (Gemini 에서 변경, 2026-10-23)
    - STEP 5 피드백: gpt-4.1 구간별(잘한 점·개선점·등급) + 종합
- **인증**: JWT(access 60분 / refresh 14일 회전) + 구글 로그인, 이메일 가입 폐지. 첫 로그인 후 프로필(선택 입력)
- **회차 비교**: 지표 레이더 차트 · 구간 정렬 비교 · AI 비교 피드백(저장, 재분석 감지) · 지난 비교 기록 (`docs/Dev-비교분석.md`)
- **화면**: 랜딩(돋보기 데모·단 이동·자동 이동), 내 기록(폴더·세션·종합추이), 단일 분석 대시보드(종합 피드백·구간별 지표·영상 타임라인·스크립트·구간별 AI 피드백), 회차 비교, 휴지통, 내 정보, 다크모드
- **촬영**: 배경 블러(MediaPipe), 전면·후면 카메라 전환, 촬영 후 방향 선택·서버 회전, 영상 다운로드, 녹화 앞뒤 15초 무음 무시
- **관리자**: 외부 API 연결 점검, 단계별 소요 시간·실패 통계, 세션별 실행 기록 (`analysis_events`)
- **DB**: 15개 테이블 — `docs/Dev-DB-erd.md`

### ⏭️ 남은 작업 후보
- 동작 분석 속도: ffmpeg 청크 추출(`-ss` 위치·해상도 축소)과 Gemini 병렬도 개선은 배포됨. 동시 사용자 재테스트 결과 확인과 동작 분석 세부 시간(`detail`) 기록은 아직
- STEP 5 규칙 후보 (미결정): 습관 필러 강조, headline 잘한 점/고칠 점 비중을 구간 등급 기반으로, 부정 제스처 판정 기준
- 비교 화면의 "두 회차의 분석 방식이 달라요" 경고: 화면에서만 숨김 상태 (API `warnings` 는 그대로)
- 정리: `podium_outline` 테스트 DB·`backend/uploads_outline_test/`, sslip.io 제거, 업로드 속도 개선
- `/dev` mount 와 `backend/dev_static/` 제거 (본 촬영 페이지가 대체함)
- 폴리싱 + 발표 준비

### ⚠️ 알려진 이슈 · 미확인
- iPhone(WebKit)에서 화면 방향 고정을 켜면 세로 영상으로 녹화됨 → 촬영 후 방향 선택 카드로 대응. 실기기에서 회전 시간·다운로드는 미확인
- STT 반복 환각 재전사(Modal 배포됨)는 심한 말더듬 영상으로 미검증
- 음성 분석 Modal `max_containers=3` — 동시 사용자가 많으면 GPU 대기 발생
- `MOTION_THRESH=3.5`(스마트 청킹 v2 전용)는 시스템 촬영본에 안 맞음 — 현재 흐름(구간 기준 청킹)은 이 값을 쓰지 않음

---

## 코딩 컨벤션 / 패턴

### 백엔드
- **새 모델**: `app/models/<domain>.py` 작성 → `app/models/__init__.py`에 re-export → `alembic revision --autogenerate -m "..."` → 파일 검토 → `alembic upgrade head`
- **새 라우터**: `app/api/<domain>.py`에 `APIRouter` → `app/main.py`에서 `include_router`
- **인증/소유권**: 라우트에 `user_id: int = Depends(get_current_user_id)` 를 받아 `get_owned_project/session(db, id, user_id)` 에 넘긴다. 둘 다 `app/api/_deps.py`
- **DB 세션**: `Depends(get_db)`로 주입
- **환경변수**: `app.core.config.settings`로 접근. `os.getenv` 직접 호출 X
- **임시 코드** (`/dev` mount 등): 파일명/경로에 `_` prefix나 명시 주석으로 임시성 표시

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
| ERD (Mermaid) / DB 설계 원칙 | `docs/Dev-DB-erd.md` |
| 프로젝트 전체 기획 + 파이프라인 | `_refs/프로젝트 설명.md` |
| 기술스택 / 데이터 모델 사양 | `_refs/프레임워크.md` |
| 중간발표 데모 코드 (참고용) | `_legacy/backend/main.py`, `_legacy/frontend/index.html` |
