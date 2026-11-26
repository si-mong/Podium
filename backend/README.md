# Podium Backend

FastAPI API 서버 + AI 분석 파이프라인 (STEP 1~5). 2026-11-27 기준.

- API 상세: [docs/Dev-API명세.md](../docs/Dev-API명세.md) · 실행 중이면 http://localhost:8000/docs
- 단계별 데이터 흐름: [docs/Design-시스템흐름.md](../docs/Design-시스템흐름.md)
- DB: [docs/DB-erd.md](../docs/DB-erd.md) · [docs/DB-변경이력.md](../docs/DB-변경이력.md)

## 스택

Python 3.11+ (배포 이미지 3.13) · FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL 16 · JWT(python-jose) + bcrypt + 구글 OAuth

| 단계 | 하는 일 | 모델·도구 |
|---|---|---|
| STEP 1 | 전처리 — 오디오 추출 | ffmpeg |
| STEP 3 | STT + 무음·필러·반복·말 속도 | SeloWhisper (로컬 또는 Modal 서버리스 GPU), librosa |
| STEP 4 | 구간 분리 + 구간별 집계 | gpt-4.1 |
| STEP 2 | 구간 기준 동작 분석 | Gemini (VLM) |
| STEP 5 | 구간별 + 종합 피드백 | gpt-4.1 |
| 비교 | 두 회차 AI 비교 피드백 | gpt-4.1 |

실행 순서는 STEP 1 → 3 → 4 → 2 → 5 (번호는 기획 때 매긴 것).

## 로컬 실행

```bash
# 저장소 루트에서 Postgres
docker compose up -d postgres

# 여기(backend/)에서
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-pipeline.txt   # 파이프라인(PyTorch 포함)까지
cp .env.example .env            # OPENAI_API_KEY, GEMINI_API_KEY 등
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

- `requirements.txt` 만 깔아도 서버는 뜬다 (파이프라인 모듈은 라우터 안에서 lazy import). 분석을 돌리려면 `requirements-pipeline.txt` 필요.
- 시스템에 **ffmpeg** 필요.

### 주요 환경변수 (`.env`)

| 이름 | 설명 |
|---|---|
| `DEBUG` | `true` 면 이메일 로그인과 `/dev` 검증 페이지가 열린다. 배포는 `false` |
| `DATABASE_URL` | 기본 `postgresql+psycopg://podium:podium@localhost:5432/podium` |
| `OPENAI_API_KEY` | STEP 4·5, 비교 피드백 |
| `GEMINI_API_KEY` | STEP 2 동작 분석 |
| `WHISPER_MODEL` | `hf:<모델>` 이면 이 컴퓨터에서(맥은 MPS), `modal:<모델>` 이면 Modal GPU 에서 STT |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | `modal:` 일 때 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 구글 로그인. 리디렉션 URI `<API_PUBLIC_URL>/auth/google/callback` |
| `API_PUBLIC_URL` / `FRONTEND_URL` | 구글 로그인 콜백·프론트 복귀 주소 |
| `CORS_ORIGINS` | 허용할 프론트 주소 (쉼표 구분) |
| `JWT_EXPIRE_MINUTES` / `JWT_REFRESH_EXPIRE_DAYS` | access 60분 / refresh 14일 |
| `UPLOAD_DIR` | 업로드 저장 위치, 기본 `./uploads` |

전체 목록은 [`.env.example`](./.env.example), 설정 클래스는 `app/core/config.py`.

## 폴더 구조

```
backend/
├── app/
│   ├── main.py            FastAPI 엔트리 (CORS, 라우터, DEBUG 시 /dev)
│   ├── core/              config(.env), database, security(JWT·영상 재생 티켓)
│   ├── api/               auth · auth_google · projects · sessions · compare · admin, _deps(인증·소유권)
│   ├── models/            SQLAlchemy 15 테이블
│   ├── schemas/           요청·응답 스키마
│   ├── services/          storage(파일 경로) · streaming(Range) · compare(회차 비교 계산) · analysis_log(실행 기록)
│   ├── pipeline/          step1~5, voice/(STEP 3 코어: vad·stt·filler·stutter), compare_feedback
│   └── scripts/set_admin.py
├── alembic/               마이그레이션 (22개, head b8d4f2a6c9e1)
├── modal_stt.py           STT 를 Modal GPU 앱으로 배포
├── Dockerfile             배포 이미지 — 시작 시 alembic upgrade head 후 uvicorn
├── devtools/server.py     개발 테스트 서버 (:8001) — /vlm(STEP 2), /voice(STEP 3·4)
├── vlm_test/, stt_test/   실험·튜닝 도구 (DB 안 씀)
├── dev_static/            DEBUG 일 때 /dev 로 뜨는 초기 촬영 검증 페이지 (제거 예정)
└── uploads/<session_id>/  영상·오디오·분석 산출물 (gitignored)
```

## 자주 쓰는 명령

```bash
# 마이그레이션
alembic revision --autogenerate -m "<설명>"   # 모델 변경 후 — 파일 꼭 검토, docs/DB-변경이력.md 에 기록
alembic upgrade head
alembic heads                                 # 2개 이상이면 alembic merge

# 관리자 지정 / 해제
python -m app.scripts.set_admin user@example.com
python -m app.scripts.set_admin user@example.com --revoke

# STT Modal 앱 배포 (modal token 필요)
modal deploy modal_stt.py

# 개발 테스트 서버 (DB 안 씀)
uvicorn devtools.server:app --reload --port 8001
```

## 배포

EC2 에서 `deploy/docker-compose.prod.yml` (Caddy 자동 HTTPS + api + postgres) 로 띄운다. main 기준.

```bash
cd Podium && git pull
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
```

마이그레이션은 컨테이너 시작 때 자동 적용된다. 자세한 절차는 로컬 전용 `deploy/README.md`.

## 더 보기

- 팀원용 빠른 시작·자주 막히는 곳: [docs/개발가이드.md](../docs/개발가이드.md)
- 결정 배경·진행 상황·컨벤션: [docs/CLAUDE.md](../docs/CLAUDE.md)
