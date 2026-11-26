# Design - 시스템 흐름

> 촬영부터 피드백·비교까지, **데이터가 어디서 만들어져 어느 테이블에 쌓이는지** 한눈에. 2026-11-27 기준.
> API 상세는 [Dev-API명세](Dev-API명세.md), 테이블은 [DB-erd](DB-erd.md).
> 모듈별 상세는 [Dev-STEP3](../_refs/Dev-STEP3.md) · [Dev-STEP4](../_refs/Dev-STEP4.md) · [Dev-비교분석](../_refs/Dev-비교분석.md) (로컬 전용).

---

## 1. 전체 그림

```
 ① 폴더·세션 ── ② 촬영/업로드 ── ③ 전처리 ── ④ 음성(STEP 3) ── ⑤ 구간 분리(STEP 4) ── ⑥ 동작(STEP 2) ── ⑦ 피드백(STEP 5)
                                  STEP 1                                                                        │
                                                                        ⑧ 회차 비교 ◀── 분석이 끝난 회차 두 개 ──┘
```

- **한 줄로 이어진 순서다** (2026-10-22 부터). 프론트 `frontend/src/utils/analysis.ts` 가 위 순서대로 API 를 부른다.
- 예전에는 동작(STEP 2)과 음성(STEP 3)을 병렬로 돌렸지만, 동작 분석을 **⑤ 가 나눈 구간에 맞춰 자르도록** 바꾸면서
  STEP 2 가 STEP 4 뒤로 왔다. 구간과 영상 조각 경계가 맞아야 구간별 피드백의 동작 근거가 정확해진다.
- STEP 번호는 기획 때 매긴 것이라 실행 순서와 다르다.

| 단계 | 실패하면 |
|---|---|
| ③ 전처리 · ④ 음성 · ⑤ 구간 분리 | **멈춘다** (뒤 단계의 입력이 없음) |
| ⑥ 동작 · ⑦ 구간별 피드백 · ⑦ 종합 피드백 | 경고만 남기고 다음으로 간다 (해당 칸만 빈다) |

모든 분석 단계는 실행할 때마다 `analysis_events` 에 한 줄씩 기록된다 (단계·성공/실패·모델·소요 시간) → 관리자 화면.

---

## 2. 단계별 상세

### ① 폴더·세션 만들기

| 호출 | 하는 일 | 테이블 |
|---|---|---|
| `POST /projects` | 폴더 생성 | `projects` **INSERT** |
| `POST /projects/{id}/sessions/start` | 세션 생성 + 회차 번호(`session_no` = 폴더 최대 + 1) + `uploads/{sid}/` | `sessions` **INSERT** `status='recording'` |

### ② 촬영 또는 영상 업로드 (브라우저)

**실시간 촬영** — 배경 블러(MediaPipe)·전면/후면 카메라 선택 가능

| 호출 | 하는 일 | 테이블 / 파일 |
|---|---|---|
| `POST /sessions/{id}/chunks?chunk_index=N` | 30초 webm 청크 (촬영 중 반복) | `chunks` **INSERT** · `chunks/chunk_NNN.webm` |
| `POST /sessions/{id}/video` | 전체 연속 영상 (Stop 시 1회) | `sessions.full_video_path` **UPDATE** · `full_video.webm` |
| `POST /sessions/{id}/video/rotate?quarter=N` | (필요할 때만) 방향 확인 카드에서 고른 만큼 회전 | `full_video.mp4` 로 교체 |

**영상 파일 업로드** — 청크 없이 `POST /sessions/{id}/video` 한 번 (mp4·mov·webm)

> 촬영은 청크와 전체 영상을 **둘 다** 올린다 (같은 내용을 두 번 전송). 오디오는 청크에서(③),
> 재생·동작 분석은 전체 영상에서(⑥) 쓴다.

### ③ 전처리 (STEP 1)

```
POST /sessions/{id}/end
   청크가 있으면   ffmpeg 청크별 wav 추출 → audio/chunk_NNN.wav → concat
   청크가 없으면   ffmpeg 전체 영상에서 바로 추출 (파일 업로드)
                  → full_audio.wav      ★ ④ 입력
   ffprobe        길이 측정
```
`sessions.status` **UPDATE** → `'preprocessed'`. 재분석도 여기서 다시 시작한다.

### ④ 음성 분석 (STEP 3)

```
POST /sessions/{id}/analyze/voice?keywords=클라우드,엣지컴퓨팅
   full_audio.wav
     ├ 3-1 VAD        무음 구간 (STT 무관, 단독 동작). 녹화 앞뒤 15초의 무음은 무시
     ├ 3-2 STT        문장 + 단어 시각   SeloWhisper (로컬 또는 Modal 서버리스 GPU)
     │                반복 환각(같은 문장 되풀이)은 잘라서 다시 인식
     ├ 3-3 필러       모델 태그 + 사전 + VAD∧¬STT(음향 검출)
     ├ 3-4 말 속도    음절/분 (무음 포함·제외)
     └ 3-5 반복       말더듬 (STT 단어 인접 비교)
```
`voice_raws` **DELETE + INSERT** · `stt_sentences` **DELETE + INSERT** · `sessions.status` → `'analyzed'`
· `analysis_events.detail` 에 세부 시간(무음 검출·GPU 대기·인식·필러)

- 임계값은 `app/pipeline/voice/config.py` 에서 읽는다 (개발 UI 에서 조정 가능).
- `keywords` 는 **발표에 실제로 나오는 고유명사만** — 무관한 단어는 인식을 악화시킨다.

### ⑤ 구간 분리 + 집계 (STEP 4)

```
POST /sessions/{id}/analyze/segments

stt_sentences ──▶ LLM(gpt-4.1)  "문장 번호로만 경계·라벨·제목 지정"
                      │
                      ▼
               segments  DELETE + INSERT       (시각은 stt_sentences 에서 채움)
                      │
   voice_raws  ───────┤
   stt_sentences ─────┼──▶ 구간 시간 범위로 잘라 담기
                      ▼
               segment_analyses  INSERT        (음성 칸: 필러·반복·무음·말 속도·전사문)
               session_summaries DELETE + INSERT (총 길이·구간 수·합계·평균)
```
`sessions.status` → `'segmented'`

- 라벨 9종: 도입 · 배경 · 핵심개념 · 문제제시 · 해결방안 · 사례 · 시연 · 결과 · 마무리 (회차 비교의 맞대기 기준)
- 새로 측정하지 않는다. **앞 단계 결과를 구간 범위로 집계할 뿐.**
- 재실행하면 `segments` 가 통째로 바뀌고 `segment_analyses`·`feedbacks` 도 CASCADE 로 지워진다 → ⑥·⑦ 도 다시 돌려야 한다.

### ⑥ 동작 분석 (STEP 2) — 구간 기준

```
POST /sessions/{id}/analyze/motion-by-segment
   ├ step2_segment_chunking   segments 시간 범위대로 full_video 자르기 (구간이 길면 최대 60초씩)
   │                          → ffmpeg 재인코딩 (vlm_chunks/)
   ├ step2_video_analysis     Gemini 동시 호출 (청크 수만큼)
   └ step4_aggregate          결과를 구간별로 다시 집계
```
`video_analyses` **DELETE + INSERT** (`kind='segment'`) · `segment_analyses` 영상 칸 **UPDATE**
(제스처·자세·시선 카운트, 긍정/부정 제스처 합계, `motion_notes`, `gesture_timelines`) · status 는 그대로 `'segmented'`

- 입력은 **업로드 청크가 아니라 `full_video`** 다.
- 예전 방식 `POST /analyze/motion`(스마트 청킹: 동작이 시작되는 시점부터 20초씩, `step2_chunking` + `motion_config`)은
  코드에 남아 있지만 프론트는 쓰지 않는다. 이 방식은 구간 집계를 채우지 않는다.

### ⑦ 피드백 (STEP 5)

```
POST /sessions/{id}/analyze/segment-feedback     구간마다 LLM 1회 (동시 최대 4개)
   입력: 발표 목차 + 그 구간의 전사문·지표 + 겹치는 영상 조각 + 무음·필러·반복
   코드가 먼저 판정: 구간 등급(문제 개수) · 말 문제 · 몸짓 문제(긍정 > 부정이면 가벼운 고칠 점)
   LLM 은 판정된 내용으로 문장만 씀 (근거 시각 M:SS 포함, 데이터에 없는 시각이면 다시 요청)
   → feedbacks  strengths · improvements · rating   UPSERT (일부 구간 실패해도 성공분은 저장)

POST /sessions/{id}/analyze/overall-feedback     LLM 1회
   코드가 먼저 판정: 습관 필러(같은 단어 반복) · headline 잘한 점/고칠 점 비중(구간 등급 기반)
   → session_summaries.llm_feedback  {headline, overall_summary}   UPDATE
```

### ⑧ 회차 비교

```
GET  /projects/{id}/compare?base=&target=        ① 지표 비교 + ② 같은 라벨 구간끼리 비교 — 저장 없이 계산
POST /projects/{id}/compare/feedback?base=&target=   ③ AI 비교 피드백 (gpt-4.1)
   → session_comparisons  INSERT/UPDATE  (①·② 스냅샷 + ③ + 두 회차의 분석 시각)
```
구간 분리(⑤)까지 끝난 회차만 고를 수 있다. 회차를 다시 분석하면 저장된 비교에 "다시 만들기" 표시가 뜬다.
폴더의 **종합 추이**(`GET /projects/{id}/trend`)도 같은 계산 함수로 회차별 지표를 모은다.

---

## 3. 데이터 흐름 — 파일

```
uploads/{session_id}/
├── chunks/chunk_NNN.webm      ② 촬영 중 스트리밍 업로드 (파일 업로드면 없음)
├── audio/chunk_NNN.wav        ③ 청크별 오디오
├── full_video.webm|mp4|mov    ② 전체 영상 (회전하면 full_video.mp4)  → ⑥ 입력, 재생·다운로드
├── full_audio.wav             ③ 결과                                 → ④ 입력
├── vlm_chunks/                ⑥ 구간 기준 청크 영상 (재분석 시 덮어씀)
└── vlm_analysis.json          ⑥ VLM 원본 응답
```

파일에 닿는 API 는 `GET /sessions/{id}/video`(재생 티켓 또는 토큰) 하나뿐이다. `uploads/` 는 정적 서빙하지 않는다.

---

## 4. 데이터 흐름 — 테이블

### 시점별 변화

| 시점 | INSERT | UPDATE |
|---|---|---|
| ① 세션 시작 | `projects` `sessions` | |
| ② 청크 업로드 | `chunks` | |
| ② 영상 업로드·회전 | | `sessions.full_video_path` |
| ③ `/end` | | `sessions.status='preprocessed'` |
| ④ `/analyze/voice` | `voice_raws` `stt_sentences` | `sessions.status='analyzed'` |
| ⑤ `/analyze/segments` | `segments` `segment_analyses` `session_summaries` | `sessions.status='segmented'` |
| ⑥ `/analyze/motion-by-segment` | `video_analyses` | `segment_analyses` 영상 칸 |
| ⑦ `/analyze/segment-feedback` | `feedbacks` | |
| ⑦ `/analyze/overall-feedback` | | `session_summaries.llm_feedback` |
| ⑧ `/compare/feedback` | `session_comparisons` | |
| ③~⑧ 모든 분석 호출 | `analysis_events` | 같은 행의 `status`·`finished_at` |

### 테이블 15개 — 만드는 단계

| 테이블 | 만드는 곳 | 담는 것 |
|---|---|---|
| `users` · `oauth_accounts` · `refresh_tokens` | 구글 로그인·토큰 갱신 | 회원·소셜 계정·refresh 토큰 jti |
| `projects` | ① | 폴더 (휴지통 `deleted_at`) |
| `sessions` | ① | 회차 · 상태 · 파일 경로 |
| `chunks` | ② | 30초 업로드 청크 (**전송 단위**) |
| `voice_raws` | ④ | 세션 전체 무음·필러·반복 배열 (1:1) |
| `stt_sentences` | ④ | 문장별 전사 + 시각 |
| `segments` | ⑤ | 구간 경계 + 라벨 + 제목 |
| `segment_analyses` | ⑤ 음성 칸, ⑥ 영상 칸 | 구간별 집계 (1:1) |
| `session_summaries` | ⑤ 지표, ⑦ 종합 피드백 | 세션 종합 (1:1) |
| `video_analyses` | ⑥ | 영상 조각별 동작 분석 |
| `feedbacks` | ⑦ | 구간별 잘한 점·개선점·등급 (1:1) |
| `session_comparisons` | ⑧ | 회차 쌍 AI 비교 피드백 + 스냅샷 |
| `analysis_events` | ③~⑧ | 단계 실행 기록 |

### ⚠️ "청크" 는 층마다 뜻이 다르다

| 층 | 뜻 | 단위 | 테이블 |
|---|---|---|---|
| 전송 | 스트리밍 업로드 | 30초 **고정** | `chunks` |
| 영상분석 | STEP 4 구간 | 구간 단위, **최대 60초** | `video_analyses` (`kind='segment'`) |
| 영상분석 (구) | 동작 구간 | **동적** 20초 | `video_analyses` (`kind='intro/motion/outro'`) |
| 음성분석 | (해당 없음) | 전체 오디오 하나 | — |

**규칙: 분석 결과 테이블은 "무엇을 분석했나"로 이름 짓고, 자른 단위는 `t_start`/`t_end` 컬럼이 표현한다.**
영상/음성이 각자 청킹 정책을 골라도 안 부딪힌다 — 실제로 스마트 청킹 → 구간 기준 청킹으로 바꿀 때 스키마 변경이 없었다.

---

## 5. `voice_raws` 의 세 배열은 같은 뼈대

```json
silence_segments  { "t_start", "t_end", "duration" }
filler_words      { "t_start", "t_end", "duration", "text", "source" }
repetitions       { "t_start", "t_end", "duration", "kind", "count", "text" }
```

덕분에 구간 집계가 **같은 코드 한 줄**로 처리된다.

```python
count = sum(1 for x in 배열 if seg.t_start <= x["t_start"] < seg.t_end)
```

같은 배열을 스크립트 화면(`GET /sessions/{id}/script`)도 그대로 쓴다 — 문장 위에 무음·필러·반복 표시.

---

## 6. 시각(타임스탬프)은 어디서 오는가

모든 지표가 시각 위에 서 있으므로 **출처를 분명히 해둔다.**

| 값 | 출처 | 신뢰도 |
|---|---|---|
| 무음 구간 | VAD 가 파형에서 직접 | 높음 |
| 단어·문장 시각 | STT 토큰 시각 (Whisper cross-attention 정렬) | ±100~200ms |
| 필러·반복 위치 | 위 단어 시각 기반 (음향 검출 필러는 파형 기준) | 단어 시각에 종속 |
| **구간 경계** | **`stt_sentences` 에서 그대로 복사** | 문장 시각과 동일 |
| 영상 조각 범위 | 구간 경계에서 잘라 정함 | 구간 경계와 동일 |
| 제스처 발생 시각 (`gesture_timelines`) | **VLM 이 조각 안 시각("MM:SS")을 답함** → 조각 시작 시각을 더해 전체 기준으로 변환 | VLM 추정 — 초 단위 오차 가능 |
| 피드백 문장 속 시각 | ⑦ LLM 이 입력 데이터에서 인용 | 데이터에 없는 시각이면 다시 요청 (최대 3회) |

- **STEP 4 LLM 은 시각을 만들지 않는다.** 문장 *번호* 만 주고받는다.
- LLM/VLM 이 직접 내는 시각은 제스처 시각 하나뿐이고, 피드백 문장의 시각은 검증을 거친다.

---

## 7. 세션 상태와 재분석

```
recording ──③──▶ preprocessed ──④──▶ analyzed ──⑤──▶ segmented   (⑥·⑦ 은 status 를 바꾸지 않음)
```

- 단계를 한 줄로 이어 부르게 되면서, 예전의 "STEP 2·3 이 같은 `analyzed` 를 써서 어느 쪽이 끝났는지 모른다" 문제는 사라졌다.
- `/analyze/voice` 는 `preprocessed`·`analyzed` 에서만 받으므로, **다시 분석하려면 `/end` 부터** 부른다.
- 대시보드의 "다시 분석하기"는 결과가 빠진 단계만 골라 다시 부른다 (분석 비용 절약).
- 분석 진행률 API 는 없다. 전부 **동기 호출**이라 프론트가 단계마다 진행 문구를 띄우고,
  배포 서버의 Caddy 는 응답을 20분까지 기다린다.

---

## 8. 실행

```bash
# 본 API 서버
uvicorn app.main:app --reload --port 8000

# 개발 테스트 서버 (STEP 2 /vlm · STEP 3·4 /voice)
uvicorn devtools.server:app --reload --port 8001
```

> 테스트 서버는 **DB 를 건드리지 않는다.** 결과는 `work/<job_id>/` 파일로만 남는다.
> DB 에 들어가는 것은 본 API(`:8000`)를 탈 때뿐이다. 자세한 명령어는 `docs/CLAUDE.md` "자주 쓰는 명령어".
