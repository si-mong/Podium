# Design - 시스템 흐름

> 촬영부터 피드백까지, **데이터가 어디서 만들어져 어느 테이블에 쌓이는지** 한눈에.
> 모듈별 상세는 [Dev-STEP3](Dev-STEP3.md) · [Dev-STEP4](Dev-STEP4.md) · `_refs/Step1-smart chuncking.md`.

---

## 1. 전체 그림

```
 ① 촬영 준비 ─── ② 촬영 ─── ③ 전처리 ─┬─ ④ 영상분석(STEP 2) ─┐
                                      │                      ├─ ⑥ 구간분리(STEP 4) ─ ⑦ 피드백(STEP 5)
                                      └─ ⑤ 음성분석(STEP 3) ─┘
```

**④ 와 ⑤ 는 서로 의존하지 않는다** — 순서 무관, 동시 실행 가능.
**⑥ 은 둘 다 끝나야** 시작할 수 있다(양쪽 결과를 구간별로 집계하므로).

---

## 2. 단계별 상세

### ① 촬영 준비

| 호출 | 하는 일 | 테이블 |
|---|---|---|
| `POST /projects` | 프로젝트 생성 | `projects` **INSERT** |
| `POST /projects/{id}/sessions/start` | 세션 생성 + `uploads/{sid}/` 디렉터리 | `sessions` **INSERT** `status='recording'` |

### ② 촬영 (브라우저)

| 호출 | 하는 일 | 테이블 / 파일 |
|---|---|---|
| `POST /sessions/{id}/chunks?chunk_index=N` | 30초 webm 청크 (촬영 중 반복) | `chunks` **INSERT** · `chunks/chunk_NNN.webm` |
| `POST /sessions/{id}/video` | 전체 연속 영상 (Stop 시 1회) | `sessions.full_video_path` **UPDATE** · `full_video.webm` |

> ⚠️ 같은 영상을 두 번 녹화·업로드하는 중복 구조. → `_refs/Todo-회의필요.md` 2번

### ③ 전처리 (STEP 1)

```
POST /sessions/{id}/end
   ├ ffmpeg   청크별 wav 추출        → audio/chunk_NNN.wav
   ├ ffmpeg   concat                → full_audio.wav      ★ STEP 3 입력
   └ ffprobe  길이 측정
```
`sessions.status` **UPDATE** → `'preprocessed'`

### ④ 영상분석 (STEP 2)

```
POST /sessions/{id}/analyze/motion
   ├ step2_chunking          full_video → motion 시계열 → 스마트 청크 계획
   │                          → ffmpeg 로 청크 추출 (vlm_chunks/)
   └ step2_video_analysis    Gemini 병렬 호출 (청크별)
```
`video_analyses` **DELETE + INSERT** · `sessions.status` → `'analyzed'`

- 입력이 **업로드 청크가 아니라 `full_video`** 다. 스마트 청킹은 동작이 시작되는
  임의 시점부터 자르므로 30초 격자에 갇히면 안 된다.
- 임계값은 `app/pipeline/motion_config.py` 에서 읽는다 (개발 UI 에서 조정 가능).

### ⑤ 음성분석 (STEP 3)

```
POST /sessions/{id}/analyze/voice?keywords=ETRI,포항공대
   full_audio.wav
     ├ 3-1 VAD        무음 구간          (STT 무관, 단독 동작)
     ├ 3-2 STT        문장 + 단어 시각    SeloWhisper
     ├ 3-3 필러       모델 태그 + 사전 + VAD∧¬STT
     ├ 3-4 발화속도    음절/분 (무음 포함·제외)
     └ 3-5 반복       말더듬 (STT 단어 인접 비교)
```
`voice_raws` **DELETE + INSERT** · `stt_sentences` **DELETE + INSERT** ·
`sessions.status` → `'analyzed'`

- 임계값은 `app/pipeline/voice/config.py` 에서 읽는다 (개발 UI 에서 조정 가능).
- `keywords` 는 **발표에 실제로 나오는 고유명사만** — 무관한 단어는 인식을 악화시킨다.

### ⑥ 구간분리 (STEP 4) — 라우터 미구현

```
stt_sentences ──▶ LLM(Gemini)  "문장 번호로만 경계 지정"
                      │
                      ▼
               segments  INSERT      (시각은 stt_sentences 에서 채움)
                      │
   voice_raws  ───────┤
   video_analyses ────┼──▶ 구간 시간 범위로 잘라 담기
   stt_sentences ─────┘
                      ▼
               segment_analyses  INSERT
```

새로 측정하지 않는다. **앞 단계 결과를 구간 범위로 집계할 뿐.**

### ⑦ 종합 피드백 (STEP 5) — 미구현

`segment_analyses` + `video_analyses` → LLM → `feedbacks` · `session_summaries`

---

## 3. 데이터 흐름 — 파일

```
uploads/{session_id}/
├── chunks/chunk_NNN.webm      ② 촬영 중 스트리밍 업로드
├── audio/chunk_NNN.wav        ③ 청크별 오디오
├── full_video.webm            ② Stop 시 업로드      → ④ 입력
├── full_audio.wav             ③ concat 결과         → ⑤ 입력
└── vlm_chunks/chunk_NNN.mp4   ④ 스마트 청크
```

---

## 4. 데이터 흐름 — 테이블

### 시점별 변화

| 시점 | INSERT | UPDATE |
|---|---|---|
| ① 세션 시작 | `projects` `sessions` | |
| ② 청크 업로드 | `chunks` | |
| ② 영상 업로드 | | `sessions.full_video_path` |
| ③ `/end` | | `sessions.status='preprocessed'` |
| ④ `/analyze/motion` | `video_analyses` | `sessions.status='analyzed'` |
| ⑤ `/analyze/voice` | `voice_raws` `stt_sentences` | `sessions.status='analyzed'` |
| ⑥ STEP 4 | `segments` `segment_analyses` | |
| ⑦ STEP 5 | `feedbacks` `session_summaries` | |

### 테이블 11개 요약

| 테이블 | 만드는 단계 | 담는 것 |
|---|---|---|
| `users` | — | 사용자 (현재 더미) |
| `projects` | ① | 프로젝트 |
| `sessions` | ① | 촬영 세션 · 상태 · 파일 경로 |
| `chunks` | ② | 30초 업로드 청크 (**전송 단위**) |
| `video_analyses` | ④ | 스마트 청크별 동작 분석 (**동적 단위**) |
| `voice_raws` | ⑤ | 세션 전체 음성 지표 (1:1) |
| `stt_sentences` | ⑤ | 문장별 전사 + 시각 |
| `segments` | ⑥ | 구간 경계 + 라벨 |
| `segment_analyses` | ⑥ | 구간별 집계 (1:1) |
| `feedbacks` | ⑦ | 구간별 점수·코멘트 (1:1) |
| `session_summaries` | ⑦ | 세션 종합 (1:1) |

### ⚠️ "청크" 는 층마다 뜻이 다르다

| 층 | 뜻 | 단위 | 테이블 |
|---|---|---|---|
| 전송 | 스트리밍 업로드 | 30초 **고정** | `chunks` |
| 영상분석 | 동작 구간 | **동적** 20초 | `video_analyses` |
| 음성분석 | (해당 없음) | 전체 오디오 하나 | — |

**규칙: 분석 결과 테이블은 "무엇을 분석했나"로 이름 짓고, 자른 단위는
`t_start`/`t_end` 컬럼이 표현한다.** 영상/음성이 각자 청킹 정책을 골라도 안 부딪힌다.

---

## 5. `voice_raws` 의 세 배열은 같은 뼈대

```json
silence_segments  { "t_start", "t_end", "duration" }
filler_words      { "t_start", "t_end", "duration", "text", "source" }
repetitions       { "t_start", "t_end", "duration", "kind", "count", "text" }
```

덕분에 STEP 4 집계가 **같은 코드 한 줄**로 처리된다.

```python
count = sum(1 for x in 배열 if seg.t_start <= x["t_start"] < seg.t_end)
```

---

## 6. 시각(타임스탬프)은 어디서 오는가

모든 지표가 시각 위에 서 있으므로 **출처를 분명히 해둔다.**

| 값 | 출처 | 신뢰도 |
|---|---|---|
| 무음 구간 | VAD 가 파형에서 직접 | 높음 |
| 단어·문장 시각 | Whisper cross-attention 정렬 | ±100~200ms |
| 필러 위치 | 위 단어 시각 기반 | 단어 시각에 종속 |
| 반복 위치 | 위 단어 시각 기반 | 단어 시각에 종속 |
| **구간 경계** | **`stt_sentences` 에서 그대로 복사** | 문장 시각과 동일 |

**LLM 이 시각을 만들어내는 경로는 없다.** STEP 4 는 문장 *번호* 만 주고받는다.

---

## 7. 현재 구현 상태

| 단계 | 상태 |
|---|---|
| ① 촬영 준비 | ✅ |
| ② 촬영·업로드 | ✅ (중복 구조 정리 필요 → Todo 2번) |
| ③ 전처리 (STEP 1) | ✅ |
| ④ 영상분석 (STEP 2) | ✅ |
| ⑤ 음성분석 (STEP 3) | ✅ end-to-end 검증 완료 |
| ⑥ 구간분리 (STEP 4) | 🟡 모듈·테스트 UI 완료 / **저장 라우터 미구현** |
| ⑦ 종합 피드백 (STEP 5) | ❌ 미착수 |

### ⚠️ `status` 가 STEP 2 / STEP 3 을 구분하지 못한다

④ 와 ⑤ 둘 다 끝나면 `'analyzed'` 로 바꾸는데, **먼저 끝난 쪽이 혼자 `analyzed`** 로
만들어 버린다. ⑥ 은 둘 다 끝나야 시작할 수 있으므로 상태만으로는 판단이 안 된다.
동시 실행 시 같은 컬럼을 양쪽이 쓰는 문제도 있다.

→ `sessions` 에 `motion_analyzed_at` / `voice_analyzed_at` 을 두거나 상태를 분리해야 한다.
지금은 수동으로 순서를 지키면 되지만, 프론트 진행 표시나 STEP 4 자동 트리거를 붙이려면
정리가 필요하다.

---

## 8. 실행

```bash
# 본 API 서버
uvicorn app.main:app --reload --port 8000

# 개발 테스트 서버 (STEP 2 /vlm · STEP 3·4 /voice)
uvicorn devtools.server:app --reload --port 8001
```

> 테스트 서버는 **DB 를 건드리지 않는다.** 결과는 `work/<job_id>/` 파일로만 남는다.
> DB 에 들어가는 것은 본 API(`:8000`)를 탈 때뿐이다.
