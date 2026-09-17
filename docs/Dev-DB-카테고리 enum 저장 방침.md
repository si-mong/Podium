# 카테고리 enum 저장 방침

VLM이 보내는 동작 카테고리(gesture / posture / eye_contact) enum을 어디에 저장할지 + 어떻게 사용할지 정리.
회의 의제 중 일부 — 사전 합의 자료.

> 이 문서는 점차 "STEP 2 통합 결정" 전반으로 확장됨 (호출 시점, 결과 저장 위치 등).
> 분량 커지면 별도 파일로 분리 예정.

---

## STEP 2 호출 시점 — 옵션 A vs B (재검토)

### 현재 코드 상태
팀원 구현은 **옵션 A** (`/end`에서 자동 트리거).

```python
# sessions.py /end 라우터
extract_chunk_audio(...)   # 전처리
concat_audio(...)           # full_audio.wav
step2_video_analysis.run(...)   # ★ VLM 자동 호출
session.status = "analyzed"
```

0520 진행상황.md에서는 **옵션 B**(별도 라우터)를 추천했었음. 재논의 필요.

### 비교

| 항목 | A. `/end`에서 자동 | B. 별도 `/analyze/motion` |
|---|---|---|
| **사용자 액션** | Stop 1번이면 끝 | Stop 후 "분석 시작" 액션 추가 (또는 프론트가 연쇄 호출) |
| **응답 시간** | 전처리(~수초) + **VLM 청크 N개 × 수십초** = **분 단위 hang** | /end는 즉시 응답. /analyze는 별도 |
| **HTTP timeout** | 30분 발표 = 60청크 = ~수십 분 → **timeout 위험 큼** | 안전 |
| **VLM 실패 복구** | 전처리도 같이 fail 처럼 보임. 재실행 = 모든 단계 다시 | VLM만 재호출 가능 |
| **프론트 UX** | "Stop 누르고 한참 기다림" | "분석 중... (진행률)" 표시 가능 |
| **server 의존성** | server 시작 시 google-genai 필수 (sessions.py에서 import) | lazy import 가능, server는 가벼움 |
| **코드 변경량** | 0 (현재 상태) | 라우터 1개 추가 + sessions.py /end에서 호출 제거 |

### 옵션 C (참고)
**BackgroundTasks 비동기**: /end 즉시 응답, 분석은 백그라운드. UX 최고지만 진행상태 폴링 API 필요 + uvicorn 워커 죽으면 분석 중단. 캡스톤 규모엔 과한 복잡도. 후순위.

### 추천 — 옵션 B

이유:
1. **timeout이 진짜 위험.** 30~60분 발표 가정 시 청크 60~120개. Gemini 청크당 30초만 잡아도 30분~1시간. 어떤 HTTP 클라이언트도 못 기다림
2. **재실행 용이성.** 검증/디버깅 단계에서 "VLM만 다시 호출"이 자주 필요할 것 (프롬프트 튜닝 등)
3. **server 가볍게 유지.** API 서버는 google-genai 같은 무거운 의존성 없이도 떠야 함 (옵션 B면 lazy import 가능)
4. **C로 진화 쉬움.** B 상태에서 BackgroundTasks 추가만 하면 C가 됨

### 구체 변경안 (옵션 B 채택 시)

```python
# sessions.py
# /end 에서 step2_video_analysis.run() 호출 제거
# 새 라우터 추가:

@router.post("/sessions/{session_id}/analyze/motion")
def analyze_motion(session_id: int, db: DbSession = Depends(get_db)):
    session = _get_owned_session(db, session_id)
    if session.status != "preprocessed":
        raise HTTPException(400, "must call /end first")

    # lazy import — 옵션 B의 핵심 이점
    from app.pipeline import step2_video_analysis

    chunks = db.scalars(select(Chunk).where(Chunk.session_id == session_id)).all()
    chunk_paths = [_settings_upload_dir() / c.file_path for c in chunks]

    result = step2_video_analysis.run(
        session_id=session_id,
        chunk_paths=chunk_paths,
        output_dir=storage.session_dir(session_id),
    )

    # TODO: DB 저장 — 아래 "VLM 결과 저장 위치" 결정에 따름
    session.status = "analyzed"
    db.commit()
    return result
```

---

## VLM 결과 저장 위치

현재: `uploads/<session_id>/vlm_analysis.json` 파일로만. DB 저장 0.
**제약**: `segment_analyses`는 segment FK 필수 → segments가 없으면 저장 불가. segments는 STEP 4(LLM 구간 분리)에서 만들어짐 → 아직 없음.

### 옵션

| 옵션 | 설명 | 장점 | 단점 |
|---|---|---|---|
| **a. JSON 파일만 유지** | 현재 그대로. STEP 4 끝나면 그때 매핑 + segment_analyses 저장 | 가장 빠름. 코드 변경 0 | STEP 4 안 만들어지면 DB 활용 불가. 회차 비교 SQL 불가 |
| **b. 새 `chunk_analyses` 테이블** | 청크별 VLM 결과를 DB에 저장 (캐시 역할). STEP 4 후 segment에 집계 | VLM 비싼 호출 결과 보존. 회차 비교를 청크 단위로도 가능. 점진적 진화 자연스러움 | 테이블 1개 추가, 마이그레이션 1번 |
| **c. placeholder segment** | "청크 1개 = segment 1개" 1:1 매핑으로 미리 segment 행 만들고 즉시 segment_analyses 저장 | 가장 빠르게 DB 활용 | STEP 4 가면 segment 재구성 → 데이터 정리 필요. 의미적으로 segment는 의미 단위지 청크 단위가 아님 (혼란) |

### 추천 — 옵션 b (새 `chunk_analyses` 테이블)

이유:
- VLM은 비싼 호출 → 결과는 무조건 영구 저장해야 함 (json만으론 약함)
- 청크 단위 결과 자체에도 가치 있음 (회차별 "필러 동작 추이" 등 가능)
- STEP 4 후엔 chunk_analyses → segment_analyses 집계 (간단)
- segment 의미를 흐리지 않음

### 스키마 안 (옵션 b)

```python
# models/analysis.py 에 추가
class ChunkAnalysis(Base):
    __tablename__ = "chunk_analyses"

    chunk_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("chunks.chunk_id", ondelete="CASCADE"),
        primary_key=True,
    )
    posture: Mapped[str | None] = mapped_column(String(32))            # semi-enum (옵션 (3) 합의에 따라)
    eye_contact: Mapped[str | None] = mapped_column(String(32))
    gesture: Mapped[str | None] = mapped_column(String(32))
    gesture_counts: Mapped[dict | None] = mapped_column(JSONB)         # 정적 enum 카운트
    notes: Mapped[str | None] = mapped_column(Text)
```

기존 `segment_analyses`는 그대로 두고 (STEP 4 후 집계 결과 저장용). `chunk_analyses`만 추가.

→ 옵션 b 채택 시 사용자가 만든 옵션 B 스키마 변경(segment_analyses에 JSONB 컬럼 추가)은 **그대로 유효**. chunk_analyses만 새로 추가하면 됨.

---

## 카테고리 enum 범위 (재검토)

현재 VLM 응답: `posture/eye_contact/gesture`는 자유 텍스트(단 한정 옵션 — "안정적/구부정/..." 4종), `gesture_counts`만 정적 enum.

| 옵션 | 평가 |
|---|---|
| **유지** (semi-enum) | 코드 변경 0. 단 회차 비교 시 posture/eye_contact/gesture는 다소 거칠어짐 |
| **전부 enum 강제** | 프롬프트 + normalize 함수 추가. 모든 차원에서 회차 비교 가능 |

→ **유지 추천**. posture 4종/eye_contact 3종/gesture 4종은 사실상 enum이라 비교 가능. SQL `GROUP BY posture`로 회차별 분포 충분히 그려짐. 단 `step2_video_analysis.py`에 상수로 옮겨두면 검증 가능:

```python
POSTURE_OPTIONS = frozenset({"안정적", "구부정", "과도한 움직임", "기댐"})
EYE_CONTACT_OPTIONS = frozenset({"빈번", "간헐적", "드묾"})
GESTURE_OPTIONS = frozenset({"적극적", "보통", "소극적", "반복적"})
```

---

## DB 스키마 변경 사항

### 배경
VLM이 자유 텍스트가 아닌 **정적 카테고리(enum) 10개+의 카운트 dict**를 응답하기로 결정되면서, 기존 `segment_analyses`의 자유 텍스트 컬럼(`posture`, `eye_contact`, `gesture`)이 이 형태를 담기에 부적합해짐.

### 변경 대상
**테이블**: `segment_analyses` (`backend/app/models/analysis.py`의 `SegmentAnalysis` 클래스)

### 변경 전 → 후

```diff
  segment_id        bigint PK FK
  stt_text          text
  wpm               float
  silence_count     integer
  filler_count      integer
- posture           text          ← 자유 텍스트
- eye_contact       text          ← 자유 텍스트
- gesture           text          ← 자유 텍스트
+ gesture_counts      JSONB       ← {"<category>": <count>, ...}
+ posture_counts      JSONB       ← {"<category>": <count>, ...}
+ eye_contact_counts  JSONB       ← {"<category>": <count>, ...}
  motion_notes      text          ← 그대로 유지 (enum 밖 동작 fallback)
```

### 왜 이 형태인가 (옵션 B 채택)

회의 안건에 4개 옵션이 있었고 (`_refs/0520 진행상황.md` 참고), 다음 이유로 옵션 B(카테고리별 JSONB 카운트)가 채택됨:

| 비교 항목 | 평가 |
|---|---|
| VLM 응답 형식과의 mapping | dict 그대로 저장 → 변환 코드 짧음 |
| **회차별 비교 SQL** | `(gesture_counts->>'scratching_head')::int` 한 단계 (옵션 A는 두 단계) |
| 의미 분류의 자기설명성 | 컬럼명에 gesture/posture/eye_contact 분리 명시 |
| 카테고리 추가 비용 | 마이그레이션 0 (코드 enum만 추가) |
| multi-label + count 동시 처리 | 자연스러움 |

옵션 A(JSONB 한 컬럼), C(ARRAY enum, count 없음), D(별도 정규화 테이블)와의 비교는 `_refs/0520 진행상황.md` 참고.

### 마이그레이션 영향

- **데이터 손실 가능성**: 거의 없음. 현재 `segment_analyses` 테이블은 **비어 있음**(분석 실제 호출 전). 혹시 dev 더미 데이터가 있더라도 posture/eye_contact/gesture 컬럼 값만 사라짐.
- **autogenerate가 잡는 변경**:
  - `DROP COLUMN posture, eye_contact, gesture`
  - `ADD COLUMN gesture_counts JSONB, posture_counts JSONB, eye_contact_counts JSONB`

### 적용 명령 (회의 후 확정되면)

```bash
cd backend
source .venv/bin/activate
alembic revision --autogenerate -m "switch motion fields to categorical JSONB counts"
# → 생성된 마이그레이션 파일 검토 (DROP/ADD 컬럼 정확히 잡혔는지)
alembic upgrade head
```

`models/analysis.py`의 코드 변경은 이미 적용된 상태. 회의에서 옵션 B 확정되면 위 두 명령만 실행하면 됨.
다른 옵션으로 결정되면: `git checkout backend/app/models/analysis.py`로 되돌리고 새로 작성.

### 연쇄 영향 (다른 곳에도 변경 필요한가)

| 모듈 | 영향 |
|---|---|
| `models/analysis.py` | **변경됨** (이 PR의 핵심) |
| Alembic 새 마이그레이션 | 추가 1개 |
| `schemas/` (Pydantic) | 추후 분석 결과 응답용 스키마 추가 시 반영 (이번 변경엔 X) |
| **STEP 1 전처리** | **영향 없음** — 청크/오디오만 다룸 |
| `services/storage.py`, `api/sessions.py`의 `/end` | 영향 없음 |
| ERD 파일 (`_refs/erd.txt`, `_refs/erd.md`) | 동기화 갱신 완료 |

---

## 결론

**코드에 Python 상수(`frozenset`)로 둔다.** DB가 아니라.

위치: `app/pipeline/step2_motion.py`

---

## 구체 코드

```python
# app/pipeline/step2_motion.py

GESTURE_CATEGORIES: frozenset[str] = frozenset({
    "hand_movement",
    "touching_face_or_hair",
    "pointing",
    "emphasizing_hand_movement",
    "head_nodding",
    "leaning_forward",
    "fidgeting_with_objects",
    "arms_crossed",
    "swaying_body",
    "scratching",
})

POSTURE_CATEGORIES: frozenset[str] = frozenset({
    # 팀원이 알려준 enum 채우기
})

EYE_CONTACT_CATEGORIES: frozenset[str] = frozenset({
    # 팀원이 알려준 enum 채우기
})


def normalize_gesture_counts(raw: dict) -> dict:
    """모든 카테고리가 항상 존재하도록 보장. 없는 키는 0으로 채움.

    VLM이 누락한 카테고리도 0으로 채워서 DB 행마다 동일한 키셋을 유지.
    → SQL 집계 시 NULL 처리 불필요.
    """
    return {cat: int(raw.get(cat, 0)) for cat in GESTURE_CATEGORIES}


def normalize_posture_counts(raw: dict) -> dict:
    return {cat: int(raw.get(cat, 0)) for cat in POSTURE_CATEGORIES}


def normalize_eye_contact_counts(raw: dict) -> dict:
    return {cat: int(raw.get(cat, 0)) for cat in EYE_CONTACT_CATEGORIES}


def extract_unknown(raw: dict, known: frozenset[str]) -> list[str]:
    """enum 밖 키 목록. motion_notes에 담거나 로깅."""
    return [k for k in raw.keys() if k not in known]
```

---

## 저장 위치 비교 - 코드에 저장

| 저장 위치 | 장점 | 단점 |
|---|---|---|
| **코드 상수 (`frozenset`)** ← 채택 | IDE 자동완성/typo 즉시 발견, import 한 번이면 끝, 검색/리팩토링 쉬움 | 카테고리 변경 시 코드 PR + 배포 |
| DB 별도 테이블 (`motion_categories`) | UI에서 "카테고리 관리" 가능, SQL FK로 DB 레벨 강제 가능 | 테이블 + JOIN 추가, 카테고리 자주 안 변하면 과함 |
| JSON/YAML 설정 파일 | 코드와 분리 | 런타임 파일 IO, 타입 안전 X |

**캡스톤 규모에선 카테고리가 자주 안 바뀜** → 코드 상수가 가장 단순/안전.

---

## DB는 무엇을 강제하지 않는다

`gesture_counts JSONB` 컬럼은 **아무 키나 받음** (DB 레벨 검증 0). 강제는 **앱 레벨에서만**:

```
[VLM 응답]
  ↓
[normalize_gesture_counts()]   ← enum 외 키는 분리 (motion_notes 또는 폐기)
  ↓
[DB INSERT]
```

이 흐름이 보장하는 것:
- 모든 분석 행이 동일한 키셋 (`hand_movement`, `pointing`, ...) 보유
- SQL `(gesture_counts->>'pointing')::int`가 항상 동작 (NULL 체크 불필요)
- 모르는 동작도 motion_notes에 데이터로 보존됨

---

## VLM 응답 형식 — 합의된 형태

팀원이 전송하는 예시:
```json
{
  "gesture_counts": {
    "hand_movement": 2,
    "touching_face_or_hair": 0,
    "pointing": 0,
    "emphasizing_hand_movement": 2,
    "head_nodding": 0,
    "leaning_forward": 0,
    "fidgeting_with_objects": 0,
    "arms_crossed": 0,
    "swaying_body": 0,
    "scratching": 0
  }
}
```

**`count=0`도 명시적으로 포함**한 게 잘한 선택. 이유:
- DB 행마다 같은 키셋 보장 → SQL 안전
- 회차 비교 그래프 그릴 때 빠진 카테고리 처리 안 해도 됨
- "0번 했다"와 "분석에서 못 잡았다"가 명확히 구분됨

→ `normalize_*` 함수가 이 형태를 유지함 (`raw.get(cat, 0)`).

---

## 진화 경로 (나중에 필요해지면)

현재: **Python 상수**
→ 카테고리가 자주 바뀌거나 운영자 UI에서 관리해야 하는 시점이 오면
→ **DB 테이블(`motion_categories`)로 마이그레이션**.

지금부터 정규화 테이블 만들면 캡스톤 규모엔 과한 복잡도 → 점진적 진화 채택.

---

## 팀원 작업 시 참고

- VLM 호출 결과(raw dict)를 그대로 normalize 함수에 통과시켜서 DB에 저장
- enum에 없는 카테고리가 자주 발견되면 → 슬랙에 공유 → enum에 추가하거나 motion_notes로 분류
- 카테고리 정의는 한 곳(`step2_motion.py`)에서만 변경. DB나 다른 곳에 박지 말 것
- 새 카테고리 추가는 코드 PR로 (마이그레이션 X)

---

## 회의에서 확정해야 할 것

- [ ] gesture / posture / eye_contact 각각의 enum 전체 목록
- [ ] enum 밖 동작이 들어오면 처리 정책 (motion_notes에 저장 vs 폐기 vs 로깅만)
- [ ] count 단위 (청크당 횟수 vs segment 집계 횟수 vs frame 단위 등)
