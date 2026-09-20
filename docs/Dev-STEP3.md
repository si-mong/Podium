# Dev - STEP 3 음성분석

> STEP 3 모듈의 구조·저장 형식·설정 레퍼런스.
> 날짜별 작업 기록은 `_refs/flow-작업흐름.md`, 팀원 전달 요약은 `_refs/0915 변경 사항.md`.

---

## 1. 한눈에

```
full_audio.wav  (STEP 1 산출물)
   │
   ├─ 3-1  VAD        무음 구간         Silero VAD — STT 무관, 단독 동작
   ├─ 3-2  STT        문장 + 단어 시각   SeloWhisper (transformers)
   ├─ 3-3  필러       모델 태그 + 사전 + VAD∧¬STT 차집합
   ├─ 3-4  발화속도    음절/분 (무음 포함·제외 2종)
   └─ 3-5  반복       말더듬 — STT 단어 목록에서 인접 비교
        ↓
   voice_raws · stt_sentences
```

진입점은 **`app/pipeline/step3_voice_analysis.py`** 하나.

```python
result = step3_voice_analysis.run(wav_path, keywords="ETRI, 포항공대")
rows   = step3_voice_analysis.to_db_rows(session_id, result)   # 테이블별 행으로 분해
```

API: `POST /sessions/{id}/analyze/voice?keywords=...`
STEP 2 와 **서로 의존하지 않으므로 순서 무관 · 동시 실행 가능.**

---

## 2. 모듈 구성

```
app/pipeline/
├── step3_voice_analysis.py   진입점 (run / to_db_rows)
├── motion_config.py          STEP 2 임계값 저장소
└── voice/                    코어 — 본 파이프라인과 개발 도구가 공유
    ├── audio.py      오디오 로딩 + RMS + F0 (순수 numpy, librosa 안 씀)
    ├── vad.py        3-1 무음
    ├── stt.py        3-2 STT 라우팅 (`hf:` 면 transformers, 아니면 faster-whisper)
    ├── stt_hf.py     3-2 transformers 백엔드 (비유창성 태그 모델용)
    ├── filler.py     3-3 필러
    ├── stutter.py    3-5 반복
    ├── analyze.py    오케스트레이션
    └── config.py     임계값 저장소
```

개발 도구(`stt_test/`)는 이 코어를 쓰는 **클라이언트**다. 반대가 아니다.

---

## 3. DB 저장 형식 ★

### `voice_raws` — 세션당 1행

세 배열이 **같은 뼈대**(`t_start` / `t_end` / `duration` + 부가 필드)를 가진다.
덕분에 STEP 4 구간 집계를 같은 코드로 처리할 수 있다.

```python
count = sum(1 for x in 배열 if seg.t_start <= x["t_start"] < seg.t_end)
```

**`silence_segments`**
```json
{ "t_start": 3.712, "t_end": 4.576, "duration": 0.864 }
```

**`filler_words`**
```json
{ "t_start": 4.84, "t_end": 6.28, "duration": 1.44,
  "text": "그래서", "source": "lexical" }
```
| 필드 | 값 |
|---|---|
| `text` | 인식된 어휘. 모델 태그면 `"<um>"`, 음향 검출이면 `null` |
| `source` | `lexical`(모델 태그 또는 사전 매칭) / `acoustic`(VAD∧¬STT) |

**`repetitions`** — 말더듬
```json
{ "t_start": 12.44, "t_end": 13.16, "duration": 0.72,
  "kind": "exact", "count": 3, "text": "제 제 제가" }
```
| 필드 | 값 |
|---|---|
| `count` | 반복 횟수 (3 = 세 번) |
| `kind` | `exact`(같은 말) / `stem`(앞부분만 — **신뢰도 낮음**) |
| `text` | **평문.** `<repeat>` 태그는 저장하지 않음 |

### `stt_sentences` — 문장당 1행

```
12.44-15.42  제 제 제가 이 부분을 맡았습니다.
```

**비유창성 태그가 제거된 평문이 저장된다.** 이유:
- 인터랙티브 스크립트로 사용자에게 그대로 노출되므로 `<repeat>` 이 섞이면 안 됨
- STEP 5 LLM 입력에도 방해가 됨
- 태그 위치는 이미 `filler_words` / `repetitions` 에 **시각과 함께 구조화**돼 있어 정보 손실이 없음

태그 포함본이 필요하면 `diagnostics.tagged_text` 에 있다(DB 저장 대상 아님).
개발 도구는 이걸 읽어 태그를 보라색 배지로 표시한다.

### 집계 대상 (STEP 4 이후 채워짐)

`segment_analyses` — `silence_count` / `filler_count` / `repetition_count` /
`speaking_rate_spm` / `articulation_rate_spm` / `stt_text`
`session_summaries` — `total_filler_count` / `total_repetition_count` /
`avg_speaking_rate_spm` / `avg_articulation_rate_spm`

---

## 4. 타임스탬프

**SeloWhisper 는 단어 단위 시각을 준다. 비유창성 태그도 각자 시각을 가진다.**

```
12.44-12.56  «제»
12.56-12.66  «<repeat>»
```

`generate(..., return_token_timestamps=True)` 로 토큰별 시각을 받아 단어로 묶는다.
모델 `generation_config` 에 **`alignment_heads` 가 있어야** 동작한다 — 없으면
transformers 경로 자체가 성립하지 않는다.

우리 지표(무음 매칭·필러 위치·STEP 4 구간 집계)가 전부 시각 위에 서 있어서
**단어 타임스탬프가 없으면 파이프라인이 성립하지 않는다.** LLM 방식을 택하지
않은 결정적 이유이기도 하다.

### ⚠️ 구현 시 주의 (겪은 버그)

| 증상 | 원인 | 해결 |
|---|---|---|
| 한글 깨짐 (`안���하세요`) | 토큰을 하나씩 `decode` — byte-level BPE 라 한 글자가 여러 토큰에 걸침 | 경계는 토큰 문자열(`Ġ`)로 찾되 **디코딩은 단어 단위로 묶어서** |
| 허위 필러 대량 발생 | `token_timestamps` 는 토큰 **시작** 시각. 마지막 토큰 시각을 단어 끝으로 쓰면 1토큰 단어 길이가 0 → 가짜 틈 | 단어 끝 = **다음 토큰의 시각** |

---

## 5. STT 모델

`.env` 의 `WHISPER_MODEL` 로 지정. 확정값:

```
WHISPER_MODEL=hf:rearleg/SeloWhisper-ko-disfluency
```

- `hf:` 접두사 → **transformers** 런타임 (`stt_hf.py`)
- 접두사 없음 → **faster-whisper**(CTranslate2). `small`, `large-v3-turbo`, 로컬 CT2 경로 등

### SeloWhisper 를 CT2 로 못 쓰는 이유

비유창성 토큰 id 가 **51866~51875** 인데 faster-whisper 의 타임스탬프 토큰 영역이
**50365~51865** 다. 바로 뒤에 얹혀서:
- `eot`(50257)보다 크므로 특수 토큰으로 간주 → 태그 **소실**
- `timestamp_begin` 보다 크므로 **타임스탬프로 오해** → 세그먼트 조기 종료 → **전사 잘림**

손실이 아니라 **손상**이다. vocab 을 확장한 파인튜닝 모델 전반에 해당한다.
`stt.py` 가 `vocabulary.json` 크기를 보고 확장 토큰을 **자동 억제**하므로
CT2 로도 돌릴 수는 있다(태그는 포기, 평문 전사는 정상).

### ⚠️ `repetition_penalty` 를 쓰지 말 것

할루시네이션(`네. 네. 네…` 25회 연속)을 막으려 넣었다가 **진짜 말더듬까지 억눌렀다**
(`제 제 제가` → `제제 제가`, 반복 검출 3→2건). `no_repeat_ngram_size=4` 만 쓰면
4-gram 단위만 막아 짧은 말더듬은 통과시키면서 루프는 끊는다.

---

## 6. 임계값 설정

`app/pipeline/voice/config.py` 가 단일 저장소. **개발 도구에서 맞춘 값이
본 파이프라인에 그대로 적용된다.**

```
코드 기본값 → thresholds.json(UI 저장) → 분석 시 적용
```

| 키 | 기본값 | 걸러내는 것 | 기각 라벨 |
|---|---|---|---|
| `min_silence_sec` | 0.7 | — (무음 최소 길이) | — |
| `min_candidate_sec` | 0.10 | timestamp 오차로 생긴 가짜 틈 | `too_short` |
| `max_candidate_sec` | 3.0 | STT 가 놓친 발화, 긴 잡음 | `too_long` |
| `min_relative_db` | -18.0 | 숨소리·입소리·주변 소음 | `too_quiet` |
| `min_voiced_ratio` | 0.45 | 마찰음성 잡음 | `unvoiced` |
| `max_f0_std_semitone` | 3.5 | 음높이가 크게 움직이는 구간 | `pitch_moves` |

UI: `/voice/` 상단 **[임계값 변경]**

### ⚠️ 임계값에 대한 경고

**5개 전부 아직 추정치다.** 실제 녹음 라벨링 후 `python -m stt_test eval <out_dir>`
스윕으로 확정해야 한다. 지금까지 감으로 잡은 값이 **세 번 연속 측정으로 반증**됐다:

| 상수 | 초기값 | 문제 |
|---|---|---|
| `MIN_SILENCE_SEC` | 0.7 | 문장 사이 정상 호흡까지 무음으로 집계 |
| `MIN_CANDIDATE_SEC` | 0.20 | `WORD_PAD_SEC`(0.12×2)와 겹쳐 실질 0.44초 기준 → 짧은 필러 검출 불가 |
| `MAX_F0_STD_SEMITONE` | 1.5 | "필러는 F0 가 평탄하다" 가설이 반증돼 recall 0.00 |

→ **임계값은 코드에 박기 전에 UI 슬라이더로 빼고, 실측 분포를 본 뒤 확정한다.**

회차 비교 시 설정이 다르면 수치 변화가 실력 변화인지 설정 변화인지 구분되지 않는다.
(`voice_raws.analysis_config` 컬럼으로 기록하는 안은 보류 중 — [DB변경사항](DB변경사항.md))

---

## 7. 검출 방식 요약

### 3-1 무음 — STT 를 쓰지 않는다
신호처리 문제이고, STT 세그먼트 시각은 디코더가 만든 근사치라 경계가 뭉개진다.
faster-whisper 에 번들된 Silero VAD(ONNX)를 파형에 직접 적용한다.

**VAD 파라미터는 라이브러리 기본값을 쓰면 안 된다** (Whisper 입력 덩어리용 튜닝값):

| 파라미터 | 기본값 | 우리 값 | 그대로 쓰면 |
|---|---|---|---|
| `speech_pad_ms` | 400 | **0** | 발화가 앞뒤로 부풀어 무음이 0.8초 짧아지고 3-3 차집합에 가짜 구간 발생 |
| `min_silence_duration_ms` | 2000 | **100** | 2초 미만 침묵을 발화로 흡수 → 세려는 멈춤이 사라짐 |

STT 호출 시 **`vad_filter=False` 필수** — 내장 VAD 가 비어휘 발성을 잘라내면 3-3 이 무너진다.

### 3-3 필러 — 세 경로
1. **모델 태그** (`<um>`/`<uh>`/`<gue>` …) — 문맥 판단이라 길이 조건 없이 인정
2. **사전 매칭** — `FILLER_STRONG`(무조건) / `FILLER_WEAK`(0.35초 이상 늘어졌을 때만)
3. **음향 경로** (VAD∧¬STT 차집합 + 음향 필터) — ⚠️ **보류 상태**

음향 경로는 "필러는 F0 가 평탄하다"는 가설로 만들었으나 측정에서 반증됐다
(필러 2.87~3.82 반음 vs 일반 발화 0.62~3.76 반음, 분포 완전 중첩).
관문 자체는 오검출을 줄이므로 유지하되, **주력은 1·2번이다.**

모델 태그가 만능은 아니다. 실제 강의 녹음(470어절)에서 태그 31개가 붙었지만
화자가 11회 쓴 `인제` 는 하나도 잡지 못했다 → 사전 매칭이 이를 보완한다.

### 3-5 반복 — 텍스트만 사용
STT 단어 timestamp 위에서 인접 토큰을 비교할 뿐, STT 재실행·새 모델·음향 분석이 없다.

만들기 전 **"이 신호가 STT 를 통과하는가" 부터 검증**했다 (3-3 실패의 교훈):

| 유형 | 결과 |
|---|---|
| 어절 반복 "그래서 그래서 그래서" | ✅ 보존 |
| 음절 반복 "제 제 제가" | ✅ 보존 |
| 첫음절 반복 "그 그 그러니까" | ✅ 보존 |
| 연장 "그으으래서" | ❌ "그을에서" 로 뭉개짐 → **범위 밖** |
| 자기수정 "저는 아니 저희는" | ⚠️ 인접 비교로는 안 잡힘 → 2순위 |

오검출 방지 규칙:
- 순수 필러(`음`/`어`)는 제외 (3-3 이 이미 셈) — 단 `FILLER_WEAK`(`그`,`그래서`)는
  **제외하지 않는다.** 약한 필러의 *반복* 은 길이와 무관하게 말더듬이다
- `정말 정말`, `점점` 등 강조 표현 allowlist
- `stem` 은 간격 상한 0.35초 — `이 이야기`, `그 그림` 같은 정상 관형사+명사와 겹치기 때문.
  완전히 갈리지 않으므로 **신뢰도 낮음으로 구분 표시**한다

### 3-4 발화속도 — WPM 이 아니라 SPM
한국어는 어절 수가 띄어쓰기 정책에 따라 흔들려 WPM 이 불안정하다. 음절 기준이 안정적이다.
무음 포함(`speaking_rate_spm`) / 제외(`articulation_rate_spm`)를 나눠야
*"말은 빠른데 자주 멈춘다"* 같은 진단이 가능하다.

---

## 8. hotwords (발표 주제 키워드)

`keywords` 인자 → `hotwords` 파라미터. 해당 어휘의 인식률이 올라간다.

**`initial_prompt` 와 다르다:**

| | `initial_prompt` | `hotwords` |
|---|---|---|
| 목적 | 문체 유도 | 어휘 편향 |
| **적용 범위** | **첫 30초 윈도우만** | **모든 윈도우** |

`condition_on_previous_text=False`(우리 설정) 때문에 `initial_prompt` 는 윈도우마다
리셋된다. 긴 발표의 도메인 용어에는 `hotwords` 가 맞는 도구다.

### ⚠️ 이미 맞히는 단어는 넣지 말 것

실측:
```
"네트워크, 통신, 블루투스" (이미 잘 인식되는 일반명사)
  → 등장 횟수 변화 없음. 전사문 68곳 변경, 여러 곳 악화
     (4월→4호, 과제를→과재료의, 몇 군데→몇분대, "제가" 삭제)

"ETRI, 포항공대, SK텔레콤, 5G, 6G" (실제로 틀리던 고유명사)
  → 애트리 3회→0회 / ETRI 0회→3회, 포항군대→포항공대, SK텔의 꿈→SK텔레콤
```

넣을 것: 고유명사·영문약어·발표 특유 전문용어 (5~15개)
넣지 말 것: 일반명사, 발표에 없는 단어

**찾는 법**: 먼저 한 번 돌려 전사문을 읽고 이상한 고유명사만 모은다.
슬라이드 업로드 기능이 붙으면 pdfplumber 자동 추출이 이상적.

---

## 9. 개발 도구

```bash
# cwd = backend/, .venv 활성화
uvicorn devtools.server:app --reload --port 8001
```

`/voice/` 에서 모델 비교, 전사문 diff, 무음 타임라인, 필러 후보 청취·라벨링.
자세한 사용법은 `backend/stt_test/README.md`.

> 포트 8000 은 본 API 서버(`app.main:app`). 겹치면 안 된다.

---

## 10. 미결

- **임계값 5개 확정** — 실제 녹음 라벨링 후 `eval` 스윕
- **배포 환경** — transformers 는 fp32 라 메모리 약 3.2GB. 리눅스는 torch CPU 전용 인덱스 필요
- **3-3 음향 경로** 유지/폐기 최종 판정
- **자기수정 검출**(`저는 아니 저희는`) 2순위 후보
