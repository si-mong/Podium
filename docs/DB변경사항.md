# DB 변경사항 — segments.label 추가 (2026-09-16)

> alembic 리비전 **`3a2c868476b7`** (이전: `b2e93e11bdc0`) · 브랜치 `feat/pipeline-step3`

STEP 4 구간 분리가 구간마다 **분류 라벨**을 매기게 되면서 담을 컬럼이 필요했음.

```bash
cd backend && source .venv/bin/activate
alembic upgrade head
```

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `segments` | `label` | `VARCHAR(32)` nullable |

```
label   분류용 semi-enum (도입/문제제시/해결방안/시연/결과/마무리)
        → 회차 비교·집계에 사용. 목록은 step4_segmentation.LABELS (12종)
title   사용자에게 보여줄 한 줄 요약
```

**둘은 역할이 다르므로 분리한다.** `label` 로는 *"이번 회차엔 문제제시 구간이 짧았다"*
같은 비교가 가능하고, `title` 은 화면에 그대로 뿌린다.

---

# DB 변경사항 — STEP 3 반복(말더듬) 컬럼 + 발화속도 분리 (2026-09-16)

> alembic 리비전 **`b2e93e11bdc0`** (이전: `c1a7d3e9f204`) · 브랜치 `test/step3`

STEP 3 음성분석이 **반복(말더듬)** 을 새 지표로 내놓게 되면서 담을 곳이 필요했고,
발화속도는 한국어에 안 맞는 이름(`wpm`)과 하나뿐인 컬럼을 바로잡았다.

## 적용 방법

```bash
# cwd = backend/, venv 활성화
git pull
alembic upgrade head
```

마이그레이션 스크립트는 커밋돼 있지만 **로컬 Postgres 는 자동으로 안 바뀐다.** 직접 실행할 것.

## 바뀐 것

### 추가 — 반복(말더듬)

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `voice_raws` | `repetitions` | `JSONB` |
| `segment_analyses` | `repetition_count` | `Integer` |
| `session_summaries` | `total_repetition_count` | `Integer` |

`repetitions` 는 `silence_segments` / `filler_words` 와 같은 구조의 배열:
`[{t_start, t_end, duration, kind("exact"|"stem"), count, text}, ...]`

### 이름 변경 + 분리 — 발화속도

```
segment_analyses
  wpm      →  speaking_rate_spm          무음 포함 (전체 템포)
           +  articulation_rate_spm      무음 제외 (조음 속도)     ← 신규

session_summaries
  avg_wpm  →  avg_speaking_rate_spm
           +  avg_articulation_rate_spm                          ← 신규
```

**왜 WPM 이 아니라 SPM 인가** — 한국어는 어절 수가 띄어쓰기 정책에 따라 크게 흔들려
어절/분(WPM)이 불안정하다. 음절/분(SPM)이 안정적이다.

**왜 두 개로 나누는가** — 무음 포함/제외를 나눠야 *"말 자체는 빠른데 자주 멈춘다"*
같은 진단이 가능하다. 하나만 저장하면 그 정보가 사라진다.

이름 변경은 `alter_column` 으로 처리해 **기존 값을 보존**한다(autogenerate 는
drop+add 로 잡지만 그러면 데이터가 날아감). 의미가 바뀐 게 아니라 이름만 바로잡은 것.

## 검증

- `alembic upgrade head` → `downgrade -1` → `upgrade head` 왕복 확인
- `/sessions/{id}/analyze/voice` end-to-end 로 `voice_raws.repetitions` 저장 확인

## 보류한 것

`voice_raws.analysis_config`(JSONB) — 분석에 쓴 모델·임계값을 같이 저장해 **회차 비교의
공정성**을 담보하려던 컬럼. 회차마다 모델이나 임계값이 다르면 수치 변화가 실력 변화인지
설정 변화인지 구분이 안 된다. 필요성은 인정되나 이번 범위에서 제외.

---

# DB 변경사항 — `chunk_analyses` → `video_analyses`

> alembic 리비전 **`c1a7d3e9f204`** (이전: `b856588e40a8`) 브랜치 `feat/pipeline-step2-smart` · STEP 2 스마트 청킹 통합에 포함

영상분석 결과가 더 이상 30초 업로드 청크에 매달리지 않고 **자기 시간 범위를 직접** 보유. 동작 구간만 골라 자르는 스마트 청킹을 붙이려면 필수인 변경이었음.

---

## 1. 먼저 할 것

마이그레이션 **스크립트**는 커밋돼 있어 `git pull`로 따라옴. 단 **DB 상태는 각자 로컬 Postgres라 자동으로 안 바뀜.** 직접 실행 필요.

```bash
# 1. 브랜치 받기
git fetch origin
git switch feat/pipeline-step2-smart

# 2. 마이그레이션 적용  (cwd = backend/, venv 활성화 필요)
cd backend
source .venv/bin/activate
alembic upgrade head
alembic current          # c1a7d3e9f204 (head) 나오면 정상

# 3. 의존성 재설치 (opencv 추가됨)
pip install -r requirements-pipeline.txt
```

미실행 시 앱이 아래로 터짐.

```
ProgrammingError: relation "video_analyses" does not exist
```

> ⚠️ **적용 전 확인**: 기존 `chunk_analyses` 데이터는 **삭제됨.** 4-1 참고.

---

## 2. 무엇이 바뀌었나

### 2-1. 테이블 교체

|       | 이전                       | 이후                              |
| ----- | ------------------------ | ------------------------------- |
| 테이블명  | `chunk_analyses`         | `video_analyses`                |
| PK    | `chunk_id` (= chunks FK) | `session_id` 로 세션에 직접 소속        |
| 소속    | `chunks` 에 종속            | `session_id` 로 세션에 직접 소속        |
| 시간 정보 | 없음 (청크 행을 타고 조회)         | `t_start` / `t_end` 직접 보유       |
| 구간 종류 | 없음                       | `kind` (intro / motion / outro) |


**이전**

```sql
chunk_analyses
  chunk_id        bigint PK, FK → chunks.chunk_id
  posture         varchar(32)
  eye_contact     varchar(32)
  gesture         varchar(32)
  gesture_counts  jsonb
  notes           text
```

**이후**

```sql
video_analyses
  analysis_id     bigserial PK
  session_id      bigint NOT NULL, FK → sessions.session_id  (index, ON DELETE CASCADE)
  t_start         float  NOT NULL
  t_end           float  NOT NULL
  kind            varchar(16) NOT NULL   -- intro / motion / outro
  posture         varchar(32)
  eye_contact     varchar(32)
  gesture         varchar(32)
  gesture_counts  jsonb
  notes           text
```

**분석 값 5개(`posture`, `eye_contact`, `gesture`, `gesture_counts`, `notes`)는 동일.** 바뀐 건 _"이 결과가 영상의 어디를 본 것인가"_ 의 표현 방식뿐. 이전에는 청크 행을 타고 들어가야 알 수 있었고, 이제는 행에 직접 기록됨.

SQLAlchemy 관계도 변경.

- `Chunk.analysis` → **제거**
- `Session.video_analyses` → **추가**

### 2-2. gesture_counts 키셋 (10종 → 7종)

JSONB 내부 키라 **컬럼 변경은 아니지만** 이 값을 읽는 코드는 영향받음.

| 이전 (main)                                       | 이후                       | 처리    |
| ----------------------------------------------- | ------------------------ | ----- |
| `hand_movement`, `emphasizing_hand_movement`    | `explanatory_gesture`    | 통합    |
| —                                               | `distracting_gesture`    | 신설    |
| `arms_crossed`                                  | `closed_posture`         | 이름 변경 |
| `swaying_body`                                  | `body_movement`          | 이름 변경 |
| `touching_face_or_hair`                         | `touching_face_or_hair`  | 유지    |
| `pointing`                                      | `pointing`               | 유지    |
| `fidgeting_with_objects`                        | `fidgeting_with_objects` | 유지    |
| `head_nodding`, `leaning_forward`, `scratching` | —                        | 제거    |

핵심은 `explanatory_gesture`(설명을 돕는 긍정적 제스처)와 `distracting_gesture`(산만한 동작)의 **엄격한 분리**. 제거된 3종은 VLM 판정이 불안정하고 피드백 가치가 낮았음.

### 2-3. API 응답

|엔드포인트|변경|
|---|---|
|`POST /sessions/{id}/analyze/motion`|입력이 업로드 청크 → **`full_video.webm`**. full_video 없으면 **400**. 응답에 `covered_sec`(VLM이 실제로 본 총 길이) 추가|
|`GET /sessions/{id}/analysis`|`chunk_index` 제거, **`t_start`, `t_end`, `kind`** 로 대체. 시간순 정렬|

프론트에서 이 응답을 파싱하는 코드가 있으면 `chunk_index` 참조 확인 필요. 현재 `dev_static` 페이지는 JSON을 그대로 덤프하므로 영향 없음.

---

## 3. 왜 바꿨나

`청크`가 세 층에서 서로 다른 뜻으로 쓰이고 있었음.

|층|뜻|단위|어디|
|---|---|---|---|
|**전송**|녹화 중 스트리밍 업로드|30초 **고정**|`chunks` 테이블|
|**영상분석**|동작이 있는 구간|**동적** 20초|`video_analyses` 테이블|
|**음성분석**|(예정) 정적 윈도우|미정|아직 없음|

전송 청크가 30초라 음성분석 단위와 겹쳐 보이지만 우연임. 30초는 **네트워크 재시도 단위**지 분석 단위가 아님. 그런데 스키마가 전송 청크와 영상분석 결과를 FK 하나로 묶어놔서 임의 시점부터 자르는 동적 청크를 담을 수 없었음.

> **규칙: 분석 결과 테이블은 "무엇을 분석했나"로 이름 짓고, 자른 단위는 `t_start`/`t_end` 컬럼이 표현한다.**

이러면 영상은 동적 20초, 음성은 나중에 정적 30초를 각자 골라도 충돌 없음. 실제로 `stt_sentences` 는 **이미 이 패턴**이었고 chunk FK가 없었음. chunk FK를 쓰던 분석 테이블은 `chunk_analyses` 하나뿐 — 그게 예외였음.

### 덤: 버그 하나 동시 해결

이전에는 `chunk_id` 기준 UPSERT라 재분석 시 청크 수가 줄면 **이전 회차 행이 남아 집계에 섞였음.** 현재는 `DELETE WHERE session_id` 후 INSERT라 구조적으로 발생 불가.

---

## 4. 주의사항

### 4-1. 기존 `chunk_analyses` 데이터 삭제됨

마이그레이션이 테이블을 drop함. 시간 범위의 의미도 청킹 정책도 달라져 이관하지 않음. 남겨둔 검증 결과가 있으면 **`upgrade` 전에** 백업할 것.

```bash
docker compose exec -T postgres pg_dump -U podium -d podium \
  --data-only --table=chunk_analyses --column-inserts > chunk_analyses_backup.sql
```

### 4-2. 브랜치 이동 시 스키마 어긋남

DB는 하나인데 브랜치마다 기대 스키마가 다름. 이 브랜치는 `video_analyses`를, `main`은 아직 `chunk_analyses`를 기대함.

```bash
alembic downgrade b856588e40a8   # main 으로 이동 시
alembic upgrade head             # 이 브랜치로 복귀 시
```

### 4-3. 동시 마이그레이션 생성 시 head 분기

다른 브랜치에서 병렬로 리비전을 만들면 head가 2개가 되고 `alembic upgrade head` 실패함. `alembic heads`로 확인 후 `alembic merge` 필요. **PR 머지 순서 조율할 것.**

---

## 5. 문제 해결

### `Can't locate revision identified by 'c1a7d3e9f204'`

```
FAILED: Can't locate revision identified by 'c1a7d3e9f204'
```

**DB는 이미 새 스키마인데 현재 브랜치에 해당 리비전 파일이 없을 때** 발생. 마이그레이션 적용 후 그 커밋이 없는 브랜치(`main`, 또는 그 이전에서 딴 브랜치)로 이동하면 나타남. alembic이 `upgrade`도 `downgrade`도 못 하는 상태가 됨.

**해결** — 리비전을 가진 브랜치를 머지.

```bash
git merge feat/pipeline-step2-smart
alembic current      # 정상 출력 확인
```

DB는 이미 해당 상태이므로 **`upgrade` 불필요.** 파일이 브랜치에 들어오는 것만으로 인식됨.

> 새 브랜치를 딸 때 **기준 브랜치를 확인할 것.** STEP 2 이후 작업은 `feat/pipeline-step2-smart`(또는 머지된 `main`) 기준으로 딸 것.

### `ModuleNotFoundError: No module named 'cv2'`

스마트 청킹이 OpenCV를 사용함. **`.venv` 활성화 여부 확인.** conda `(base)`로 uvicorn 실행 시 발생.

```bash
source .venv/bin/activate
pip install -r requirements-pipeline.txt
```

### 적용 여부 확인

```bash
alembic current        # c1a7d3e9f204 (head)
alembic heads          # 1개만 나와야 정상
alembic check          # "No new upgrade operations detected" 면 모델과 DB 일치
```

```bash
docker compose exec -T postgres psql -U podium -d podium -c "\d video_analyses"
```

---

## 관련 문서

- `docs/CLAUDE.md` — "청크의 세 가지 의미" 섹션에 설계 근거
- `backend/alembic/versions/c1a7d3e9f204_replace_chunk_analyses_with_video_.py` — 마이그레이션 본체
- `_refs/Dev-DB-erd.md` — ERD (갱신 필요)