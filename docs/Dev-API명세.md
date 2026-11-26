# Dev - API 명세

> 2026-11-27 기준 `backend/app/api/` 에 **실제로 있는** 엔드포인트 전체를 기록한다.
> 전체 흐름은 [Design-시스템흐름](Design-시스템흐름.md), DB 는 [DB-erd](DB-erd.md),
> 파이프라인 내부는 [Dev-STEP3](../_refs/Dev-STEP3.md) · [Dev-STEP4](../_refs/Dev-STEP4.md), 회차 비교는 [Dev-비교분석](../_refs/Dev-비교분석.md).
>
> 이 문서는 사람이 읽는 계약서다. 필드 타입의 최종 진실은 서버를 띄우고 `http://localhost:8000/docs` (자동 OpenAPI).
> 응답 스키마는 `backend/app/schemas/` 에 있다.

---

## 0. 공통 사항

| 항목 | 값 |
|---|---|
| Base URL | 로컬 `http://localhost:8000`. 배포는 프론트 환경변수 `NEXT_PUBLIC_API_URL` 이 가리키는 EC2 (Caddy → FastAPI) |
| 인증 | **필수.** `Authorization: Bearer <access_token>` → [2. 인증](#2-인증). 예외는 각 절에 표시 |
| 요청 본문 | 업로드 2종만 `multipart/form-data`, 나머지는 `application/json` 또는 쿼리 |
| 시각 단위 | 초(second), `float`. 영상 시작이 `0.0` |
| 비율 | `silence_ratio` 등 비율은 **0~1** 값 (화면에서 %로 바꿔 표시) |
| 경로 필드 | `uploads/` 기준 **상대 경로** (`full_video_path`, `file_path` 등). 표시용이며 API 입력으로 쓰지 않는다 |
| CORS | `.env` 의 `CORS_ORIGINS` (쉼표 구분). 기본값 `http://localhost:3000,http://localhost:8001` |

### 에러 응답

FastAPI 기본 형식. 본문은 `{"detail": "..."}`. 사용자에게 보여줄 문구는 대부분 한국어로 내려간다.

| 코드 | 언제 |
|---|---|
| `400` | 선행 단계 미완료 (예: `/end` 안 하고 분석 호출), 업로드 없음, 잘못된 값 |
| `401` | 토큰이 없거나 만료·위조됨 → 갱신 또는 재로그인 |
| `403` | 관리자 API 를 일반 회원이 호출 |
| `404` | 존재하지 않거나 **내 소유가 아닌** 폴더/세션, 휴지통에 있는 폴더의 세션 |
| `422` | 요청 스키마 불일치 (FastAPI 검증 실패) |
| `502` | 외부 LLM 호출 실패 (종합 피드백, AI 비교 피드백) |
| `503` | 구글 로그인 설정(`GOOGLE_CLIENT_ID/SECRET`)이 비어 있음 |

> 남의 리소스에도 `403` 이 아니라 `404` 를 준다. 존재 여부 자체를 노출하지 않기 위함.

---

## 1. 세션 상태 머신과 분석 순서

### 상태

```
 POST .../sessions/start     POST /end        POST /analyze/voice     POST /analyze/segments
          │                      │                    │                        │
          ▼                      ▼                    ▼                        ▼
     recording ───────────> preprocessed ──────────> analyzed ──────────────> segmented
                           (full_audio.wav)       (STT·음성 지표)          (구간 + 집계)
                                                                               │
                                     motion-by-segment · segment-feedback · overall-feedback
                                     는 status 를 바꾸지 않는다 (segmented 유지)
```

| status | 의미 |
|---|---|
| `recording` | 세션만 생성됨. 업로드 대기/진행 중 |
| `preprocessed` | `/end` 완료 — 오디오 추출 끝. 음성 분석 호출 가능 |
| `analyzed` | STEP 3 음성 분석 끝 (구 `/analyze/motion` 도 이 값을 쓴다) |
| `segmented` | STEP 4 구간 분리까지 끝. 이후 단계는 이 상태에서 돈다 |

> **재분석은 `/end` 부터.** `/analyze/voice` 는 `preprocessed`·`analyzed` 에서만 받으므로
> `segmented` 세션을 다시 돌리려면 `/end` 로 상태를 `preprocessed` 로 되돌린 뒤 순서대로 부른다.

### 분석 호출 순서 (프론트 `frontend/src/utils/analysis.ts`)

```
/end → /analyze/voice → /analyze/segments → /analyze/motion-by-segment → /analyze/segment-feedback → /analyze/overall-feedback
 필수      필수              필수                 실패해도 계속                 실패해도 계속                 실패해도 계속
```

- 앞의 세 단계가 실패하면 멈춘다. 뒤의 세 단계는 실패해도 경고만 남기고 다음으로 간다 (해당 칸만 빈다).
- 대시보드의 "다시 분석하기"는 결과가 빠진 단계만 골라 다시 부른다 (분석 비용 절약).
- **전부 동기 호출이다.** 요청이 끝날 때까지 HTTP 가 열려 있다. 음성 분석은 수 분이 걸릴 수 있으니 fetch 타임아웃을 넉넉히.
- 단계마다 `analysis_events` 에 실행 기록(소요 시간·성공/실패·모델)이 남는다 → [11. 관리자](#11-관리자).

---

## 2. 인증

`/health`, `/auth/providers`, `/auth/google/*`, `/auth/oauth/exchange`, `/auth/login`, `/auth/refresh`, `/auth/logout` 을 뺀 **모든 엔드포인트가 토큰을 요구**한다.

```
Authorization: Bearer <access_token>
```

**회원가입은 구글 로그인으로만 한다.** 이메일 가입(`/auth/signup`)은 없앴고, 이메일+비밀번호 로그인은 `DEBUG=true` 일 때만 열린다 (예전 계정·개발용 계정 확인용).

### 토큰 세 종류

| | 수명 | 쓰임 | 취소 |
|---|---|---|---|
| **access** | 60분 (`JWT_EXPIRE_MINUTES`) | 모든 API 요청에 첨부 | **불가** — 무상태 JWT라 만료까지 유효 |
| **refresh** | 14일 (`JWT_REFRESH_EXPIRE_DAYS`) | access 재발급 전용 | 가능 — `jti` 를 `refresh_tokens` 에 기록 |
| **video 티켓** | 30분 | 영상 하나 재생 전용 → [6. 영상](#6-업로드영상) | 불가 (짧은 수명으로 대응) |

payload 의 `type` 으로 구분된다. **access 자리에 refresh 나 티켓을 넣으면 401** 이다.

> **refresh 는 한 번 쓰면 폐기된다(회전).** `/auth/refresh` 응답에 새 refresh 가 함께 오므로
> 프론트는 **매번 저장값을 교체**해야 한다. 옛 값으로 다시 부르면 `401`.
> 프론트의 `apiFetch` 가 401 을 받으면 자동으로 갱신 후 재시도한다.

---

### `GET /auth/providers` — 켜진 소셜 로그인 (토큰 불필요)

```json
{ "google": true }
```

서버에 구글 키가 설정돼 있는지. 로그인 화면이 버튼을 그릴지 정할 때 쓴다.

---

### 구글 로그인 흐름 (토큰 불필요)

OAuth 2.0 Authorization Code + **PKCE**. 브라우저 이동으로 진행되므로 fetch 가 아니라 `location.href` 로 시작한다.

```
1. 프론트 "구글로 계속하기" → GET /auth/google/login?next=/dashboard
2. 서버가 state·PKCE 값을 서명된 쿠키에 넣고 구글 로그인 화면으로 302
3. 구글 → GET /auth/google/callback?code=..&state=..
   쿠키의 state 와 비교(CSRF 방지) → 구글 토큰 교환 → 이메일·sub 확인 → 회원 찾기/만들기
4. 서버가 60초짜리 1회용 코드를 만들어 프론트 /auth/callback#code=..&next=.. 로 302
5. 프론트 → POST /auth/oauth/exchange { "code": "..." } → 토큰 쌍
```

| 엔드포인트 | 설명 |
|---|---|
| `GET /auth/google/login?next=` | `next` 는 로그인 뒤 돌아갈 프론트 경로 (외부 주소는 무시) |
| `GET /auth/google/callback` | 구글이 부르는 곳. 직접 호출하지 않는다. 취소·실패 시 프론트로 에러 문구와 함께 돌려보낸다 |
| `POST /auth/oauth/exchange` | 본문 `{ "code": "..." }` → [토큰 쌍](#토큰-쌍-응답). 만료·재사용 코드는 `401` |

**회원 연결 규칙**
1. `(google, sub)` 로 연결된 회원이 있으면 그 회원 (`oauth_accounts`)
2. 없으면 같은 이메일의 기존 회원에 연결 — 구글이 확인한 이메일만 허용
3. 그것도 없으면 새 회원 (비밀번호 없음)

> 토큰을 URL 에 바로 싣지 않는 이유: 주소창·방문 기록에 오래 사는 refresh 토큰이 남는다.
> 1회용 코드는 60초 안에 한 번만 쓸 수 있고, `#` 뒤(fragment)라 서버 로그·Referer 에도 안 남는다.

---

### 토큰 쌍 응답

`/auth/oauth/exchange`, `/auth/login`, `/auth/refresh` 공통.

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs…",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs…",
  "token_type": "bearer",
  "expires_in": 3600
}
```

`expires_in` 은 access 토큰이 만료되기까지 남은 **초**.

---

### `POST /auth/login` — 이메일 로그인 (DEBUG 전용)

```json
{ "email": "dev@example.com", "password": "…" }
```

- `DEBUG=false`(배포)면 **`404`** — "구글로 로그인해주세요"
- 이메일이 없든, 구글 계정이라 비밀번호가 없든, 비밀번호가 틀리든 **같은 `401` 문구** (계정 열거 방지)

---

### `POST /auth/refresh` — 토큰 갱신

```json
{ "refresh_token": "eyJhbGciOiJIUzI1NiIs…" }
```

**응답** `200` — 새 토큰 쌍. **에러** `401` — 만료·위조·이미 사용된 refresh → 재로그인

> 쓴 refresh 는 즉시 폐기된다. 탈취되더라도 탈취자와 정상 사용자 중 **한쪽만** 갱신에
> 성공하고 다른 쪽은 `401` 을 받아 재로그인하게 되어 이상 징후가 드러난다.

---

### `POST /auth/logout` — 로그아웃

```json
{ "refresh_token": "eyJhbGciOiJIUzI1NiIs…" }
```

**응답** `204` — 이미 폐기됐거나 형식이 틀린 토큰이어도 `204` (멱등)

> ⚠️ **이미 발급된 access 토큰은 만료까지 계속 유효하다.** 프론트는 로그아웃 시 저장해둔 access 토큰도 함께 버려야 한다.

---

### `GET /auth/me` — 내 정보

```json
{
  "user_id": 2,
  "email": "student@example.com",
  "is_admin": false,
  "created_at": "2026-10-26T09:12:04.219Z",
  "display_name": "은재",
  "affiliation": "소프트웨어학부",
  "purpose": "class",
  "profile_completed_at": "2026-10-26T09:13:40.002Z"
}
```

- `profile_completed_at` 이 `null` 이면 프론트가 로그인 직후 `/profile` 화면으로 보낸다.
- `is_admin` 은 API 로 바꿀 수 없다. 서버에서 `python -m app.scripts.set_admin` 으로만 지정.

### `PATCH /auth/me` — 프로필 저장

전부 선택. **보낸 필드만** 바꾼다. 빈 문자열·`null` 은 지우기.

```json
{ "display_name": "은재", "affiliation": "소프트웨어학부", "purpose": "class" }
```

| 필드 | 제약 |
|---|---|
| `display_name` | 최대 50자, 앞뒤 공백 제거 |
| `affiliation` | 최대 100자 (소속·학과) |
| `purpose` | `class` · `interview` · `conference` · `work` · `other` |

빈 본문 `{}` 은 "건너뛰기" — 아무것도 안 바꾸고 `profile_completed_at` 만 찍는다.
**응답** `200` — `/auth/me` 와 같은 형태.

---

## 3. 헬스체크

### `GET /health` (토큰 불필요)

```json
{ "status": "ok" }
```

---

## 4. 폴더 (프로젝트)

화면에서는 "폴더", API·DB 에서는 `project`. 폴더 하나에 같은 발표의 연습 회차(세션)가 쌓인다.

### `POST /projects` — 생성

```json
{ "title": "캡스톤 중간발표" }
```

**응답** `201`
```json
{ "project_id": 3, "user_id": 1, "title": "캡스톤 중간발표", "created_at": "2026-09-17T14:02:11.482913+09:00" }
```

`title` 은 앞뒤 공백 제거 후 1~255자. 벗어나면 `422`. (`PATCH` 도 같은 규칙)

---

### `GET /projects` — 내 폴더 목록 (세션 포함)

폴더마다 **세션 목록이 함께** 내려간다. 휴지통에 있는 폴더는 빠진다.

- 폴더: 최신순 / 각 폴더의 세션: 최신순
- **청크는 포함하지 않는다** — 필요하면 `GET /sessions/{id}`

**응답** `200`
```json
[
  {
    "project_id": 3,
    "user_id": 1,
    "title": "캡스톤 중간발표",
    "created_at": "2026-09-17T14:02:11.482913+09:00",
    "sessions": [
      {
        "session_id": 11,
        "project_id": 3,
        "session_no": 2,
        "status": "segmented",
        "full_video_path": "11/full_video.webm",
        "pdf_path": null,
        "created_at": "2026-09-17T15:40:02.114+09:00"
      }
    ]
  }
]
```

> `session_no` 는 폴더 안의 회차 번호("N회차 연습"의 N). DB 에 저장돼 있어서 **앞 회차를 지워도 안 바뀐다.**
> 새 세션은 그 폴더의 가장 큰 번호 + 1. 화면에 회차를 표시할 땐 목록 순서가 아니라 이 값을 쓸 것.

---

### `PATCH /projects/{project_id}` — 이름 변경

```json
{ "title": "캡스톤 최종발표" }
```

**응답** `200` — `ProjectRead`. **에러** `404`, `422`

---

### `GET /projects/{project_id}/trend` — 종합 추이 (성장 추이 그래프)

폴더 안 회차들의 전체 지표를 **회차 번호 순**으로. 새로 계산하지 않고 저장된 분석 결과만 모은다.
값은 단일 분석 화면 상단 카드·비교 분석과 같은 계산 함수를 쓴다.

**응답** `200`
```json
{
  "project_id": 15,
  "points": [
    {
      "session_id": 61, "session_no": 1, "created_at": "2026-11-03T…",
      "duration_sec": 312.4,
      "filler_count": 2, "repetition_count": 1, "silence_ratio": 0.08,
      "speaking_rate_spm": 269.0,
      "general_gesture": 16, "negative_gesture": 7
    }
  ]
}
```

분석이 안 끝난 단계의 값은 `null` — 그래프에서 그 회차는 비워 둔다.

---

### 휴지통

| 엔드포인트 | 동작 |
|---|---|
| `DELETE /projects/{id}` | **휴지통으로.** `deleted_at` 만 찍는다. 응답 `204` |
| `GET /projects/trash` | 휴지통 목록 (버린 순, `GET /projects` 형태 + `deleted_at`) |
| `POST /projects/{id}/restore` | 복원. 이미 정상이어도 `200` (멱등) |
| `DELETE /projects/{id}/purge` | **영구 삭제.** DB CASCADE + 세션별 `uploads/{session_id}/` 삭제. 응답 `204` |

- 휴지통에 들어가면 그 폴더와 **하위 세션 전부가 `404`** 가 된다 (조회·수정·촬영·분석·비교 모두).
- **하위 세션에는 아무 표시도 하지 않는다.** 세션이 보이는지는 부모의 `deleted_at` 으로 판단한다 (`app/api/_deps.py`).
  세션에도 찍으면 복원할 때 원래 개별 삭제됐던 세션까지 되살아난다.
- `purge` 는 **휴지통에 없는 폴더면 `400`** — 반드시 휴지통을 거쳐야 한다. ⚠️ 되돌릴 수 없다.
- 휴지통 목록의 `sessions.length` 로 "회차 N개가 함께 처리됩니다" 를 띄운다.
- **자동 영구 삭제(보관 기간)는 아직 없다** — 무기한 보관. 휴지통 폴더도 원본 영상 용량을 그대로 차지한다.

---

## 5. 세션 (연습 회차)

### `POST /projects/{project_id}/sessions/start` — 생성

빈 세션을 만들고 회차 번호를 매긴 뒤 `uploads/{session_id}/` 를 준비한다. 녹화(또는 파일 업로드) **시작 시점**에 호출.

**응답** `201` — `SessionRead`, `status: "recording"`

---

### `GET /projects/{project_id}/sessions` — 목록

최신순. 청크 미포함. **응답** `200` — `SessionRead[]`

---

### `GET /sessions/{session_id}` — 단건 조회

세션 메타 + **업로드된 청크 목록**.

```json
{
  "session_id": 11, "project_id": 3, "session_no": 2,
  "status": "preprocessed",
  "full_video_path": "11/full_video.webm", "pdf_path": null,
  "created_at": "2026-09-17T15:40:02.114+09:00",
  "chunks": [
    { "chunk_id": 51, "chunk_index": 0, "file_path": "11/chunks/chunk_000.webm", "t_start": 0.0, "t_end": 30.0 }
  ]
}
```

> `chunks[].t_start/t_end` 는 `chunk_index × 30초` 로 **계산된 값**이지 실측이 아니다. 재생 위치 계산에 쓰지 말 것.
> 파일로 업로드한 영상은 청크가 없다 (`chunks: []`).

---

### `DELETE /sessions/{session_id}` — 삭제 (영구)

DB 행(CASCADE 로 분석·구간·피드백 전부) + `uploads/{session_id}/` 를 함께 지운다. **응답** `204`

> ⚠️ **세션에는 휴지통이 없다 — 즉시 영구 삭제다.** 폴더 삭제는 휴지통으로 가므로 확인 문구를 다르게 쓸 것.
> AI 비교 기록(`session_comparisons`)은 지워지지 않고 해당 회차 칸만 비워진다 (회차 번호는 남음).

---

## 6. 업로드·영상

### `POST /sessions/{session_id}/chunks?chunk_index=N` — 녹화 중 청크

녹화 중 30초 단위 webm 을 스트리밍 업로드. `multipart/form-data` 의 `file` 필드.

**응답** `200` — `{ "ok": true, "size_bytes": 1048576 }`

> 같은 `chunk_index` 를 다시 올리면 덮어쓴다. 네트워크 재시도 시 같은 index 로 재전송하면 된다.

---

### `POST /sessions/{session_id}/video` — 전체 영상

두 경우 모두 여기로 온다.
- **실시간 촬영**: Stop 시점에 전체 연속 녹화본(`full_video.webm`)을 1회
- **영상 파일 업로드**: "영상 업로드하기"로 고른 파일 (청크 없이 이것만)

허용 형식 `.webm` · `.mp4` · `.mov` — 원본 확장자 그대로 저장. 그 외는 `400`.
`session.full_video_path` 가 채워진다. **응답** `200` — `{ "ok": true, "size_bytes": … }`

---

### `POST /sessions/{session_id}/video/rotate?quarter=N` — 영상 방향 돌리기

전체 영상을 **시계 방향 90° × `quarter`(1~3)** 돌려 `full_video.mp4` 로 바꾼다.

휴대폰을 가로로 들었는데 화면 방향 고정 때문에 페이지가 세로로 남으면 사람이 누운 채 녹화된다.
촬영 화면은 촬영 후 "분석 시작" 전에 방향을 확인받고, 돌려야 하면 동작 분석 전에 이걸 부른다.
다시 인코딩하므로 영상 길이에 비례해 시간이 걸린다. 소리만 쓰는 전처리·음성 분석은 영향 없다.

**에러** `400` — `quarter` 가 1~3 밖이거나 전체 영상이 없음 / `500` — ffmpeg 실패

---

### `POST /sessions/{session_id}/video/ticket` — 재생 티켓 발급

```json
{ "ticket": "eyJhbGciOiJIUzI1NiIs…", "expires_in": 1800 }
```

`<video src="...">` 는 브라우저가 직접 요청하므로 `Authorization` 헤더를 붙일 수 없다.
access 토큰을 쿼리에 실으면 서버 로그·브라우저 기록에 **모든 API 를 여는 열쇠**가 남으므로, 권한을 좁힌 별도 토큰을 쓴다.

| | access 토큰 | 재생 티켓 |
|---|---|---|
| 수명 | 60분 | **30분** (발표 영상을 보는 동안 안 끊기게) |
| 범위 | 모든 API | **해당 세션 영상 하나** |
| 일반 API 사용 | 가능 | **불가** (`type` 이 달라 401) |

---

### `GET /sessions/{session_id}/video` — 영상 스트리밍·다운로드

녹화 원본을 **HTTP Range 지원**으로 내려준다 (구간 클릭 → 해당 시점 재생).

| 요청 | 응답 |
|---|---|
| Range 헤더 없음 | `200` + 전체. `Accept-Ranges: bytes` |
| `Range: bytes=0-1023` | `206` + `Content-Range: bytes 0-1023/<크기>` |
| `Range: bytes=-500` | `206` + 마지막 500바이트 |
| 파일 크기 초과 | `416` |
| `?download=1` | `Content-Disposition: attachment` 로 통째로 (영상 다운로드 버튼) |

**인증은 둘 중 하나**: `Authorization: Bearer <access>` (fetch) 또는 `?ticket=<video_ticket>` (`<video src>`)

**에러** `401` — 헤더·티켓 둘 다 없거나 무효 / `404` — 내 세션이 아니거나 영상이 없음

```html
<video id="player" controls></video>
<script>
  const { ticket } = await (await apiFetch(`/sessions/${id}/video/ticket`, { method: "POST" })).json();
  player.src = `${API}/sessions/${id}/video?ticket=${ticket}`;
  player.currentTime = segment.t_start;
</script>
```

> 서버는 파일 경로를 **DB 의 `full_video_path` 로만** 조립한다. 클라이언트가 경로를 넘겨도 무시된다.
> `uploads/` 는 정적 서빙되지 않는다 — 파일에 닿는 유일한 경로가 이 API 다.

---

## 7. 분석 단계

[1. 분석 호출 순서](#분석-호출-순서-프론트-frontendsrcutilsanalysists) 참고. 각 단계는 **재호출하면 이전 결과를 지우고 새로 넣는다.**

| 단계 | 모델 | 저장 위치 |
|---|---|---|
| STEP 1 전처리 | ffmpeg | `uploads/{id}/full_audio.wav` |
| STEP 3 음성 | SeloWhisper(`hf:rearleg/SeloWhisper-ko-disfluency`, 설정 `WHISPER_MODEL`, Modal 서버리스 GPU 가능) | `stt_sentences`, `voice_raws` |
| STEP 4 구간 분리 | `gpt-4.1` | `segments`, `segment_analyses`, `session_summaries` |
| STEP 2 동작 | Gemini (`step2_video_analysis.MODEL`) | `video_analyses` → `segment_analyses` 영상 칸 |
| STEP 5 피드백 | `gpt-4.1` | `feedbacks`, `session_summaries.llm_feedback` |

---

### `POST /sessions/{session_id}/end` — STEP 1 전처리

청크가 있으면 청크별 wav 추출 → concat, 없으면(파일 업로드) 전체 영상에서 바로 오디오 추출. `status` 를 `preprocessed` 로.

```json
{ "session_id": 11, "status": "preprocessed", "full_audio_path": "11/full_audio.wav", "total_duration_sec": 612.34, "chunk_count": 21 }
```

- `total_duration_sec` 은 `null` 일 수 있다 (ffprobe 실패).
- **에러** `400` — 청크도 전체 영상도 없음 / 영상에서 소리를 추출하지 못함

---

### `POST /sessions/{session_id}/analyze/voice` — STEP 3 음성 분석

`full_audio.wav` 로 STT + 무음 + 필러 + 반복(말더듬) + 말 속도.

| 파라미터 | 위치 | 설명 |
|---|---|---|
| `keywords` | query (선택) | 발표 주제·고유명사를 쉼표로. hotwords 로 전달돼 인식률이 오른다. **실제로 나오는 고유명사만** 넣을 것 |

- **선행 조건**: `status` 가 `preprocessed` 또는 `analyzed`
- **에러** `400` — 상태 불일치 또는 `full_audio.wav` 없음

**응답** `200` — `status: "analyzed"`
```json
{
  "session_id": 11, "status": "analyzed",
  "model": "hf:rearleg/SeloWhisper-ko-disfluency",
  "total_duration": 612.34, "sentence_count": 87,
  "silence_count": 12, "filler_count": 23, "repetition_count": 5,
  "speaking_rate_spm": 284.1, "articulation_rate_spm": 331.7,
  "elapsed_sec": 143.28,
  "timings": { "vad_sec": 3.1, "stt_sec": 121.4, "stt_wait_sec": 18.2, "stt_decode_sec": 103.2, "filler_sec": 6.2 }
}
```

| 필드 | 의미 |
|---|---|
| `speaking_rate_spm` | **음절**/분, 무음 포함 — 전체 템포 |
| `articulation_rate_spm` | **음절**/분, 무음 제외 — 순수 조음 속도 |
| `timings` | 세부 시간. `stt_sec` = `stt_wait_sec`(업로드·GPU 대기·모델 로딩) + `stt_decode_sec`(실제 인식). Modal 이면 `stt_queue_sec`·`stt_model_load_sec`·`stt_gpu`·`stt_cold` 가 더 붙는다. 키는 바뀔 수 있으니 표시용으로만 |

> 한국어는 어절(WPM)이 아니라 **음절(SPM)** 기준이다. 띄어쓰기에 따라 어절 수가 크게 흔들리기 때문.

---

### `POST /sessions/{session_id}/analyze/segments` — STEP 4 구간 분리 + 집계

STT 문장을 의미 단위 구간으로 나누고, 구간마다 음성 지표를 집계한다. `status` 를 `segmented` 로.

- **선행 조건**: STEP 3 필수 (`stt_sentences` 없으면 `400`)
- LLM 에는 **문장 번호만** 넘기고 시각은 `stt_sentences` 에서 가져온다 (근거는 [Dev-STEP4](../_refs/Dev-STEP4.md))
- **재호출 시** 기존 `segments` 를 통째로 교체 — `segment_analyses`, `feedbacks` 도 CASCADE 로 함께 삭제. 동작 분석·피드백도 다시 돌려야 한다

**응답** `200`
```json
{
  "session_id": 11, "status": "segmented",
  "segment_count": 6, "sentence_count": 87,
  "segments": [
    {
      "segment_id": 31, "label": "도입", "title": "클라우드와 발표 주제 소개",
      "t_start": 0.0, "t_end": 72.0, "duration": 72.0,
      "silence_count": 1, "filler_count": 5, "repetition_count": 0,
      "speaking_rate_spm": 271.4, "articulation_rate_spm": 318.2
    }
  ],
  "warnings": []
}
```

| 필드 | 의미 |
|---|---|
| `label` | 분류용 semi-enum. 회차 비교에서 같은 성격의 구간끼리 맞대는 기준 |
| `title` | 사용자에게 보여줄 한 줄 요약. `label` 과 **역할이 다르다** |
| `warnings` | LLM 출력 검증·보정 내역. 비어 있으면 정상 |

**`label` 9종** — 순서 강제 없고 반복 가능 (`step4_segmentation.LABELS`)

```
도입 · 배경 · 핵심개념 · 문제제시 · 해결방안 · 사례 · 시연 · 결과 · 마무리
```

> `배경` · `핵심개념` 은 쪼개지기 쉬워 20초보다 짧으면 독립 구간으로 보지 않고 이웃 구간에 흡수한다.
> 「기타」 라벨은 **의도적으로 없다** — 곁길 이야기마다 구간이 쪼개지는 걸 막기 위함.

---

### `POST /sessions/{session_id}/analyze/motion-by-segment` — STEP 2 동작 분석

STEP 4 가 나눈 **구간을 기준으로** 영상을 잘라(청크 최대 1분) Gemini VLM 에 넣는다.
분석이 끝나면 구간별 영상 집계(`segment_analyses` 의 제스처·자세·시선·`motion_notes`·`gesture_timelines`)도 채운다.
STEP 5 피드백이 `motion_notes` 를 동작·시선 근거로 쓰므로 피드백보다 먼저 불러야 한다.

- **선행 조건**: 구간 분리 완료 (`segments` 없으면 `400`), 전체 영상 업로드 (없으면 `400`)
- `status` 는 바꾸지 않는다 (`segmented` 유지)
- **비멱등**: 호출할 때마다 Gemini 과금

**응답** `200`
```json
{ "session_id": 11, "status": "segmented", "chunk_count": 9, "analyzed_count": 9, "covered_sec": 348.0, "json_output_path": "11/vlm_analysis.json" }
```

| 필드 | 의미 |
|---|---|
| `chunk_count` | 구간 기준으로 자른 청크 수 (업로드 청크 수와 **무관**) |
| `analyzed_count` | VLM 이 결과를 돌려준 청크 수. `chunk_count` 보다 작으면 일부 실패 |
| `covered_sec` | VLM 이 실제로 본 총 길이 |

> **`POST /sessions/{id}/analyze/motion` (구)**: 구간과 무관하게 **스마트 청킹 v2**(동작 시작 시점부터 20초)로 자르던 예전 방식.
> 선행 조건이 `preprocessed`/`analyzed` 이고 status 를 `analyzed` 로 바꾼다. 응답 형태는 같다.
> **프론트는 더 이상 쓰지 않는다** — 구간 집계를 채우지 않으므로 피드백 근거가 비게 된다.

---

### `POST /sessions/{session_id}/analyze/segment-feedback` — STEP 5 구간별 피드백

구간마다 LLM 을 따로 부른다 (동시에 최대 4개). 구간 하나에 발표 전체 목차 + 그 구간의 전사문·지표 +
겹치는 영상 조각 + 그 구간의 무음·필러·반복만 보낸다. 피드백 문장에는 **근거 시각(M:SS)** 이 들어가며,
데이터에 없는 시각을 쓰면 다시 요청한다 (최대 3회).

- **선행 조건**: 음성 분석 완료 (`voice_raws` 없으면 `400`) + 구간 분리
- **일부 구간이 실패해도** 성공한 구간은 저장하고, 실패한 구간은 응답에 `error` 로 적는다

**응답** `200`
```json
{
  "session_id": 11,
  "segments": [
    {
      "segment_id": 31, "label": "도입", "title": "클라우드와 발표 주제 소개", "t_start": 0.0, "t_end": 72.0,
      "feedback": {
        "rating": "보통",
        "strengths": ["0:00~1:12 에 바른 자세와 안정적인 시선 유지로 …"],
        "improvements": ["0:14~1:02 에 '이제'와 '어' 같은 필러가 5회 …"]
      }
    },
    { "segment_id": 32, "label": "문제제시", "title": "…", "t_start": 72.0, "t_end": 114.0, "error": "…" }
  ]
}
```

| 필드 | 값 |
|---|---|
| `rating` | `잘함` · `보통` · `개선필요`. 이 칸이 생기기 전에 분석한 구간은 `null` (스티커를 안 그림) |
| `strengths` / `improvements` | 근거 시각이 붙은 문장 목록. 개선점이 없으면 빈 배열 |

### `GET /sessions/{session_id}/segment-feedback` — 저장된 구간별 피드백

재실행 없이 조회. 형태는 위와 같고, 아직 없는 구간은 `"feedback": null`.

---

### `POST /sessions/{session_id}/analyze/overall-feedback` — STEP 5 종합 피드백

LLM 을 한 번 불러 발표 전체 총평(핵심 한 줄 `headline` + 3~4문장 문단 `overall_summary`)을 `session_summaries.llm_feedback` 에 저장한다.
구간별 피드백이 먼저 끝나 있으면 구간 등급을 headline 의 잘한 점/고칠 점 비중에 반영한다.

- **선행 조건**: 음성 분석 + 구간 분리
- **에러** `502` — LLM 호출 실패

**응답** `200`
```json
{
  "session_id": 11,
  "headline": "설명 제스처를 잘 썼지만, '이제'가 말버릇처럼 나와요",
  "overall_summary": "도입, 문제제시, 해결방안 구간에서 … 다만 발표 전체에서 '이제'라는 단어가 12번 …"
}
```

### `GET /sessions/{session_id}/overall-feedback` — 저장된 종합 피드백

같은 형태. 아직 없으면 `overall_summary: null`. 2026-10-18 이전 분석은 `headline: null`.

---

## 8. 결과 조회 (단일 분석 화면)

전부 저장된 결과만 읽는다 (LLM 호출 없음).

### `GET /sessions/{session_id}/voice-summary` — 상단 카드 음성 지표

```json
{ "session_id": 79, "filler_count": 13, "repetition_count": 0, "silence_ratio": 0.0, "avg_speaking_rate_spm": 293.0 }
```

`avg_speaking_rate_spm` 은 구간 분리 후에 채워진다. 없는 값은 `null`.

---

### `GET /sessions/{session_id}/segments/trend` — 구간별 지표 그래프

세션 하나의 구간별 지표를 `t_start` 순으로. "구간별 지표" 꺾은선 그래프용.

```json
{
  "session_id": 79,
  "points": [
    {
      "segment_id": 31, "label": "도입", "title": "…", "t_start": 0.0, "t_end": 72.0,
      "filler_count": 5, "repetition_count": 0, "speaking_rate_spm": 291.0, "silence_ratio": 0.0,
      "positive_gesture_count": 1, "negative_gesture_count": 0
    }
  ]
}
```

`positive_gesture_count` = 설명 제스처 + 가리키기 + 몸 움직임, `negative_gesture_count` = 산만한 제스처 + 얼굴·머리 만지기 + 물건 만지작 + 닫힌 자세.

---

### `GET /sessions/{session_id}/script` — 인터랙티브 스크립트

문장과, 그 위에 얹을 무음·필러·반복을 시각과 함께. 문장을 누르면 그 시점부터 재생.

```json
{
  "session_id": 79,
  "sentences":   [ { "t_start": 0.0, "t_end": 1.2, "text": "안녕하세요." } ],
  "silences":    [ { "t_start": 28.1, "t_end": 30.5, "duration": 2.4 } ],
  "fillers":     [ { "t_start": 14.0, "t_end": 14.3, "text": "<um>", "source": "lexical" } ],
  "repetitions": [ { "t_start": 40.2, "t_end": 41.0, "text": "제 제 제가", "count": 3, "kind": "exact" } ]
}
```

| 필드 | 값 |
|---|---|
| `fillers[].source` | `lexical`(모델 태그·사전) · `acoustic`(음향 검출, 이때 `text` 는 `null`) |
| `repetitions[].kind` | `exact`(같은 말) · `stem`(앞부분만, 신뢰도 낮음) |

---

### `GET /sessions/{session_id}/analysis` — 영상 분석 원본

`video_analyses` 를 시간순으로. 스크립트의 "동작" 줄과 영상 구간 표시에 쓴다.

```json
{
  "session_id": 79, "status": "segmented",
  "analyses": [
    {
      "t_start": 0.0, "t_end": 36.0, "kind": "segment",
      "posture": "안정적", "eye_contact": "빈번", "gesture": "보통",
      "notes": "…",
      "gesture_counts": {
        "explanatory_gesture": 1, "distracting_gesture": 0, "touching_face_or_hair": 0,
        "pointing": 0, "fidgeting_with_objects": 0, "closed_posture": 0, "body_movement": 0
      }
    }
  ]
}
```

| 필드 | 값 |
|---|---|
| `kind` | `segment`(구간 기준) · 예전 스마트 청킹 결과는 `intro` · `motion` · `outro` |
| `posture` / `eye_contact` / `gesture` | **semi-enum 자유 텍스트** — 값으로 분기하지 말고 그대로 표시하거나 폴백을 둘 것 |
| `gesture_counts` | 위 7개 키 **고정**. 값은 정수 |

> 제스처 발생 시각(`gesture_timelines`)은 DB 에 저장되지만(2026-09-22~) 이 응답에는 없다.
> 구간 단위로 합친 값이 피드백 근거로 쓰인다.

---

## 9. 회차 비교

같은 폴더의 두 회차를 비교한다. 세 층으로 나뉜다 — 자세한 설계는 [Dev-비교분석](../_refs/Dev-비교분석.md).

| 층 | 내용 | 저장 |
|---|---|---|
| ① 지표 비교 | 회차 전체 수치 (레이더 차트) | ❌ 그때그때 계산 |
| ② 구간 비교 | 같은 라벨의 구간끼리 지표·영상·스크립트 | ❌ 그때그때 계산 |
| ③ AI 비교 피드백 | 지난 개선점이 해결됐는지 판정 | ✅ `session_comparisons` |

### `GET /projects/{project_id}/compare?base=&target=` — 비교 화면

- `base`·`target` 을 **둘 다 안 주면** 회차 목록(`sessions`)만 채워서 돌려준다 (회차 고르는 화면).
- 고른 회차가 이 폴더에 없거나 아직 구간 분리 전이면 `400`. 같은 회차 두 번도 `400`.

**응답** `200` (요약)
```json
{
  "project_id": 15,
  "sessions": [ { "session_id": 64, "session_no": 2, "created_at": "…", "comparable": true, "has_video": true } ],
  "base":   { "session_id": 64, "session_no": 2, "…": "…" },
  "target": { "session_id": 79, "session_no": 5, "…": "…" },
  "metrics": [
    { "key": "filler_per_min", "label": "필러", "unit": "회/분", "direction": "lower",
      "base": 0.4, "target": 3.6, "verdict": "worse", "base_count": 2, "target_count": 13 }
  ],
  "labels": [
    { "label": "도입", "status": "both", "metrics": [ "…MetricDiff…" ],
      "base_segments":   [ { "segment_id": 1, "title": "…", "t_start": 0.0, "t_end": 50.0, "stt_text": "…", "rating": "보통" } ],
      "target_segments": [ "…" ] }
  ],
  "warnings": [],
  "feedback": null
}
```

**지표 8종** (`app/services/compare.py`)

| key | label | unit | direction |
|---|---|---|---|
| `filler_per_min` | 필러 | 회/분 | lower |
| `repetition_per_min` | 말 더듬 | 회/분 | lower |
| `silence_ratio` | 무음 비율 | % (0~1) | lower |
| `speaking_rate_spm` | 말하기 속도 | 음절/분 | band (적정 범위) |
| `negative_gesture_per_min` | 부정적 제스처 | 회/분 | lower |
| `general_gesture_per_min` | 일반 제스처 | 회/분 | neutral (판정 없음) |
| `eye_contact_ratio` | 시선 맞춤 비율 | % (0~1) | higher |
| `duration_sec` | 발표 길이 | 초 | neutral |

- `verdict`: `improved` · `same` · `worse`. 작은 차이는 `same`. 판정 없는 지표거나 값이 없으면 `null`.
- 횟수 지표는 발표 길이가 달라도 비교되도록 **분당 횟수**로 바꾸고, 원래 횟수는 `*_count` 로 함께 준다.
- `labels[].status`: `both` · `only_base` · `only_target` (한쪽 회차에만 있는 구간).
- `warnings`: 두 회차의 분석 방식(모델)이 다를 때 등. 현재 화면에는 표시하지 않는다.
- `feedback`: 이 두 회차로 이미 만든 AI 비교 피드백 (없으면 `null`). 형태는 아래와 같다.

---

### `POST /projects/{project_id}/compare/feedback?base=&target=` — AI 비교 피드백 생성

LLM 호출 (보통 10~20초). 같은 두 회차로 다시 부르면 덮어쓴다. ①·② 도 생성 당시 값을 스냅샷으로 함께 남긴다.

**응답** `200`
```json
{
  "comparison_id": 7,
  "base_session_id": 64, "target_session_id": 79,
  "base_session_no": 2, "target_session_no": 5,
  "status": "done",
  "headline": "무음과 부정적 제스처, 시선은 크게 개선됐지만 필러 사용이 늘었어요",
  "items": [
    { "status": "resolved", "title": "무음 개선", "previous": "도입, 문제제시, 마무리 등에서 4~5초 무음이 흐름을 끊었음", "detail": "전체 무음 비율이 10.3%에서 0.0%로 …" },
    { "status": "new", "title": "'이제' 반복", "previous": null, "detail": "발표 전체에서 '이제'라는 단어가 12번 …" }
  ],
  "error": null,
  "created_at": "2026-11-24T…",
  "stale": false
}
```

| 필드 | 값 |
|---|---|
| `items[].status` | `resolved`(해결됨) · `improved`(좋아짐) · `persists`(여전함) · `new`(새로 생김) |
| `items[].previous` | 지난 회차의 지적 내용 (`new` 면 `null`) |
| `stale` | 만든 뒤 두 회차 중 하나가 재분석됨 → 화면에서 "다시 만들기" 권장 |

**에러** `400` — 회차 선택 오류 / `502` — LLM 실패 (이때도 `status: "error"` 로 기록은 남는다)

---

### `GET /projects/{project_id}/comparisons` — 지난 AI 비교 기록

이 폴더에서 만든 비교 피드백 목록 (최신순). 각 항목: `comparison_id`, 두 회차 id·번호, `status`, `headline`, `created_at`.
회차가 지워졌으면 그 회차의 `*_session_id` 가 `null` 이고 번호는 남는다.

### `DELETE /projects/{project_id}/comparisons/{comparison_id}` — 비교 기록 삭제

휴지통 없이 바로 삭제. 회차와 분석 결과는 그대로. **응답** `204` / 없으면 `404`

---

## 10. 개발용 (`DEBUG=true` 일 때만)

| 경로 | 설명 |
|---|---|
| `/dev/?project=<id>` | `backend/dev_static/` 정적 촬영 검증 페이지. 본 프론트 촬영 화면이 대체했으므로 제거 예정 |
| `POST /auth/login` | 이메일+비밀번호 로그인 → [2. 인증](#post-authlogin--이메일-로그인-debug-전용) |

---

## 11. 관리자

전부 `is_admin` 회원만. 아니면 `403`. 관리자 화면(`/admin`)이 쓴다.

| Method | Path | 설명 |
|---|---|---|
| GET | `/admin/health` | 외부 API 키 설정 여부 + 단계별 사용 모델 (호출 안 함) |
| POST | `/admin/health/{target}` | 실제로 짧은 요청 1건을 보내 연결 점검 |
| GET | `/admin/analyses/stats` | 단계별 소요 시간·실패율 통계 (`analysis_events` 집계) |
| GET | `/admin/analyses` | 전체 회원의 세션 최신순 (휴지통 폴더 포함) + 최근 분석 1회분 요약 |
| GET | `/admin/analyses/{session_id}` | 세션 하나의 실행 기록 전체 + 분석 결과 (사용자 대시보드와 같은 조회 함수 사용) |

**`target`**: `step2_gemini` · `step3_modal` · `step4_openai` · `step5_openai`

- 점검 실패도 `500` 이 아니라 `ok: false` + 에러 문구로 돌려준다 — 실패 사실과 이유가 곧 결과.
- `step3_modal` 은 배포된 Modal 앱을 **찾기만** 한다. GPU 를 켜지 않아 비용·대기 없음.
- "분석 1회"는 마지막 전처리(`/end`) 이후의 단계 기록이다. 총 소요는 첫 단계 시작 ~ 마지막 단계 종료
  (동시에 도는 단계가 있어 단계 시간을 더하지 않는다). 단계 이름: `preprocess` · `motion` · `voice` · `segments` · `segment_feedback` · `overall_feedback`.

---

## 12. 아직 없는 것

| 항목 | 현재 상태 |
|---|---|
| 분석 진행률 조회 / 백그라운드 분석 | 없음. 동기 호출이라 프론트가 단계별로 진행 문구를 띄운다 |
| PDF(발표 자료) 업로드 | 미구현. `sessions.pdf_path` 컬럼만 존재 |
| 세션 휴지통 | 없음. 세션 삭제는 즉시 영구 |
| 휴지통 자동 비우기(보관 기간) | 없음. 무기한 보관 |
| 회원 탈퇴 | API 없음 |
