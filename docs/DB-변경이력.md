# DB 변경이력

> alembic 마이그레이션(`backend/alembic/versions/`)마다 **무엇을 왜 바꿨는지** 남기는 문서. 위가 최신.
> 현재 스키마 전체는 [DB-erd](DB-erd.md), 모델은 `backend/app/models/`.
>
> 새 마이그레이션을 만들면 아래 표에 한 줄 + 본문에 한 절을 추가한다.

## 적용 방법 (공통)

```bash
# cwd = backend/, venv 활성화
alembic upgrade head
alembic current        # 지금 DB 가 어느 리비전인지
alembic heads          # 1개만 나와야 정상 — 2개면 브랜치 머지 후 alembic merge 필요
```

배포 서버는 api 컨테이너가 시작할 때 `alembic upgrade head` 를 자동 실행한다 (`backend/Dockerfile`).

## 리비전 전체 (22개, head = `b8d4f2a6c9e1`)

| 날짜 | 리비전 | 이전 | 내용 |
|---|---|---|---|
| 2026-10-27 | `b8d4f2a6c9e1` | `a6c3e9f1d2b4` | `session_comparisons` 테이블 추가 (회차 비교 AI 피드백) |
| 2026-10-27 | `a6c3e9f1d2b4` | `f2a8d4c6b1e3` | `analysis_events.detail` 추가 (단계 안 세부 시간) |
| 2026-10-23 | `f2a8d4c6b1e3` | `b5d2e8f1a3c7` | `oauth_accounts` 테이블 추가, `users.password_hash` NULL 허용 (구글 로그인) |
| 2026-10-26 | `b5d2e8f1a3c7` | `e7b3c1d9a4f2` | `users` 프로필 4칸 추가 |
| 2026-10-18 | `e7b3c1d9a4f2` | `e7b2c5a9d013` | `analysis_events` 테이블 추가 (분석 실행 기록) |
| 2026-10-18 | `e7b2c5a9d013` | `d4f1a8c2b7e9` | `feedbacks.rating` 추가 |
| 2026-10-15 | `d4f1a8c2b7e9` | `a9aef3a4a5ca` | `users.is_admin` 추가 |
| 2026-09-28 | `a9aef3a4a5ca` | `6adea4c4aa0a`, `bf3493c04c16` | 머지 (인증 + 제스처 시각) |
| 2026-09-28 | `6adea4c4aa0a` | `8b4499cd29e3`, `8ee3b7ffaf70` | 머지 (STEP 5 피드백 + 인증) |
| 2026-09-22 | `bf3493c04c16` | `c9368cd4e173` | `segment_analyses.gesture_timelines` 추가 |
| 2026-09-22 | `c9368cd4e173` | `2ab07f121dcd` | `video_analyses.gesture_timelines` 추가 |
| 2026-09-21 | `2ab07f121dcd` | `8b4499cd29e3` | `sessions.session_no` 추가 (회차 번호) |
| 2026-09-20 | `8b4499cd29e3` | `ba342bb649d8` | `feedbacks.strengths` / `improvements` 추가 |
| 2026-09-18 | `ba342bb649d8` | `868def7d88f9` | `session_summaries.overall_scores` → `llm_feedback` 이름 변경 |
| 2026-09-17 | `868def7d88f9` | `3a2c868476b7` | `segment_analyses` 무음 비율·긍정/부정 제스처 합계 추가 |
| 2026-09-17 | `8ee3b7ffaf70` | `aef99971920a` | `refresh_tokens` 테이블 추가 (JWT) |
| 2026-09-17 | `aef99971920a` | `3a2c868476b7` | `projects.deleted_at` 추가 (휴지통) |
| 2026-09-16 | `3a2c868476b7` | `b2e93e11bdc0` | `segments.label` 추가 |
| 2026-09-16 | `b2e93e11bdc0` | `c1a7d3e9f204` | 반복(말더듬) 컬럼 + 말 속도 WPM → SPM 분리 |
| 2026-08-18 | `c1a7d3e9f204` | `b856588e40a8` | `chunk_analyses` → `video_analyses` 교체 |
| 2026-05-22 | `b856588e40a8` | `444442f442c2` | `chunk_analyses` 추가, `segment_analyses` 동작 칸을 카운트 JSONB 로 |
| 2026-05-17 | `444442f442c2` | — | 첫 테이블 10개 생성 |

> 날짜는 리비전 파일의 Create Date. 브랜치에서 따로 만들어져 머지됐기 때문에 날짜 순서와 리비전 순서가 어긋나는 곳이 있다
> (예: `b5d2e8f1a3c7` 10-26 → `f2a8d4c6b1e3` 10-23). **순서는 "이전" 칸이 기준.**

```
444442 → b85658 → c1a7d3 → b2e93e → 3a2c86 ─┬→ 868def → ba342b → 8b4499 ─┬→ 2ab07f → c9368c → bf3493 ─┐
                                            │                            └────────────┐              │
                                            └→ aef999 → 8ee3b7 ───────────────────→ 6adea4 (merge) ──┴→ a9aef3 (merge)
a9aef3 → d4f1a8 → e7b2c5 → e7b3c1 → b5d2e8 → f2a8d4 → a6c3e9 → b8d4f2 (head)
```

---

# DB 변경 — `session_comparisons` 테이블 추가 (2026-10-27)

> alembic 리비전 **`b8d4f2a6c9e1`** (이전: `a6c3e9f1d2b4`) · 커밋 `feat(compare): 두 회차 비교 분석`

회차 비교의 ③ AI 비교 피드백(LLM 호출)만 저장한다. ①지표 비교·②구간 비교는 그때그때 계산하지만, 생성 당시 값을 스냅샷으로 같이 남긴다 — 회차를 지우거나 재분석해도 당시 비교를 그대로 보기 위함.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `comparison_id` | `BIGINT` PK | |
| `project_id` | `BIGINT` FK → projects, **CASCADE** | 폴더가 영구 삭제되면 같이 삭제 |
| `base_session_id`, `target_session_id` | `BIGINT` FK → sessions, **SET NULL** | 회차가 지워지면 칸만 비움. `(base, target)` 유일 |
| `base_session_no`, `target_session_no` | `INTEGER` | 회차가 지워져도 "2회차 → 3회차" 로 표시 |
| `metrics_diff`, `segment_alignment` | `JSONB` | ①·② 스냅샷 (구간 스크립트는 제외) |
| `llm_feedback` | `JSONB` | ③ `{headline, items}` |
| `base_analyzed_at`, `target_analyzed_at` | `TIMESTAMPTZ` | 생성 당시 두 회차의 마지막 분석 시각 — 지금 값과 다르면 "다시 만들기" |
| `status`, `error` | `VARCHAR(16)`, `TEXT` | `done` / `error` |
| `created_at` | `TIMESTAMPTZ` | |

설계: `_refs/Dev-비교분석.md` (로컬 전용)

---

# DB 변경 — `analysis_events.detail` 추가 (2026-10-27)

> alembic 리비전 **`a6c3e9f1d2b4`** (이전: `f2a8d4c6b1e3`) · 커밋 `feat(admin): 음성 분석 세부 시간 기록 및 관리자 화면 표시`

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `analysis_events` | `detail` | `JSONB` nullable |

단계 하나 안의 세부 시간. 단계마다 키가 다르다. 지금은 음성 분석만 채운다
(`vad_sec`, `stt_sec` = `stt_wait_sec` + `stt_decode_sec`, `filler_sec`, Modal 이면 `stt_queue_sec`·`stt_model_load_sec` 등).
5명 동시 테스트에서 GPU 대기가 얼마인지 보려고 추가.

---

# DB 변경 — 구글 로그인 — `oauth_accounts` 추가, 비밀번호 NULL 허용 (2026-10-23)

> alembic 리비전 **`f2a8d4c6b1e3`** (이전: `b5d2e8f1a3c7`) · 커밋 `feat(auth): 구글 로그인 추가, 이메일 회원가입 제거`

| 변경 | 내용 |
|---|---|
| `users.password_hash` | `NOT NULL` → **NULL 허용**. 구글로 만든 계정은 비밀번호가 없다 |
| `oauth_accounts` 신규 | `oauth_account_id` PK, `user_id` FK(CASCADE), `provider`, `subject`, `email`(참고용), `created_at`. `(provider, subject)` 유일 |

- 회원은 이메일이 아니라 **`(provider, subject)`** (구글의 `sub`) 로 찾는다. 이메일은 바뀔 수 있지만 `sub` 는 고정.
- 카카오·네이버를 붙여도 `provider` 값만 늘어난다.
- ⚠️ downgrade 하면 `password_hash` 가 다시 NOT NULL 이 되므로, 구글 계정 행이 있으면 실패한다.

---

# DB 변경 — `users` 프로필 추가 (2026-10-26)

> alembic 리비전 **`b5d2e8f1a3c7`** (이전: `e7b3c1d9a4f2`) · 커밋 `feat(profile): 이름·소속·발표 목적 프로필 추가`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `display_name` | `VARCHAR(50)` | |
| `affiliation` | `VARCHAR(100)` | 소속·학과 |
| `purpose` | `VARCHAR(20)` | 발표 목적 — `class` / `interview` / `conference` / `work` / `other` (`schemas/auth.py` `Purpose`) |
| `profile_completed_at` | `TIMESTAMPTZ` | 프로필 화면을 거쳤는지 (저장이든 건너뛰기든). NULL 이면 로그인 직후 `/profile` 로 보냄 |

전부 선택 입력. 전화번호처럼 쓸 곳이 없는 정보는 일부러 받지 않는다 (개인정보 최소 수집).

---

# DB 변경 — `analysis_events` 테이블 추가 (2026-10-18)

> alembic 리비전 **`e7b3c1d9a4f2`** (이전: `e7b2c5a9d013`) · 커밋 `feat(admin): 분석 실행 기록과 관리자 분석 현황·상세 화면 추가`

분석 단계를 한 번 실행할 때마다 한 줄. 예전에는 소요 시간·실패 원인이 서버 로그에만 찍히고 사라졌다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `event_id` | `BIGINT` PK | |
| `session_id`, `user_id` | `BIGINT` FK, **SET NULL** | 세션·회원이 지워져도 실패 통계는 남긴다 |
| `step` | `VARCHAR(32)` | `preprocess` / `motion` / `voice` / `segments` / `segment_feedback` / `overall_feedback` |
| `status` | `VARCHAR(16)` | `running` / `succeeded` / `partial` / `failed` |
| `model` | `VARCHAR(128)` | 그 실행에 쓴 모델 |
| `error`, `duration_ms` | `TEXT`, `INTEGER` | |
| `started_at`, `finished_at` | `TIMESTAMPTZ` | `started_at` 인덱스 (최근 기록 조회) |

라우터에 `@tracked(...)` 데코레이터를 붙이면 기록된다 (`services/analysis_log.py`).

---

# DB 변경 — feedbacks.rating 추가 (2026-10-18)

> alembic 리비전 **`e7b2c5a9d013`** (이전: `d4f1a8c2b7e9`) · 브랜치 `feat/fe-dashboard`

STEP 5 구간별 피드백 카드 오른쪽 위에 **등급 스티커**(잘함/보통/개선필요)를 표시하게 되면서 담을 컬럼이 필요했음.

```bash
cd backend && source .venv/bin/activate
alembic upgrade head
```

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `feedbacks` | `rating` | `VARCHAR(16)` nullable |

```
rating   "잘함" / "보통" / "개선필요" 중 하나 — GPT 가 판정, 다른 값이 오면 코드가 "보통"으로 바꿈
         (step5_feedback._ensure_rating). 이 컬럼 전에 분석한 구간은 NULL → 화면에서 스티커 안 그림
```

`GET /sessions/{id}/segment-feedback` 응답의 `feedback` 에 `rating` 키가 추가됨.

---

# DB 변경 — `users.is_admin` 추가 (2026-10-15)

> alembic 리비전 **`d4f1a8c2b7e9`** (이전: `a9aef3a4a5ca`) · 커밋 `feat(admin): 관리자 권한과 외부 API 연결 점검 화면 추가`

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `users` | `is_admin` | `BOOLEAN NOT NULL DEFAULT false` |

회원가입·API 로는 바꿀 수 없고 서버에서 `python -m app.scripts.set_admin <email>` 로만 지정한다 — 화면에서 스스로 관리자가 되는 경로를 아예 두지 않기 위함.

---

# DB 변경 — 브랜치 머지 2건 (2026-09-28)

> alembic 리비전 **`a9aef3a4a5ca` · `6adea4c4aa0a`** (이전: 각각 `6adea4c4aa0a`+`bf3493c04c16`, `8b4499cd29e3`+`8ee3b7ffaf70`) · 스키마 변경 없음 (`pass`)

병렬 브랜치에서 리비전을 만들어 head 가 갈라진 것을 합친 빈 리비전.

- `6adea4c4aa0a`: STEP 5 피드백 브랜치(`8b4499cd29e3`) + 인증 브랜치(`8ee3b7ffaf70`)
- `a9aef3a4a5ca`: 위 머지 + 제스처 시각 브랜치(`bf3493c04c16`)

---

# DB 변경 — `gesture_timelines` 추가 — 영상 분석·구간 집계 (2026-09-22)

> alembic 리비전 **`bf3493c04c16` · `c9368cd4e173`** (이전: `c9368cd4e173` · `2ab07f121dcd`) · 커밋 `feat: 제스처 분석을 STEP5 피드백에 연결`

| 리비전 | 테이블 | 컬럼 | 타입 |
|---|---|---|---|
| `c9368cd4e173` | `video_analyses` | `gesture_timelines` | `JSONB` nullable |
| `bf3493c04c16` | `segment_analyses` | `gesture_timelines` | `JSONB` nullable |

`gesture_counts` 와 같은 7종 키, 값은 그 제스처가 발생한 시각(`"M:SS"`) 배열.
STEP 2 가 원래 만들어주던 값인데 저장하지 않고 버리고 있었다. STEP 5 피드백이 "1:12, 1:16 에 손가락으로 …" 처럼 **구체적 시각을 근거로 인용**하려고 저장.
구간 쪽 값은 그 구간과 겹치는 영상 조각들의 시각을 이어붙인 것 (`step4_aggregate`).

---

# DB 변경 — `sessions.session_no` 추가 — 회차 번호 (2026-09-21)

> alembic 리비전 **`2ab07f121dcd`** (이전: `8b4499cd29e3`) · 커밋 `feat(api): 세션 회차 번호 저장, 스크립트/음성요약 API, 영상 Range 지원`

| 테이블 | 컬럼 | 제약 |
|---|---|---|
| `sessions` | `session_no` | `INTEGER NOT NULL`, `UNIQUE (project_id, session_no)` = `uq_sessions_project_session_no` |

"N회차 연습"의 N. 목록 순서로 매기면 앞 회차를 지울 때 뒤 회차 이름이 당겨지므로 DB 에 저장한다. 새 세션은 그 폴더의 가장 큰 번호 + 1.

**기존 행 채우기**: 컬럼을 NULL 허용으로 추가 → 폴더별 `ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY session_id)` 로 번호 매김 → NOT NULL 로 바꾸고 유일 제약 추가.

---

# DB 변경 — `feedbacks.strengths` / `improvements` 추가 (2026-09-20)

> alembic 리비전 **`8b4499cd29e3`** (이전: `ba342bb649d8`) · 커밋 `feat(step5): 구간별 LLM 분석과 구간별 데이터 꺾은선 그래프 추가`

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `feedbacks` | `strengths` | `JSONB` nullable |
| `feedbacks` | `improvements` | `JSONB` nullable |

STEP 5 구간별 피드백 결과 — 근거 시각(M:SS)을 포함한 문장 목록 `["...", "..."]`. 기존 `fb_*` TEXT 칸은 목록을 담기에 맞지 않아 별도로 추가했다.
`fb_*`·`score_*` 칸은 남아 있지만 지금은 쓰지 않는다 (새 형식이 없는 예전 행은 "피드백 없음"으로 본다).

---

# DB 변경 — `session_summaries.overall_scores` → `llm_feedback` 이름 변경 (2026-09-18)

> alembic 리비전 **`ba342bb649d8`** (이전: `868def7d88f9`) · 커밋 `feat(step5): …`

| 테이블 | 변경 |
|---|---|
| `session_summaries` | `overall_scores` → **`llm_feedback`** (JSONB, `alter_column` 이름 변경이라 값 보존) |

점수가 아니라 STEP 5 종합 피드백(LLM) 결과 JSON 을 담게 되어 이름을 바로잡음. 지금 키는 `headline`, `overall_summary`.

---

# DB 변경 — `segment_analyses` 무음 비율·제스처 합계 추가 (2026-09-17)

> alembic 리비전 **`868def7d88f9`** (이전: `3a2c868476b7`) · 커밋 `feat(step5): …`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `silence_ratio` | `FLOAT` | 구간 길이 대비 무음 시간 비율 0~1 (`silence_count` 는 횟수만 셈) |
| `positive_gesture_count` | `INTEGER` | 설명 제스처 + 가리키기 + 몸 움직임 |
| `negative_gesture_count` | `INTEGER` | 산만한 제스처 + 얼굴·머리 만지기 + 물건 만지작 + 닫힌 자세 |

구간별 지표 꺾은선 그래프용으로 미리 합산해 둔 값 (`GET /sessions/{id}/segments/trend`).

---

# DB 변경 — `refresh_tokens` 테이블 추가 — JWT 인증 (2026-09-17)

> alembic 리비전 **`8ee3b7ffaf70`** (이전: `aef99971920a`) · 커밋 `feat(be): JWT 인증 도입 및 임시 더미 인증 제거`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `jti` | `VARCHAR(32)` PK | 토큰 식별자. **토큰 본문은 저장하지 않는다** (유출되면 그대로 로그인 수단이 되므로) |
| `user_id` | `BIGINT` FK → users, CASCADE | |
| `expires_at` | `TIMESTAMPTZ` | |
| `revoked_at` | `TIMESTAMPTZ` | 채워지면 그 토큰은 죽는다 — 회전(1회 사용 후 폐기)과 로그아웃 모두 이 칸을 쓴다 |
| `created_at` | `TIMESTAMPTZ` | |

---

# DB 변경 — `projects.deleted_at` 추가 — 휴지통 (2026-09-17)

> alembic 리비전 **`aef99971920a`** (이전: `3a2c868476b7`) · 커밋 `feat(be): 프로젝트 조회·수정·삭제 API 및 휴지통 추가`

| 테이블 | 컬럼 | 타입 |
|---|---|---|
| `projects` | `deleted_at` | `TIMESTAMPTZ` nullable, 인덱스 |

NULL = 정상, 값 있음 = 휴지통. 행을 지우지 않으므로 복원 가능. 영구 삭제는 `DELETE /projects/{id}/purge`.
**하위 세션에는 아무것도 찍지 않는다** — 찍으면 복원 시 원래 개별 삭제됐던 세션까지 되살아난다. 세션이 보이는지는 부모의 이 컬럼으로 판단 (`app/api/_deps.py`).

---

# DB 변경 — segments.label 추가 (2026-09-16)

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

# DB 변경 — STEP 3 반복(말더듬) 컬럼 + 발화속도 분리 (2026-09-16)

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

# DB 변경 — `chunk_analyses` → `video_analyses`

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
- `docs/DB-erd.md` — ERD (갱신 필요)

---

# DB 변경 — `chunk_analyses` 추가, `segment_analyses` 동작 칸 변경 (2026-05-22)

> alembic 리비전 **`b856588e40a8`** (이전: `444442f442c2`) · 커밋 `feat(db): segment_analyses refactor + chunk_analyses 테이블 추가`

STEP 2 VLM 통합 때 청크별 결과를 담을 곳이 필요했다. (→ 2026-08-18 `c1a7d3e9f204` 에서 `video_analyses` 로 교체됨)

| 변경 | 내용 |
|---|---|
| `chunk_analyses` 신규 | `chunk_id` PK·FK(→ chunks, CASCADE), `posture`, `eye_contact`, `gesture`, `gesture_counts`(JSONB), `notes` |
| `segment_analyses` | `posture` / `eye_contact` / `gesture` (TEXT) **삭제** → `gesture_counts` / `posture_counts` / `eye_contact_counts` (JSONB) 추가 |

구간 하나에 영상 조각이 여러 개 겹치므로, 구간 칸은 글 하나가 아니라 **카테고리별 횟수**로 집계한다.

---

# DB 변경 — 첫 테이블 생성 (2026-05-17)

> alembic 리비전 **`444442f442c2`** (이전: 없음) · 커밋 `feat: SQLAlchemy 모델 정의 및 Alembic 마이그레이션 구축`

기획서(`_refs/PJ-프로젝트 설명.md`) 스키마를 그대로 옮긴 10개 테이블.

`users`, `projects`, `sessions`, `chunks`, `segments`, `stt_sentences`, `voice_raws`, `segment_analyses`, `feedbacks`, `session_summaries`

이후 바뀐 것 중 큰 것:
- `segment_analyses.wpm`, `session_summaries.avg_wpm` → SPM 으로 이름 변경 (`b2e93e11bdc0`)
- `segment_analyses` 의 `posture`/`eye_contact`/`gesture` TEXT → 카운트 JSONB (`b856588e40a8`)
- `session_summaries.overall_scores` → `llm_feedback` (`ba342bb649d8`)
- `users.password_hash` NOT NULL → NULL 허용 (`f2a8d4c6b1e3`)
