# 세션 상태 — 스마트 청킹 본 파이프라인 통합 + 스키마 교체

> 2026-08-18 ~ 08-19 세션. 다음 세션에서 컨텍스트 빠르게 잡기 위한 스냅샷.
> 프로젝트 전체 가이드는 `docs/CLAUDE.md` 참조. 날짜별 작업 로그는 `_refs/flow-작업흐름.md`.
>
> (이전 스냅샷: 2026-06-01~02 vlm_test 도구 + 면담 자료 — 아래 "이전 세션에서 넘어온 것" 참조)

---

## 한 줄 요약

vlm_test 에서 실험하던 **스마트 청킹 v2 를 본 파이프라인으로 역이식**하고,
그 과정에서 걸림돌이던 **`chunk_analyses` → `video_analyses` 스키마 교체**까지 끝냄.
Gemini 과금이 붙는 end-to-end 만 남음. 이어서 STEP 3(STT) 착수.

---

## 어디까지 했나

### 1. "청크" 개념 층 분리 (이번 세션의 핵심 결정)

`청크` 가 세 층에서 다른 뜻으로 쓰이고 있었고, 스키마가 그중 둘을 FK 하나로
묶어놔서 스마트 청킹을 붙일 수 없었다.

| 층 | 뜻 | 단위 |
|---|---|---|
| 전송 | 녹화 중 스트리밍 업로드 | 30초 **고정** (`chunks` 테이블) |
| 영상분석 | 동작 구간 | **동적** 20초 (`video_analyses` 테이블) |
| 음성분석 | (미래) 정적 윈도우 | 미정 |

**규칙: 분석 결과 테이블은 "무엇을 분석했나"로 이름 짓고, 자른 단위는
`t_start`/`t_end` 컬럼이 표현한다.** 영상/음성이 각자 청킹 정책을 골라도 안 부딪힘.

근거가 된 관찰 두 가지:
- `stt_sentences` 는 **이미** `session_id + t_start/t_end` 패턴이고 chunk FK 가 없었다.
  chunk FK 를 쓰는 분석 테이블은 `chunk_analyses` 하나뿐 — 그게 예외였다.
- 조회 API 가 이미 `chunk.t_start/t_end` 를 빌려 쓰고 있었다. 소비자가 원한 건
  처음부터 시간 범위였다.

### 2. 스키마 교체 (alembic `c1a7d3e9f204`)

```
chunk_analyses (chunk_id PK, FK→chunks)
  ↓
video_analyses (analysis_id PK, session_id FK, t_start, t_end, kind, ...)
```

- 분석 값 5개(posture / eye_contact / gesture / gesture_counts / notes)는 **그대로**.
  바뀐 건 "이 결과가 영상의 어디를 본 것인가"의 표현 방식뿐.
- `Chunk.analysis` relationship 제거, `Session.video_analyses` 추가
- **부수 효과 (버그 수정)**: 기존엔 `chunk_id` UPSERT 라 재분석 시 청크 수가 줄면
  이전 회차 행이 남았다. 이제 `DELETE WHERE session_id` → INSERT.
- 기존 4행(5월 검증 데이터, 옛 키셋)은 이관 안 함. 백업만 떠둠.

### 3. 스마트 청킹 역이식

`vlm_test/scoring.py` v2 로직 → **`backend/app/pipeline/step2_chunking.py`** (신규).
v1 `classify_chunks`(고정 30초 KEEP/SKIP)는 폐기라 안 옮김.

`/analyze/motion` 의 입력이 **업로드 청크 → `full_video.webm`** 으로 바뀜.
스마트 청킹은 동작 시작 임의 시점부터 자르므로 30초 격자에 갇히면 안 됨.
full_video 없으면 400.

역이식하며 달라진 점:
- webm 원본이라 ffmpeg `-c copy` 대신 **재인코딩**(키프레임 희소 → copy 시 앞부분 깨짐)
- `end_sec` 를 영상 길이로 clamp
- ffprobe 실패 시 `duration_fallback`(full_audio 길이) 사용

### 4. gesture_counts 7종 확정

`main` 기준 10종 → 7종. `hand_movement`+`emphasizing_hand_movement`→`explanatory_gesture`,
`distracting_gesture` 신설, `arms_crossed`→`closed_posture`, `swaying_body`→`body_movement`,
`head_nodding`/`leaning_forward`/`scratching` 제거.

### 5. webm CAP_PROP_FPS 버그 발견·수정

**MediaRecorder webm 은 `CAP_PROP_FPS = 1000` 을 돌려준다** (프레임레이트가 아니라
Matroska 타임베이스 1ms). `step = fps // sample_fps = 200` 이 되어 **6.7초 간격**으로
비교하고 있었다. 0.2초를 가정한 `motion_thresh` 가 완전히 무의미했던 상태.

→ 프레임 인덱스 대신 **타임스탬프(`CAP_PROP_POS_MSEC`) 기준 샘플링**으로 수정.
473점 @ 0.217초 간격으로 정상화됨.

⚠️ **`vlm_test/scoring.py` 에는 같은 버그가 그대로 있다** (77~88, 206~216행).
`/smart-preview` 에 webm 넣으면 똑같이 망가진다.

---

## 검증 상태

| 항목 | 상태 |
|---|---|
| 전 파일 import / SQLAlchemy 매핑 | ✅ |
| alembic upgrade + **downgrade 왕복** | ✅ |
| `video_analyses` 구조·인덱스·FK CASCADE 실DB 확인 | ✅ |
| 5월 녹화본 3개로 motion 시계열·청크 계획 | ✅ |
| ffmpeg 청크 추출 (계획 대비 오차 20ms 이내) | ✅ |
| **Gemini 까지 end-to-end** | ❌ 과금분이라 사용자가 직접 진행 예정 |

---

## 브랜치 상태 (2026-08-19 기준)

```
main                        ddd2671   (STEP 2 PR 아직 머지 전)
 └ feat/pipeline-step2-smart 3cc40d9  ← 이번 작업. 푸시 완료, PR 대기
    └ test/step3            3e47baa   ← STEP 3 작업 중. 위 브랜치를 머지해 둠
 └ test/vlm                 4c8c81c   (vlm_test 실험장. 이번 작업 빠져 있음)
```

**PR 순서: STEP 2 → STEP 3.** STEP 2 가 먼저 머지되면 STEP 3 PR diff 가
STT 파일만 남게 정리된다.

### 여기서 한 번 물렸던 것 (재발 주의)

`test/step3` 를 `feat/pipeline-step2-smart` 가 아니라 **`test/vlm` 에서 따서**
마이그레이션이 안 따라왔다. DB 는 `c1a7d3e9f204` 인데 브랜치엔 그 리비전 파일이
없어서 `alembic current` 가 통째로 실패했다 (`Can't locate revision`).

→ `git merge feat/pipeline-step2-smart` 로 해결. **DB 는 이미 그 상태라
`upgrade` 불필요**, 리비전 파일이 브랜치에 들어오는 것만으로 인식된다.

교훈: DB 는 하나인데 브랜치마다 기대 스키마가 다르다. 브랜치를 새로 딸 때
**어느 브랜치에서 따는지**를 확인할 것. `main` 으로 돌아가 작업하려면
`alembic downgrade b856588e40a8` 가 필요하다.

---

## 미결 사항

### A. `MOTION_THRESH` 결정 (제일 급함)

3.5 는 vlm_test 에서 **mp4** 로 튜닝한 값인데, 시스템 촬영본은 motion 중앙값이
3~4 라 절반이 "동작 중"으로 잡힌다. 실측 절감률:

| thresh | s1 | s3 | s4 |
|---|---|---|---|
| 3.5 (현재) | 22.9% | 16.2% | 15.5% |
| **8.0** | 41.2% | 39.4% | 41.5% |

8.0 이 안정적이지만 표본이 3개뿐이라 **사용자가 실제 영상 보고 결정**하기로 함.
고칠 곳: **`app/pipeline/step2_chunking.py:29` 한 곳** (`/analyze/motion` 은 인자를
안 넘김). vlm_test 에는 별도 사본 있음.

### B. STEP 2 end-to-end (Gemini 과금분)

촬영 → `/end` → `/analyze/motion` → `video_analyses` INSERT 까지.
서버 로그의 `스마트 청킹: 영상 N초 → 청크 M개 (…절감 X%)` 줄이 핵심 확인 지점.

### C. vlm_test 의 fps 버그

본 파이프라인만 고쳤다. 튜닝 도구로 계속 쓸 거면 같이 고쳐야 한다.

### D. 이전 세션에서 넘어온 것

- **google-genai SDK**: `requirements-pipeline.txt` 는 `==0.3.0`(alpha) 인데
  `.venv` 에는 정상 동작하는 버전이 깔려 있음. 파일만 낡았을 가능성 — 확인 필요.
- `_refs/` 면담 자료들은 6월 기준.

---

## 다음 단계 — STEP 3 (진행 중)

`backend/stt_test/` — `full_audio.wav` 하나로 무음/필러/발화속도를 뽑는 PoC.
DB 안 씀. vlm_test 와 같은 "확정되면 `app/pipeline/` 으로 역이식" 패턴.

```
3-1 VAD      무음 구간              ✅
3-2 STT      문장 + 단어 timestamp   ✅ (faster-whisper)
3-3 필러     어휘 ✅ / 음향 ⚠️ 보류
3-4 발화속도  음절/분(SPM)           ✅
```

`openai-whisper` 대신 **faster-whisper** 채택 — Python 3.13 빌드 실패 해소,
torch 불필요, `word_timestamps` 네이티브, Silero VAD 번들. `librosa` 도 안 씀
(numba → Python 3.13 + numpy 2.x 호환 이슈). 자세한 건 `backend/stt_test/README.md`.

> STEP 3 결과를 DB 에 넣을 때 위 "청크의 세 가지 의미" 규칙을 따를 것 —
> 음성분석이 윈도우를 쓰게 되면 `chunks` 에 매달지 말고 자기 `t_start`/`t_end` 를 가질 것.

---

## 환경 메모 (이전 스냅샷에서 갱신됨)

- ⚠️ **`.venv` 를 써야 한다.** 이전엔 conda `(base)` 에 패키지를 깔았지만, 이번에
  `opencv-python-headless` 를 **`.venv` 에만** 설치했다. conda base 로 uvicorn 돌리면
  `ModuleNotFoundError: cv2`.
- `requirements-pipeline.txt`: `opencv-python` → `opencv-python-headless`(서버는 GUI 불필요),
  `openai-whisper` → `faster-whisper`.
- Docker 는 5월 25일 이후 안 쓰이다가 이번에 재가동. `podium_pg_data` 볼륨 그대로 살아있었음.
- ffmpeg / ffprobe 시스템 의존성 필요 (`brew install ffmpeg`).

---

## 빠른 실행 명령

```bash
# 1. DB
docker compose up -d postgres

# 2. 백엔드 (반드시 .venv)
cd backend && source .venv/bin/activate
uvicorn app.main:app --reload --port 8000

# 3. 촬영 검증 (DEBUG=true 필요)
curl -X POST http://localhost:8000/projects -H 'Content-Type: application/json' -d '{"title":"검증"}'
open "http://localhost:8000/dev/?project=<project_id>"
#   Start recording → 60~90초 (정적 구간 포함) → Stop & finalize
#   → Analyze motion (VLM)  ← 여기서 Gemini 과금
#   → 분석결과 확인

# 4. DB 확인
docker compose exec -T postgres psql -U podium -d podium -c \
  "SELECT analysis_id, t_start, t_end, kind, posture FROM video_analyses ORDER BY t_start;"

# (옵션) vlm_test 튜닝 도구 — 포트 8001, DB 안 씀
uvicorn vlm_test.server:app --reload --port 8001
```

---

## 다음 세션 시작 시 권장 순서

1. `docs/CLAUDE.md` (프로젝트 전체 — "청크의 세 가지 의미" 섹션부터)
2. **이 파일** (세션 스냅샷)
3. `backend/stt_test/README.md` (STEP 3 현재 작업)
4. `git status`, `git log -5`, `git branch -vv` (브랜치 계보가 한 번 꼬였던 이력 있음)
5. `alembic current` (`c1a7d3e9f204` 여야 정상)
