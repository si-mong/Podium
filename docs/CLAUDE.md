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
| POST | `/sessions/{session_id}/analyze/motion` | STEP 2 스마트 청킹 + VLM 동작 분석 → `video_analyses` 행 생성, status='analyzed'. **full_video 필요** |
| GET | `/sessions/{session_id}/analysis` | 영상분석 결과 시간순 조회 |
| GET | `/sessions/{session_id}` | 세션 + chunks 배열 |
| DELETE | `/sessions/{session_id}` | DB 행 cascade 삭제 + uploads/ 폴더 삭제 |

DEBUG 모드일 때 `/dev/?project=<id>` mount — `backend/dev_static/index.html` 임시 서빙 (촬영 + STEP 1/2 검증용). 슬라이스 1에서 Next.js 촬영 페이지 만들면 mount + `dev_static/` 디렉터리 제거.

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
| JSON 컬럼 | PostgreSQL `JSONB` | `silence_segments`, `filler_words`, `llm_feedback` |
| 시간 | `Float` (초) | t_start, t_end |
| status | `String(32)` 기본값 `"processing"` | Enum 정리는 추후 |
| 1:1 관계 | 부모 ID를 PK로 (별도 PK 없음) | `voice_raws`, `segment_analyses`, `feedbacks`, `session_summaries` |

**모델 도메인 분리**: 4분할 (`user.py`, `project.py`, `session.py`, `analysis.py`). 1:1 관계 테이블들은 부모 모델 옆에 묶어둠.

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

### ✅ 완료
- 인프라: Backend/Frontend 스캐폴드, Postgres docker, requirements 분리
- DB: SQLAlchemy 모델 + Alembic 초기 마이그레이션 + 2차 마이그레이션(chunk_analyses 추가) 적용
- 전처리 (STEP 1):
    - `pipeline/step1_preprocess.py` — ffmpeg 청크 wav 추출 + concat + ffprobe duration
    - `services/storage.py` — 파일 경로/IO
    - `schemas/project.py`, `schemas/session.py`
    - `api/projects.py`, `api/sessions.py`
    - `api/_dev_auth.py` — 임시 더미 사용자 시드 (lifespan에서 자동 실행)
    - `backend/dev_static/index.html` — 시스템 촬영 검증용 정적 페이지
    - **STEP 1 end-to-end 검증 통과** (촬영 → 청크/영상 저장 → DB → ffmpeg 전처리 → full_audio.wav)
- **STEP 2 VLM (Gemini 2.5-flash) 통합** (2026-05-21~22):
    - `pipeline/step2_video_analysis.py` — Gemini File API 업로드 + 분석 + 결과 dict (MAX_ATTEMPTS=3 재시도)
    - 모델: `segment_analyses` 컬럼 옵션 B로 refactor + `chunk_analyses` 신규 테이블 (→ 2026-08-18 `video_analyses` 로 대체)
    - 라우터: `POST /sessions/{id}/analyze/motion` (lazy import — google-genai 없어도 server 동작)
    - `/end`는 전처리만 책임지도록 복원 (status=preprocessed)
    - `dev_static/index.html`에 "Analyze motion (VLM)" 버튼 추가
    - `test_step2.py` 보안 정리 (API 키 .env 이동, Windows 경로 → STEP2_TEST_VIDEO 환경변수)
    - **STEP 2 end-to-end 검증 통과** (촬영 → /end → /analyze/motion → DB INSERT)

### 🟡 현재 브랜치
- `test/vlm` — VLM 정적 테스트 도구(`backend/vlm_test/`) + 스마트 청킹. 위 "VLM 정적 테스트 도구" 섹션 참고.
    - **스마트 청킹 v2 본 파이프라인 역이식 완료** (2026-08-18): `step2_chunking.py` 신규,
      `/analyze/motion` 이 full_video 기반 동적 청킹으로 전환, gesture 7종 확정.
    - **`chunk_analyses` → `video_analyses` 스키마 교체** (리비전 `c1a7d3e9f204`).
      위 "청크의 세 가지 의미" 섹션이 근거.
    - ✅ 마이그레이션 적용 완료 (`alembic upgrade head`, downgrade 왕복도 확인).
    - ✅ 5월 녹화본 3개로 청킹 실측: 타임스탬프 샘플링(473점 @0.217초), ffmpeg 추출
      5개 청크 계획 대비 오차 20ms 이내, 재인코딩 mp4 정상.
    - ⚠️ **Gemini 까지 태우는 end-to-end 미검증** (과금 발생분이라 사용자가 직접 진행 예정).
    - ⚠️ `MOTION_THRESH` 는 3.5 그대로 — 위 "임계값 실측" 참고, 결정 대기.
    - `docs/_CD.md` 신규 추가됨.
- (이전) `feat/pipeline-step2-vlm` — STEP 2 본 파이프라인 통합 → main 머지 완료

### ⏭️ 다음 작업 후보

**바로 다음 후보** (1~2일):
- (선택) VLM 결과 캐시: `/analyze/motion` 재호출 시 `vlm_analysis.json`이 있으면 Gemini 다시 안 부르고 그걸 읽어 DB INSERT만. **VLM 호출 비용 절약 + 디버깅 편의**.
- (선택) chunk_analyses 응답 스키마 보강 (현재 MotionAnalysisResult는 메타만)

**파이프라인 PoC 마무리**:
- **사용자**: STEP 3 (Whisper STT + 음성 수치화 — filler/silence/wpm)
    - Python 3.13 + whisper 이슈 해결 우선 (아래 알려진 이슈 참고)
    - 함수 단위로 검증 (input: full_audio.wav, output: STT 문장 + voice_raw dict)

**수직 슬라이스 단계** (3주~):
- 슬라이스 1: 영상 업로드 + STT 자막 표시 (사용자 백 / 팀원 프론트)
- 슬라이스 2: VLM 동작 분석 결과를 프론트에 표시
- 슬라이스 3: STEP 4 LLM 구간 분리 (segments + chunk_analyses → segment_analyses 집계)
- 슬라이스 4: STEP 5 LLM 종합 피드백
- 슬라이스 5: 회차 비교 + 추세

**후반부**:
- 인증 (`_dev_auth.py` → JWT 교체, `/dev` mount 제거)
- 폴리싱 + 발표 준비

### ⚠️ 알려진 이슈
- **Python 3.13 + openai-whisper 빌드 실패** (`ModuleNotFoundError: No module named 'pkg_resources'`).
  해결 후보: ① `pip install setuptools wheel` 먼저 ② Python 3.11 별도 venv ③ `faster-whisper`로 교체.
  STEP 3 작업 시작 시 결정.
- **VLM 결과 캐시 없음** — `/analyze/motion` 호출 시 항상 Gemini 다시 부름 (vlm_analysis.json 있어도 무시). DB INSERT 실패 시 비싼 재호출 발생. 위 "바로 다음 후보" 참고.

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
