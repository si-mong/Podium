# Dev - API 명세

> 2026-09-17 기준 **실제로 구현되어 동작하는** 엔드포인트만 기록한다.
> 미구현 항목은 맨 아래 [8. 아직 없는 API](#8-아직-없는-api) 참고.
> 전체 흐름은 [Design-시스템흐름](Design-시스템흐름.md), 파이프라인 내부는 [Dev-STEP3](Dev-STEP3.md) · [Dev-STEP4](Dev-STEP4.md).
>
> 이 문서는 사람이 읽는 계약서다. 필드 타입의 최종 진실은 서버를 띄우고 `http://localhost:8000/docs` (자동 OpenAPI).

---

## 0. 공통 사항

| 항목 | 값 |
|---|---|
| Base URL | `http://localhost:8000` |
| 인증 | **필수.** `Authorization: Bearer <access_token>` → [2. 인증](#2-인증) |
| 요청 본문 | 업로드 2종만 `multipart/form-data`, 나머지는 `application/json` |
| 시각 단위 | 초(second), `float`. 영상 시작이 `0.0` |
| 경로 필드 | `uploads/` 기준 **상대 경로** (`full_video_path`, `file_path` 등) |
| CORS | `http://localhost:3000` 만 허용 (`app/main.py`) |

### 에러 응답

FastAPI 기본 형식. 본문은 `{"detail": "..."}`.

| 코드 | 언제 |
|---|---|
| `400` | 선행 단계 미완료 (예: `/end` 안 하고 분석 호출), 업로드된 청크 없음 |
| `401` | 토큰이 없거나 만료·위조됨 → 재로그인 또는 갱신 |
| `409` | 이메일 중복 (회원가입) |
| `404` | 존재하지 않거나 **내 소유가 아닌** 프로젝트/세션 |
| `422` | 요청 스키마 불일치 (FastAPI 검증 실패) |

> 남의 리소스에도 `403` 이 아니라 `404` 를 준다. 존재 여부 자체를 노출하지 않기 위함.

---

## 1. 세션 상태 머신

거의 모든 엔드포인트가 `status` 를 보고 동작하므로 먼저 읽을 것.

```
  POST /sessions/start          POST /end            POST /analyze/motion
        │                          │                 POST /analyze/voice
        ▼                          ▼                        │
   recording  ──────────────> preprocessed ─────────────────┤
                             (full_audio.wav)               ▼
                                                        analyzed
                                                            │  POST /analyze/segments
                                                            ▼
                                                        segmented
```

| status | 의미 |
|---|---|
| `recording` | 세션만 생성됨. 업로드 대기/진행 중 |
| `preprocessed` | `/end` 완료 — 오디오 추출 + concat 끝. 분석 호출 가능 |
| `analyzed` | STEP 2 **또는** STEP 3 가 한 번이라도 끝남 |
| `segmented` | STEP 4 구간 분리까지 끝 |

> ⚠️ `analyzed` 는 **어느 쪽이 끝났는지 구분하지 못한다.** STEP 2(동작)와 STEP 3(음성)은
> 서로 의존하지 않아 병렬 실행이 가능한데 상태값이 하나뿐이라 그렇다.
> 분석을 백그라운드로 돌리게 되면 단계별 상태가 필요해진다 → `_refs/Todo-회의필요.md` 4번 항목.

---

## 2. 인증

`/health` 와 `/auth/*` 를 뺀 **모든 엔드포인트가 토큰을 요구**한다.

```
Authorization: Bearer <access_token>
```

### 토큰 두 종류

| | 수명 | 쓰임 | 취소 |
|---|---|---|---|
| **access** | 60분 (`JWT_EXPIRE_MINUTES`) | 모든 API 요청에 첨부 | **불가** — 무상태 JWT라 만료까지 유효 |
| **refresh** | 14일 (`JWT_REFRESH_EXPIRE_DAYS`) | access 재발급 전용 | 가능 — `jti` 를 `refresh_tokens` 에 기록 |

두 토큰은 payload 의 `type` 으로 구분된다. **access 자리에 refresh 를 넣으면 401** 이다 — 구분이 없으면 탈취된 access 토큰이 무기한 갱신에 쓰인다.

> **refresh 는 한 번 쓰면 폐기된다(회전).** `/auth/refresh` 응답에 새 refresh 가 함께 오므로
> 프론트는 **매번 저장값을 교체**해야 한다. 옛 값으로 다시 부르면 `401`.

---

### `POST /auth/signup` — 회원가입

```json
{ "email": "student@example.com", "password": "podium-pass-1234" }
```

**응답** `201`
```json
{ "user_id": 2, "email": "student@example.com", "created_at": "2026-09-18T09:12:04.219Z" }
```

**에러**
- `409` — 이미 가입된 이메일
- `422` — 아래 조건 위반 (본문 `detail[0].loc` 에 `email` / `password` 중 어느 쪽인지 들어온다)

> 토큰은 주지 않는다. 가입 직후 `/auth/login` 을 이어서 호출할 것.

#### 비밀번호 조건

| 조건 | 값 | 비고 |
|---|---|---|
| 길이 | **8~128자** | 벗어나면 `422`. 상한은 bcrypt 제약이 아니라 **요청 본문 폭주 방지**용 |
| 허용 문자 | **영문자 · 숫자 · 특수기호** | 출력 가능한 ASCII(`0x21`~`0x7E`)만. 즉 `a-z A-Z 0-9` 와 `!@#$%^&*()` 등 |
| 공백 | **전면 금지** | 앞·중간·뒤 어디든 불가. 탭·개행도 포함 |
| 한글·이모지 | **금지** | 악센트 문자(`café`)도 불가 — 비ASCII는 전부 거부 |
| 문자 조합 강제 | **없음** | 대문자·숫자를 섞으라고 요구하진 않는다. `abcdefgh` 통과 |

거부 사유에 따라 메시지가 다르게 나간다 (`detail[0].msg`):

| 입력 | 응답 |
|---|---|
| `"pass 1234"` | `비밀번호에 공백을 포함할 수 없습니다.` |
| `"비밀번호1234"` · `"password🔒"` | `비밀번호는 영문자·숫자·특수기호만 사용할 수 있습니다. (한글·이모지 불가)` |
| `"pass123"` (7자) | `String should have at least 8 characters` |

> 공백을 따로 먼저 검사하는 것은 **원인을 구분해 알려주기 위함**이다. "허용되지 않는 문자"라고만
> 하면 사용자가 무엇을 지워야 할지 알 수 없다.

> **bcrypt 72바이트 한계는 해소돼 있다.** bcrypt 는 원래 72바이트까지만 보고 나머지를
> 조용히 버리는데, 해싱 전에 **SHA-256 → base64** 로 한 번 접어서(항상 44바이트) 넣는다.
> 현재는 ASCII만 허용해 128자 = 128바이트지만, 한계를 넘겨도 뒷부분이 잘리지 않는다.
> 근거는 `app/core/security.py` 모듈 주석.

#### 이메일 조건

| 조건 | 동작 |
|---|---|
| 형식 검증 | `email-validator` 기준. `@` 없음, 도메인 없음 등은 `422` |
| 앞뒤 공백 | **자동 제거** — `"  a@x.com  "` → `a@x.com` |
| 대소문자 | **전부 소문자로 정규화해 저장.** `Student@Example.COM` → `student@example.com` |
| 중복 판정 | 정규화 후 비교 → `A@x.com` 과 `a@x.com` 은 **같은 계정** (`409`) |
| 예약 도메인 | `.local`, `.test` 등 special-use 도메인은 **`422`**. 테스트용 주소로 쓸 수 없다 |
| **비ASCII 주소** | **금지.** 한글 도메인(`a@한국.kr`)과 한글 로컬파트(`한글@example.com`) 모두 `422` |
| 실제 수신 확인 | **안 한다.** 인증 메일 발송·확인 절차 없음 — 존재하지 않는 주소로도 가입된다 |

> **도메인만 막으면 로컬파트로 우회된다.** 그래서 주소 전체에 ASCII 검사를 건다.
> punycode 로 적어 넣어도(`a@xn--3e0b707e.kr`) email-validator 가 유니코드로 되돌리므로
> 같은 검사에 함께 걸린다.

> 로컬파트(`@` 앞)까지 소문자로 바꾸는 건 RFC 상 엄밀하진 않지만(원칙적으로 대소문자 구분),
> 실제 메일 서비스가 전부 구분하지 않으므로 **같은 사람이 대소문자만 바꿔 중복 가입하는 것을 막는**
> 쪽을 택했다.

> ⚠️ **위 규칙은 회원가입에만 적용된다.** `POST /auth/login` 의 비밀번호에는 길이·문자 제약이
> 전혀 없다. 정책이 강화돼도 **그전에 가입한 사용자는 계속 로그인할 수 있어야** 하기 때문이다.
> (검증된 동작: 한글+공백이 섞인 옛 비밀번호로 로그인 `200`, 같은 값으로 신규 가입은 `422`)

---

### `POST /auth/login` — 로그인

```json
{ "email": "student@example.com", "password": "podium-pass-1234" }
```

**응답** `200`
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs…",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs…",
  "token_type": "bearer",
  "expires_in": 3600
}
```

`expires_in` 은 access 토큰이 만료되기까지 남은 **초**다. 이 값을 보고 갱신 시점을 잡으면 된다.

**에러** `401` — 이메일 또는 비밀번호 불일치

> 이메일이 없든 비밀번호가 틀리든 **같은 문구**를 준다. 구분해서 알려주면
> "이 이메일은 가입돼 있다"는 사실이 새어나가 계정 열거에 쓰인다.

---

### `POST /auth/refresh` — 토큰 갱신

```json
{ "refresh_token": "eyJhbGciOiJIUzI1NiIs…" }
```

**응답** `200` — `/auth/login` 과 같은 형태의 **새 쌍**

**에러** `401` — 만료·위조·이미 사용된 refresh 토큰 → 재로그인 필요

> 쓴 refresh 는 즉시 폐기된다. 탈취되더라도 탈취자와 정상 사용자 중 **한쪽만** 갱신에
> 성공하고 다른 쪽은 `401` 을 받아 재로그인하게 되어 이상 징후가 드러난다.

---

### `POST /auth/logout` — 로그아웃

```json
{ "refresh_token": "eyJhbGciOiJIUzI1NiIs…" }
```

**응답** `204` — 이미 폐기됐거나 형식이 틀린 토큰이어도 `204` (멱등)

> ⚠️ **이미 발급된 access 토큰은 만료까지 계속 유효하다.** JWT 는 무상태라 서버가 회수할 수 없다.
> 그래서 access 수명을 60분으로 짧게 잡았다. **프론트는 로그아웃 시 저장해둔 access 토큰도 함께 버려야 한다.**

---

### `GET /auth/me` — 현재 사용자

**응답** `200` — `{ "user_id": 2, "email": "…", "created_at": "…" }`

토큰 유효성 확인 겸 사용자 정보 조회. 앱 부팅 시 저장된 토큰이 살아 있는지 확인하는 용도로 쓰면 된다.

---

## 3. 헬스체크

### `GET /health`

```json
{ "status": "ok" }
```

---

## 4. 프로젝트

### `POST /projects` — 생성

**요청**
```json
{ "title": "캡스톤 중간발표" }
```

**응답** `201`
```json
{
  "project_id": 3,
  "user_id": 1,
  "title": "캡스톤 중간발표",
  "created_at": "2026-09-17T14:02:11.482913+09:00"
}
```

---

### `GET /projects` — 내 프로젝트 목록 (세션 포함)

프로젝트마다 **세션(연습 회차) 목록이 함께** 내려간다. 목록 화면에서 "이 프로젝트를 몇 회차 연습했는지"를
추가 요청 없이 그릴 수 있다.

- 프로젝트: 최신순 (`created_at DESC`)
- 각 프로젝트의 세션: 최신순 (`created_at DESC`)
- **청크는 포함하지 않는다** — 회차당 수십 개라 목록 응답이 불필요하게 커진다. 청크가 필요하면 [`GET /sessions/{id}`](#get-sessionssession_id--단건-조회).

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
        "status": "segmented",
        "full_video_path": "11/full_video.webm",
        "pdf_path": null,
        "created_at": "2026-09-17T15:40:02.114+09:00"
      },
      { "session_id": 10, "project_id": 3, "status": "preprocessed", "full_video_path": null, "pdf_path": null, "created_at": "2026-09-17T14:05:33.201+09:00" }
    ]
  }
]
```

---

### `PATCH /projects/{project_id}` — 제목 수정

현재 수정 가능한 필드는 `title` 뿐이다. 세션·분석 결과에는 영향이 없다 — 프로젝트는 회차를 묶는 이름표일 뿐.

**요청**
```json
{ "title": "캡스톤 최종발표" }
```

**응답** `200` — `ProjectRead` (생성 응답과 동일한 형태)

**에러**
- `404` — 없거나 내 프로젝트가 아님
- `422` — 제목이 비었거나 255자 초과

> `title` 은 앞뒤 공백이 제거되어 저장된다. 빈 문자열과 255자 초과는 DB 에 닿기 전에 걸러 `422` 로 돌려준다
> (컬럼이 `String(255)` 라 그냥 두면 Postgres 단에서 `500` 이 난다). `POST /projects` 도 같은 규칙.

---

### `DELETE /projects/{project_id}` — 휴지통으로 이동

**데이터를 지우지 않는다.** `projects.deleted_at` 에 시각을 찍어 조회에서 가릴 뿐이다. 완전히 없애려면 [purge](#delete-projectsproject_idpurge--영구-삭제).

**응답** `204` (본문 없음) · **에러** `404` — 없거나 내 프로젝트가 아님

휴지통에 들어가면 그 프로젝트와 **하위 세션 전부가 `404`** 가 된다. 복원 전에는 조회·수정·촬영·분석 모두 막힌다.

| 호출 | 휴지통 상태에서 |
|---|---|
| `GET /projects` | 목록에서 빠짐 |
| `GET /projects/{id}/sessions` · `GET /sessions/{id}` | `404` |
| `PATCH /projects/{id}` · `POST .../sessions/start` | `404` |
| `POST /sessions/{id}/analyze/*` | `404` |

> **하위 세션에는 아무 표시도 하지 않는다.** 세션이 보이는지는 **부모 프로젝트의 `deleted_at`** 으로 판단한다.
> 세션에도 찍으면 복원할 때 *원래 개별 삭제됐던 세션까지 되살아난다.*

---

### `GET /projects/trash` — 휴지통 목록

버린 순서(`deleted_at DESC`)로 반환. `GET /projects` 와 같은 형태에 **`deleted_at` 이 추가**된다.

```json
[
  {
    "project_id": 3,
    "user_id": 1,
    "title": "캡스톤 중간발표",
    "created_at": "2026-09-17T14:02:11.482913+09:00",
    "deleted_at": "2026-09-17T22:52:22.019381+09:00",
    "sessions": [ { "session_id": 17, "…": "…" } ]
  }
]
```

> `sessions` 가 그대로 딸려오므로 복원/영구삭제 확인창에서 `sessions.length` 로 *"회차 N개가 함께 처리됩니다"* 를 띄우면 된다.

---

### `POST /projects/{project_id}/restore` — 복원

휴지통에서 꺼낸다. 하위 세션도 함께 다시 보이게 된다.

**응답** `200` — `ProjectRead`

> 이미 정상 상태인 프로젝트에 호출해도 `200` 이다. 되돌리는 동작이라 관대하게 처리했다 — 더블클릭·중복 요청에 안전.
> 복원해도 **개별 삭제했던 세션은 돌아오지 않는다** (그건 애초에 하드 삭제였다).

---

### `DELETE /projects/{project_id}/purge` — 영구 삭제

프로젝트와 **하위 세션 전부**를 실제로 지운다. DB 행은 CASCADE 로, 업로드 파일은 세션마다 `uploads/{session_id}/` 를 직접 삭제한다.

**응답** `204` (본문 없음)

**에러**
- `400` — **휴지통에 없는 프로젝트.** 정상 프로젝트를 없애려면 반드시 휴지통을 먼저 거쳐야 한다
- `404` — 없거나 내 프로젝트가 아님

> ⚠️ **되돌릴 수 없다.** 회차 수십 개와 분석 결과, 원본 영상이 한 번에 사라진다.
> 응답 본문이 없으니 성공 판정은 상태 코드 `204` 로 한다.

---

### 휴지통 보관 기간 — 미정

**자동 영구 삭제는 아직 없다.** `deleted_at` 만 기록해두므로 "30일 경과" 같은 계산은 언제든 가능하지만, 배치·스케줄러는 구현하지 않았다. 즉 **현재는 무기한 보관.**

> ⚠️ 휴지통에 있는 프로젝트도 **원본 영상 파일을 그대로 점유한다.** 10분 발표가 수백 MB이고
> 저장소가 아직 로컬 `uploads/` 라 쌓이면 디스크가 찬다. 개발 중에는 가끔 purge 로 비울 것.

보관 기간·자동 정리 방식·용량 표시 여부는 미확정 → `_refs/Todo-회의필요.md` **5번 항목**.
WBS 2.5(로컬 → S3/R2 전환)를 시작하기 전에는 결정돼 있어야 한다 — 보관 정책이 스토리지 비용 산정에 그대로 들어간다.

---

## 5. 세션 (연습 회차)

### `POST /projects/{project_id}/sessions/start` — 생성

빈 세션을 만들고 `uploads/{session_id}/{chunks,audio}/` 디렉터리를 준비한다.
녹화 **시작 시점**에 호출할 것 — 이후 업로드가 이 `session_id` 로 들어간다.

**응답** `201` — `status: "recording"`
```json
{
  "session_id": 11,
  "project_id": 3,
  "status": "recording",
  "full_video_path": null,
  "pdf_path": null,
  "created_at": "2026-09-17T15:40:02.114+09:00"
}
```

**에러** `404` — 없거나 내 프로젝트가 아님

---

### `GET /projects/{project_id}/sessions` — 목록 조회

해당 프로젝트의 세션을 최신순으로. 위와 같은 이유로 **청크는 미포함.**

**응답** `200` — `SessionRead[]` (위 `sessions` 배열과 동일한 형태)

---

### `GET /sessions/{session_id}` — 단건 조회

세션 메타 + **업로드된 청크 목록**.

**응답** `200`
```json
{
  "session_id": 11,
  "project_id": 3,
  "status": "preprocessed",
  "full_video_path": "11/full_video.webm",
  "pdf_path": null,
  "created_at": "2026-09-17T15:40:02.114+09:00",
  "chunks": [
    { "chunk_id": 51, "chunk_index": 0, "file_path": "11/chunks/chunk_000.webm", "t_start": 0.0,  "t_end": 30.0 },
    { "chunk_id": 52, "chunk_index": 1, "file_path": "11/chunks/chunk_001.webm", "t_start": 30.0, "t_end": 60.0 }
  ]
}
```

> `chunks[].t_start/t_end` 는 `chunk_index × 30초` 로 **계산된 값**이지 실측이 아니다.
> 마지막 청크는 30초보다 짧아도 `t_end` 가 30초 배수로 찍힌다. 재생 위치 계산에 쓰지 말 것.

---

### `DELETE /sessions/{session_id}` — 삭제 (영구)

DB 행(CASCADE 로 청크·분석·구간 전부) + `uploads/{session_id}/` 디렉터리를 함께 지운다.

**응답** `204` (본문 없음)

> ⚠️ **세션에는 휴지통이 없다 — 즉시 영구 삭제다.** 프로젝트 삭제(`DELETE /projects/{id}`)는
> 휴지통으로 가지만 세션은 바로 사라진다. 같은 `DELETE` 라도 **복구 가능성이 정반대**이므로
> 프론트에서 확인 문구를 다르게 쓸 것 — 프로젝트는 "휴지통으로 이동", 세션은 "영구 삭제".
>
> 프로젝트를 복원해도 **개별 삭제했던 세션은 돌아오지 않는다.** 세션 휴지통 확장 여부는
> `_refs/Todo-회의필요.md` 5번 항목에서 논의 중.

---

## 6. 업로드

### `POST /sessions/{session_id}/chunks?chunk_index=N`

녹화 중 30초 단위 webm 을 스트리밍 업로드. `multipart/form-data` 의 `file` 필드.

| 파라미터 | 위치 | 설명 |
|---|---|---|
| `session_id` | path | |
| `chunk_index` | **query (필수)** | 0부터. 순서 보장용 |
| `file` | form-data | webm blob |

**응답** `200`
```json
{ "ok": true, "size_bytes": 1048576 }
```

> 같은 `chunk_index` 를 다시 올리면 파일을 덮어쓰고 기존 DB 행을 갱신한다. **네트워크 재시도 시 그냥 같은 index 로 재전송하면 된다** (중복 행 안 생김).

---

### `POST /sessions/{session_id}/video`

Stop 시점에 **전체 연속 녹화본**을 1회 업로드. STEP 2 스마트 청킹의 입력.
`session.full_video_path` 가 채워진다.

**응답** `200` — `{ "ok": true, "size_bytes": 20971520 }`

> 청크와 전체 영상을 **둘 다** 올리는 현 구조는 같은 내용을 두 번 전송한다.
> 정리 논의 진행 중 → `_refs/Todo-회의필요.md` 2번 항목.

---

### `GET /sessions/{session_id}/video` — 영상 스트리밍 (구간 재생)

녹화 원본(`full_video.webm`)을 **HTTP Range 지원**으로 내려준다.

| 요청 | 응답 |
|---|---|
| Range 헤더 없음 | `200` + 전체. `Accept-Ranges: bytes` 포함 |
| `Range: bytes=0-1023` | `206` + `Content-Range: bytes 0-1023/33183466` |
| `Range: bytes=1000-` | `206` + 1000바이트부터 끝까지 |
| `Range: bytes=-500` | `206` + 마지막 500바이트 (브라우저가 메타데이터 찾을 때 씀) |
| 파일 크기 초과 | `416` + `Content-Range: bytes */<크기>` |

**인증은 둘 중 하나**를 받는다:

| 방식 | 언제 |
|---|---|
| `Authorization: Bearer <access_token>` | fetch/XHR 로 직접 받을 때 |
| `?ticket=<video_ticket>` | **`<video src>` 로 걸 때** → 아래 티켓 발급 |

**에러**
- `401` — 헤더·티켓 둘 다 없거나 유효하지 않음
- `404` — 내 세션이 아니거나, 영상이 업로드되지 않았거나, 파일이 없음

> ⚠️ **세션 응답의 `file_path` 는 이 API 의 입력이 아니다.** 표시용 값일 뿐이며,
> 서버는 경로를 **DB 의 `session.full_video_path` 로만** 조립한다. 쿼리로 경로를 넘겨도 무시된다.
> (클라이언트가 준 경로로 파일을 찾으면 남의 영상이 그대로 새어나간다)

---

### `POST /sessions/{session_id}/video/ticket` — 재생 티켓 발급

**응답** `200`
```json
{ "ticket": "eyJhbGciOiJIUzI1NiIs…", "expires_in": 300 }
```

**에러** `404` — 내 세션이 아님

#### 왜 티켓이 따로 필요한가

`<video src="...">` 는 **브라우저가 직접 요청을 보내므로 `Authorization` 헤더를 붙일 수 없다.**
그렇다고 access 토큰을 쿼리스트링에 실으면 서버 로그·브라우저 기록·Referer 에
**모든 API 를 열 수 있는 열쇠**가 남는다. 그래서 권한을 좁힌 별도 토큰을 쓴다.

| | access 토큰 | 재생 티켓 |
|---|---|---|
| 수명 | 60분 | **5분** |
| 범위 | 모든 API | **해당 세션 영상 하나** |
| 일반 API 사용 | 가능 | **불가** (`type` 이 달라 401) |

```html
<!-- 프론트 사용 예 -->
<video id="player" controls></video>
<script>
  const { ticket } = await (await fetch(`/sessions/${id}/video/ticket`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
  })).json();
  player.src = `/sessions/${id}/video?ticket=${ticket}`;
  player.currentTime = segment.t_start;   // 구간 클릭 → 해당 시점으로 점프
</script>
```

> 티켓은 **재생 시작 전에** 받을 것. 5분이 지나면 `401` 이므로, 긴 영상을 보다가
> 뒤늦게 탐색하면 끊길 수 있다. 그럴 땐 티켓을 다시 발급해 `src` 를 교체한다.

---

## 7. 파이프라인

호출 순서가 있다. **`/end` → (`motion` ∥ `voice`) → `segments`.**

```
/end ──┬──> /analyze/motion  (STEP 2, full_video)   ─┐
       └──> /analyze/voice   (STEP 3, full_audio)   ─┴──> /analyze/segments (STEP 4)
            └ 서로 독립. 순서 무관, 동시 실행 가능       └ voice 필수 / motion 선택
```

> **전부 동기 호출이다.** 요청이 끝날 때까지 HTTP 가 열려 있다. 10분 발표 기준 STT 는 수 분이 걸리므로
> **프론트 fetch 타임아웃을 넉넉히 잡을 것.**

---

### `POST /sessions/{session_id}/end` — STEP 1 전처리

청크별 wav 추출 → concat → `full_audio.wav` 생성. VLM/STT 호출은 하지 않으므로 빠르다.

**응답** `200` — `status: "preprocessed"`
```json
{
  "session_id": 11,
  "status": "preprocessed",
  "full_audio_path": "11/full_audio.wav",
  "total_duration_sec": 612.34,
  "chunk_count": 21
}
```

> `total_duration_sec` 은 **`null` 일 수 있다** — ffprobe 가 길이를 못 읽으면 `None`.
> 프론트에서 그대로 쓰기 전에 널 체크할 것.

**에러** `400` — 업로드된 청크가 하나도 없음

---

### `POST /sessions/{session_id}/analyze/motion` — STEP 2 동작 분석

`full_video` 를 스마트 청킹해서 잘라낸 뒤 각 청크를 Gemini VLM 에 넣는다. 결과는 `video_analyses` 에 저장.

- **선행 조건**: `status` 가 `preprocessed` 또는 `analyzed`, 그리고 `full_video` 업로드 완료
- **비멱등**: 호출할 때마다 Gemini 과금 발생. 재호출 시 이 세션의 기존 `video_analyses` 행은 **전부 지우고 새로 넣는다**

**응답** `200` — `status: "analyzed"`
```json
{
  "session_id": 11,
  "status": "analyzed",
  "chunk_count": 14,
  "analyzed_count": 14,
  "covered_sec": 187.5,
  "json_output_path": "11/vlm_analysis.json"
}
```

| 필드 | 의미 |
|---|---|
| `chunk_count` | 스마트 청킹이 만든 청크 수 (업로드 청크 수와 **무관**) |
| `covered_sec` | VLM 이 실제로 본 총 길이 — 전체 길이와 비교하면 절감률 |

**에러**
- `400` — `status` 가 `recording` (= `/end` 미호출)
- `400` — `full_video` 미업로드 또는 파일 없음

---

### `GET /sessions/{session_id}/analysis` — 동작 분석 결과 조회

`video_analyses` 를 시간순으로. `t_start` 로 **영상 타임스탬프 점프**가 가능하다.

**응답** `200`
```json
{
  "session_id": 11,
  "status": "analyzed",
  "analyses": [
    {
      "t_start": 0.0,
      "t_end": 15.0,
      "kind": "intro",
      "posture": "안정적",
      "eye_contact": "보통",
      "gesture": "적극적",
      "notes": "발표 시작 시 정면을 보고 서 있음",
      "gesture_counts": {
        "explanatory_gesture": 3,
        "distracting_gesture": 0,
        "touching_face_or_hair": 1,
        "pointing": 0,
        "fidgeting_with_objects": 0,
        "closed_posture": 0,
        "body_movement": 2
      }
    }
  ]
}
```

| 필드 | 값 |
|---|---|
| `kind` | `intro` · `motion` · `outro` |
| `posture` | 안정적 · 구부정 · 과도한 움직임 · 기댐 · 분석 불가 |
| `eye_contact` | 빈번 · 보통 · 드묾 · 분석 불가 |
| `gesture` | 적극적 · 보통 · 소극적 · 분석 불가 (제스처 **총평**) |
| `gesture_counts` | 위 7개 키 **고정**. 값은 정수 |

> `posture` / `eye_contact` / `gesture` 는 **semi-enum 자유 텍스트**다 (DB 제약 없음).
> 프론트에서 값으로 분기하지 말고 그대로 표시하거나, 매칭 실패 시 폴백을 둘 것.
> 근거: `docs/Dev-DB-카테고리 enum 저장 방침.md`
>
> VLM 은 동작별 발생 시각(`gesture_timelines`)도 함께 뱉지만 **DB 컬럼이 없어 저장되지 않는다.**
> 원본은 `uploads/{session_id}/vlm_analysis.json` 에만 남는다. 동작 단위 타임스탬프 점프가
> 필요하면 컬럼 추가가 선행돼야 함.

---

### `POST /sessions/{session_id}/analyze/voice` — STEP 3 음성 분석

`full_audio.wav` 로 STT + 무음 + 필러 + 반복 + 발화속도. `stt_sentences` / `voice_raws` 에 저장.

| 파라미터 | 위치 | 설명 |
|---|---|---|
| `keywords` | query (선택) | 발표 주제·고유명사를 쉼표로 구분. hotwords 로 전달돼 해당 어휘 인식률이 오른다 |

> ⚠️ `keywords` 에는 **발표에 실제로 나오는 고유명사만** 넣을 것. 무관한 단어는 디코딩을 흔든다.

- **선행 조건**: `status` 가 `preprocessed` 또는 `analyzed`
- **재호출 시** 기존 `stt_sentences` / `voice_raws` 를 지우고 새로 넣는다 (멱등)

**응답** `200` — `status: "analyzed"`
```json
{
  "session_id": 11,
  "status": "analyzed",
  "model": "hf:rearleg/SeloWhisper-ko-disfluency",
  "total_duration": 612.34,
  "sentence_count": 87,
  "silence_count": 12,
  "filler_count": 23,
  "repetition_count": 5,
  "speaking_rate_spm": 284.1,
  "articulation_rate_spm": 331.7,
  "elapsed_sec": 143.28
}
```

| 필드 | 의미 |
|---|---|
| `speaking_rate_spm` | **음절**/분, 무음 **포함** — 전체 템포 |
| `articulation_rate_spm` | **음절**/분, 무음 **제외** — 순수 조음 속도 |
| `elapsed_sec` | 분석에 걸린 시간 (타임아웃 설정 참고용) |

> 한국어는 어절(WPM)이 아니라 **음절(SPM)** 기준이다. 띄어쓰기 정책에 따라 어절 수가 크게 흔들리기 때문.
> 두 값을 나누면 *"말은 빠른데 자주 멈춘다"* 같은 진단이 나온다. 상세는 [Dev-STEP3](Dev-STEP3.md).

**에러** `400` — `status` 가 `recording`, 또는 `full_audio.wav` 없음

---

### `POST /sessions/{session_id}/analyze/segments` — STEP 4 구간 분리 + 집계

STT 문장을 의미 단위 구간으로 나누고, 구간마다 앞 단계 결과를 집계한다.
`segments` / `segment_analyses` / `session_summaries` 에 저장.

- **선행 조건**: STEP 3 **필수** (문장이 없으면 나눌 수 없음) / STEP 2 **선택** (없으면 동작 관련 컬럼만 빔)
- **재호출 시** 기존 `segments` 를 통째로 교체 — `segment_analyses`, `feedbacks` 도 CASCADE 로 함께 삭제

**응답** `200` — `status: "segmented"`
```json
{
  "session_id": 11,
  "status": "segmented",
  "segment_count": 7,
  "sentence_count": 87,
  "segments": [
    {
      "segment_id": 31,
      "label": "주제소개",
      "title": "발표 주제와 팀 소개",
      "t_start": 0.0,
      "t_end": 42.7,
      "duration": 42.7,
      "silence_count": 1,
      "filler_count": 3,
      "repetition_count": 0,
      "speaking_rate_spm": 271.4,
      "articulation_rate_spm": 318.2
    }
  ],
  "warnings": ["목록 밖 라벨 'Q&A' → 그대로 사용"]
}
```

| 필드 | 의미 |
|---|---|
| `label` | 분류용 semi-enum. 아래 12종 (또는 `미분류`) |
| `title` | 사용자에게 보여줄 한 줄 요약. `label` 과 **역할이 다르다** |
| `warnings` | LLM 출력 검증·보정 내역. 비어 있으면 정상 |

**`label` 12종** — 순서 강제 없고 반복 가능 (`step4_segmentation.LABELS`)

```
인사 · 주제소개 · 배경설명 · 문제제시 · 해결방안 · 시스템구조
구현 · 시연 · 결과 · 한계 · 향후계획 · 결론
```

> 「기타」 라벨은 **의도적으로 없다.** 곁길로 새는 이야기마다 구간이 쪼개지면 분리가 지나치게 빈번해지기 때문.
> 미확정 논의 → `_refs/Todo-회의필요.md` 3번 항목.

**에러** `400` — `stt_sentences` 없음 (= `/analyze/voice` 미호출)

---

## 8. 아직 없는 API

프론트 연동 시 **없다는 걸 알고 설계해야 하는 것들.**

| WBS | 항목 | 현재 상태 |
|---|---|---|
| 4.2.4 | 세션 분석 진행률 조회 | 보류 — 동기 호출이라 `status` 로 충분. `Todo-회의필요.md` 4번 |
| 4.3.4 | PDF 업로드 | 미구현. `sessions.pdf_path` 컬럼만 존재 |
| STEP 5 | LLM 종합 피드백 | 미구현. `feedbacks` 테이블만 존재 |

> `uploads/` 는 여전히 **정적 서빙되지 않는다.** 파일에 닿는 유일한 경로는
> `GET /sessions/{id}/video` 이며, 반드시 소유권 검사를 거친다. `DEBUG=true` 일 때
> `/dev` 로 뜨는 정적 마운트는 `backend/dev_static/` 테스트 페이지 전용이라 `uploads/` 와 무관하다.
