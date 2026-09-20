# Podium ERD (Mermaid)

> Mermaid `erDiagram` 버전. GitHub 마크다운 뷰어에서 자동 렌더링되고, Notion/Obsidian/VSCode 확장에서도 보임.
> 같은 스키마의 dbdiagram.io 버전은 `_refs/erd.txt` (확장자만 .txt).

---

```mermaid
erDiagram
    USERS ||--o{ PROJECTS : "owns"
    PROJECTS ||--o{ SESSIONS : "contains"
    SESSIONS ||--o{ CHUNKS : "split into 30s"
    SESSIONS ||--o{ STT_SENTENCES : "transcribed"
    SESSIONS ||--o{ SEGMENTS : "semantic segments"
    SESSIONS ||--o| VOICE_RAWS : "1:1 metrics"
    SESSIONS ||--o| SESSION_SUMMARIES : "1:1 summary"
    SEGMENTS ||--o| SEGMENT_ANALYSES : "1:1 analysis"
    SEGMENTS ||--o| FEEDBACKS : "1:1 feedback"
    SEGMENTS ||--o{ SESSION_SUMMARIES : "best/worst ref"

    USERS {
        bigint user_id PK
        varchar email UK
        varchar password_hash
        timestamptz created_at
    }

    PROJECTS {
        bigint project_id PK
        bigint user_id FK
        varchar title
        timestamptz created_at
    }

    SESSIONS {
        bigint session_id PK
        bigint project_id FK
        varchar status "processing/done/error"
        varchar full_video_path
        varchar pdf_path
        timestamptz created_at
    }

    CHUNKS {
        bigint chunk_id PK
        bigint session_id FK
        int chunk_index
        varchar file_path
        float t_start
        float t_end
    }

    STT_SENTENCES {
        bigint id PK
        bigint session_id FK
        text text
        float t_start
        float t_end
    }

    VOICE_RAWS {
        bigint session_id PK_FK
        float total_duration
        jsonb silence_segments
        jsonb filler_words
        jsonb repetitions "반복(말더듬) 구간 배열"
    }

    VIDEO_ANALYSES {
        bigint analysis_id PK
        bigint session_id FK
        float t_start "스마트 청크 시작"
        float t_end "스마트 청크 끝"
        varchar kind "intro|motion|outro"
        varchar posture
        varchar eye_contact
        varchar gesture
        jsonb gesture_counts "category->count"
        text notes
    }

    SEGMENTS {
        bigint segment_id PK
        bigint session_id FK
        varchar title
        float t_start
        float t_end
        int slide_index "nullable"
    }

    SEGMENT_ANALYSES {
        bigint segment_id PK_FK
        text stt_text
        float speaking_rate_spm "음절/분, 무음 포함"
        float articulation_rate_spm "음절/분, 무음 제외"
        int silence_count
        float silence_ratio "구간길이 대비 무음비율"
        int filler_count
        int repetition_count "반복(말더듬)"
        jsonb gesture_counts "category->count, enum=step2_motion.py"
        int positive_gesture_count "explanatory+pointing+body_movement"
        int negative_gesture_count "distracting+touching+fidgeting+closed"
        jsonb posture_counts "category->count"
        jsonb eye_contact_counts "category->count"
        text motion_notes "enum밖 동작 fallback"
    }

    FEEDBACKS {
        bigint segment_id PK_FK
        float score_delivery
        float score_fluency
        float score_motion
        text fb_delivery
        text fb_fluency
        text fb_motion
        text fb_overall
        jsonb strengths "STEP5 구간별 LLM: 잘한 점 목록(근거 시각 포함)"
        jsonb improvements "STEP5 구간별 LLM: 개선점 목록(근거 시각 포함)"
    }

    SESSION_SUMMARIES {
        bigint session_id PK_FK
        float total_duration
        int segment_count
        jsonb llm_feedback "종합분석 제거로 현재 미사용"
        int total_filler_count
        int total_repetition_count
        float avg_speaking_rate_spm
        float avg_articulation_rate_spm
        bigint best_segment_id FK
        bigint worst_segment_id FK
    }
```

---

## 관계 표기 범례

| 표기 | 의미 |
|---|---|
| `\|\|--o{` | 1 : 0..N (한쪽이 정확히 1, 다른 쪽이 0개 이상) |
| `\|\|--o\|` | 1 : 0..1 (1:1 — 옵셔널) |
| `}o--\|\|` | 0..N : 1 (반대 방향) |

## 카디널리티 요약

| 부모 → 자식 | 관계 |
|---|---|
| users → projects | 1:N |
| projects → sessions | 1:N |
| sessions → chunks | 1:N (30초 청크) |
| sessions → stt_sentences | 1:N (문장 단위 STT) |
| sessions → segments | 1:N (의미 구간) |
| sessions → video_analyses | 1:N (STEP 2 스마트 청크) |
| **sessions → voice_raws** | **1:1** |
| **sessions → session_summaries** | **1:1** |
| **segments → segment_analyses** | **1:1** |
| **segments → feedbacks** | **1:1** |
| segments ← session_summaries | 0..N (best/worst 참조) |

1:1 관계 테이블들은 부모 FK를 PK로 사용 (`PK_FK`로 표기).

---

## 미리보기 방법

| 환경 | 방법 |
|---|---|
| **GitHub** | 이 파일을 push만 하면 자동 렌더링됨 (마크다운 뷰어) |
| **VSCode** | `Markdown Preview Mermaid Support` 확장 |
| **Obsidian** | 기본 지원 |
| **Notion** | `/mermaid` 블록에 위 `erDiagram ... ` 부분만 붙여넣기 |
| **즉석 확인** | https://mermaid.live 에 코드 블록 내용 붙여넣기 → PNG/SVG export |
