# 비교 분석 설계

대상 사용사례: UC-008(두 세션 비교 분석), UC-009(비교 결과 목록 조회), UC-010(통합 분석 조회)

---

## 1. 개요

비교는 세 층으로 나눈다. 아래로 갈수록 구현이 어렵고 사용자 가치가 크다.

| 층 | 내용 | LLM | 저장 |
|---|---|---|---|
| ① 세션 지표 비교 | 회차 전체 수치 비교 | ❌ | ❌ (즉시 계산) |
| ② 구간 정렬 비교 | 같은 성격의 구간끼리 맞대어 비교 | ❌ | ❌ (즉시 계산) |
| ③ 피드백 이행 추적 | 이전 회차 개선점이 해결됐는지 판정 | ✅ | ✅ `session_comparisons` |

기본 비교 대상은 **직전 회차 vs 이번 회차**. 사용자가 다른 회차를 고를 수 있다.

---

## 2. ① 세션 지표 비교

`session_summaries` + `segment_analyses` 집계만으로 계산한다.

| 지표 | 원천 | 비교 방식 |
|---|---|---|
| 필러 | `total_filler_count` | **분당 횟수**로 정규화. 낮을수록 개선 |
| 반복(말더듬) | `total_repetition_count` | 분당 횟수. 낮을수록 개선 |
| 발화 속도 | `avg_speaking_rate_spm`, `avg_articulation_rate_spm` | 단조 지표 아님. **목표 구간(예: 250~350 SPM)과의 거리**로 판정 |
| 무음 비율 | `segment_analyses.silence_ratio` | 시간 가중 평균 |
| 제스처 | `positive_gesture_count`, `negative_gesture_count` | 분당 횟수. 부정은 낮을수록 개선 |
| 시선·자세 | `eye_contact_counts`, `posture_counts` | 횟수 대신 **비율 분포(%)** 로 비교 |
| 구간 점수 | `feedbacks.score_*` | 평균 |
| 발표 길이 | `total_duration` | 참고용 (판정 없음) |

- 회차마다 발표 길이가 다르므로 **횟수 지표는 반드시 분당으로 정규화**한다.
- **노이즈 기준**: 지표별 허용폭(±N%) 안의 변화는 "유지"로 표시한다. 3.1 → 3.0 을 "개선"이라 하면 신뢰가 떨어진다.
- 판정 결과: `improved` / `same` / `worse`. 지표별 방향(낮을수록 좋음, 목표 구간)은 코드 상수로 둔다.

---

## 3. ② 구간 정렬 비교

회차마다 구간 수와 경계가 다르므로 순번(1번 구간끼리) 비교는 의미가 없다.

### 정렬 기준
1. **`slide_index`** — PDF 가 있으면 우선 사용. 가장 정확하다.
2. **`label`** — PDF 가 없을 때. `step4_segmentation.LABELS` 6종.

### label 정렬 방식
| 방식 | 설명 | 장단점 |
|---|---|---|
| A. label 합산 | 같은 label 구간을 묶어 집계 | 단순. 순서 변화는 못 잡음 |
| B. LCS 정렬 | 두 회차의 label 시퀀스를 최장 공통 부분수열로 매칭 | 순서 변경, 누락 구간 탐지 가능 ("2회차엔 '결과' 구간이 빠졌다") |

→ **A 로 시작, 여유 있으면 B**.

출력 예: `문제제시: 48초 → 1분 12초, 필러 4.0 → 2.0 회/분`

### 화면
두 회차의 타임라인을 위아래로 놓고, 매칭된 구간끼리 선으로 잇는다. 구간 클릭 시 두 영상을 해당 위치에서 나란히 재생한다.

---

## 4. ③ 피드백 이행 추적

이전 회차의 `feedbacks.improvements`, `llm_feedback.improvements`(근거 시각 포함)를 이번 회차 지표와 함께 LLM 에 넣고, 항목별로 판정한다.

| 판정 | 의미 |
|---|---|
| `resolved` | 해결됨 |
| `persists` | 여전함 |
| `new` | 이번 회차에 새로 생김 |

예: `지난 지적 "결과 구간에서 머리를 자주 만짐" → touching_face 6회 → 1회, resolved`

- **수치는 ①·② 에서 계산해 넣고 LLM 은 해석만 한다.** 수치 환각 방지.
- 출력은 JSON 스키마 고정 (항목 목록 + 총평).
- 실행은 기존 분석과 같은 백그라운드 방식. `analysis_events` 에 `step="comparison"` 으로 기록 → 관리자 화면 재사용.

---

## 5. 데이터 모델

①·② 는 즉시 계산, ③ 만 저장한다. UC-009(비교 목록)는 이 테이블이 근거다.

```
session_comparisons
  comparison_id       bigserial   pk
  project_id          bigint      fk → projects (CASCADE)
  base_session_id     bigint      fk → sessions (SET NULL)   -- 이전 회차
  target_session_id   bigint      fk → sessions (SET NULL)   -- 이번 회차
  metrics_diff        jsonb       -- ① 결과 스냅샷
  segment_alignment   jsonb       -- ② 매칭 결과 스냅샷
  llm_feedback        jsonb       -- ③ 이행 판정 + 총평
  base_analyzed_at    timestamptz -- 캐시 무효화용 (§7)
  target_analyzed_at  timestamptz
  status              varchar(16) -- processing / done / error
  created_at          timestamptz

  unique (base_session_id, target_session_id)
```

①·② 를 스냅샷으로 같이 저장하는 이유: 세션이 삭제되거나 재분석돼도 당시 비교 결과를 목록에서 그대로 볼 수 있게.

---

## 6. API

| 메서드 | 경로 | 내용 | UC |
|---|---|---|---|
| GET | `/projects/{id}/compare?base=&target=` | ①+② 즉시 계산 (저장 안 함) | 008 |
| POST | `/comparisons` | ③ 생성 요청 → 백그라운드 실행, 저장 | 008 |
| GET | `/projects/{id}/comparisons` | 비교 결과 목록 | 009 |
| GET | `/comparisons/{id}` | 비교 결과 상세 | 009 |
| GET | `/projects/{id}/trend` | 전 회차 ① 지표 시계열 | 010 |

- 두 세션은 **같은 프로젝트 소속 + status=done** 이어야 한다. 아니면 `400`.
- trend 는 ① 계산 함수를 회차마다 돌리는 것뿐이라 ① 구현 시 거의 같이 끝난다.

---

## 7. 주의사항

### 비교 공정성
회차마다 분석 모델·임계값이 다르면 수치 변화가 실력 변화인지 설정 변화인지 구분할 수 없다
([Dev-STEP3](Dev-STEP3.md), [DB변경사항](DB변경사항.md) 의 `analysis_config` 보류 건).

- 최소안: 두 세션의 `analysis_events.model` 을 단계별로 비교해 다르면 경고 표시
  ("분석 설정이 달라 정확한 비교가 어렵다")
- 장기안: 세션에 `analysis_config`(모델·임계값) 저장

### 캐시 무효화
세션을 재분석하면 저장된 비교 결과가 낡는다. 생성 시 두 세션의 마지막 분석 완료 시각을
`base_analyzed_at` / `target_analyzed_at` 에 저장하고, 현재 값과 다르면 "다시 생성" 버튼을 띄운다.

---

## 8. 화면 구성

1. **상단** — 지표 카드. 값 + 변화량(▲▼) + 판정 색
2. **중간** — 정렬된 구간 타임라인 (§3)
3. **하단** — 지난 피드백 이행 체크리스트 (§4)
4. 프로젝트 화면 — 회차별 지표 꺾은선 (trend)

---

## 9. 구현 순서

1. ① 지표 비교 + trend API — LLM 없음. UC-010 해결
2. ② label 합산 정렬 (LCS 는 후순위)
3. ③ 이행 추적 + `session_comparisons` — UC-008·009 완성
4. 프론트: 비교 화면, 회차 선택 (기본값 직전 회차)
5. 공정성 경고, 캐시 무효화
