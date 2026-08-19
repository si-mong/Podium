# stt_test — STEP 3 음성분석 PoC

`full_audio.wav` 하나로 **무음 구간 / 필러 / 발화 속도**를 뽑아내는 검증 도구.
DB 연결 안 함. 함수 단위 검증용이며, 확정된 부분만 `app/pipeline/` 으로 옮길 예정.

```
3-1 VAD      → 무음 구간            ✅ 완성 (STT 무관, 단독 동작)
3-2 STT      → 문장 + 단어 timestamp  ✅ 완성 (faster-whisper)
3-3 필러     → 어휘 경로 ✅ / 음향 경로 ⚠️ 보류
3-4 발화속도  → 음절/분(SPM)          ✅ 완성
```

## 사전 준비

```bash
# cwd = backend/
ffmpeg -version                          # 없으면: brew install ffmpeg
source .venv/bin/activate
pip install faster-whisper
```

torch / librosa 불필요 (설치 용량 ~150MB). 모델은 첫 실행 시 자동 다운로드
(`small` ≈ 500MB, `large-v3` ≈ 3GB, `~/.cache/huggingface`).

## 실행

```bash
# cwd = backend/

# 1) 무음 지표만 — STT 없이 즉시 (100초 파일에 0.2초)
python -m stt_test run uploads/2/full_audio.wav --skip-stt

# 2) 전체 분석. 반복 개발은 small, 실측은 large-v3
python -m stt_test run <녹음>.wav --model small
python -m stt_test run <녹음>.wav --model large-v3

# 3) 음향 경로만 — STT 가 필러를 지우는 상황 시뮬레이션 (아래 '3-3 현황' 참고)
python -m stt_test run <녹음>.wav --model large-v3 --ablate-lexical

# 4) 후보 청취/라벨링 → precision·recall + 임계값 스윕
open stt_test/out/<name>/report.html      # 듣고 필러/아님 찍고 '라벨 JSON 내려받기'
mv ~/Downloads/labels.json stt_test/out/<name>/
python -m stt_test eval stt_test/out/<name>
```

클립이 안 들리면 `cd stt_test/out/<name> && python -m http.server 8123`.

## 출력

`analyze()` 가 돌려주는 dict:

| 키 | 내용 |
|---|---|
| `voice_raw` | `voice_raws` 테이블에 그대로 저장 (`total_duration`, `silence_segments`, `filler_words`) |
| `stt_sentences` | `stt_sentences` 테이블용 |
| `metrics` | 집계 지표 (`segment_analyses` / `session_summaries` 용) |
| `diagnostics` | 튜닝/검증용 — 후보별 측정값, 단어 timestamp, 소요시간 |

## 설계 결정

### 무음은 STT 를 안 씀 (3-1)
무음은 신호처리 문제이고, STT 세그먼트 timestamp 는 디코더가 만든 근사치라
경계가 뭉개짐. VAD(Silero, faster-whisper 에 번들된 ONNX 재사용) 로 파형에서
직접 뽑음. → **STT 없이도 무음 지표가 완성되고 독립 검증 가능.**

VAD 파라미터는 faster-whisper 기본값을 쓰면 안 됨 (`speech_pad_ms=400`,
`min_silence_duration_ms=2000` 은 Whisper 입력 덩어리용 튜닝). 패딩 0 / 최소침묵
100ms 로 경계를 그대로 받아서 후처리는 우리가 함. → `vad.py` 주석 참고.

### openai-whisper → faster-whisper
Python 3.13 빌드 실패(`pkg_resources`) 해소 + CPU 에서 수 배 빠름 + torch 불필요 +
`word_timestamps=True` 네이티브. `vad_filter=False` 필수 (내장 VAD 가 켜지면
비어휘 발성이 잘려나감).

### 한국어는 WPM 이 아니라 SPM (3-4)
어절 수는 띄어쓰기 정책에 따라 요동침. 음절(한글 블록) 기준이 안정적.
두 가지를 따로 냄:
- `speaking_rate_spm` — 무음 포함. 전체 템포
- `articulation_rate_spm` — 무음 제외. 순수 조음 속도

둘을 나누면 "말 자체는 빠른데 자주 멈춘다" 같은 진단이 가능해짐.

## ⚠️ 3-3 현황 — 음향 경로는 보류

### 원래 가설
> 상용 STT 는 필러를 지우니까, `VAD:"목소리 있음" ∧ STT:"단어 없음"` 의 차집합이
> 곧 필러다. 여기에 "필러는 F0 가 평탄하다" 는 음향 필터를 걸면 숨소리를 걷어낼 수 있다.

### 측정 결과 (TTS 합성 픽스처, `make_fixture.py`)

| 검증 | 결과 |
|---|---|
| VAD 가 필러를 발화로 인정하는가 | ✅ TTS 필러 85~96% (전제 성립) |
| 어휘 경로 (STT 필러 단어 매칭) | ✅ **3/3 검출, precision 1.00** |
| 음향 경로 (`--ablate-lexical`) | ❌ **0/3 검출** — 전부 `pitch_moves` 기각 |
| 숨소리 오검출 | ✅ 2/2 정상 기각 |

**"필러는 F0 가 평탄하다" 가설은 반증됨.** 정답 경계로 정확히 잘라 재보면
필러 F0 편차 2.87~3.82 반음 vs 일반 발화 0.62~3.76 반음 — 분포가 완전히 겹침.
대안으로 스펙트럼 안정도를 재봐도 필러 0.963~0.982 vs 발화 최대 0.966 으로
마진이 거의 없음. 특히 **문장 끝 늘어지는 모음("~입니다" 꼬리)이 필러와
음향적으로 구분되지 않음** — 임계값 튜닝으로 메울 격차가 아님.

### 더 중요한 발견 — Whisper 는 필러를 지우지 않음

Whisper small 이 픽스처를 전사한 결과:
```
안녕하세요 오늘 발표를 맡은 김은재입니다 음 저희팀이 개발한 서비스
는 발표 연습을 도와주는 인공지능 코치입니다 음 영상을 업로드하면
음성과 동작을 함께 분석합니다 어어 구간 별로 어떤 습관이 있었는지
```
`음`@3.68-4.00, `음`@9.88-10.56, `어어`@15.22-16.02 — 타임스탬프까지 붙여서 그대로 출력.

**클로바노트는 "전사 제품"이고 Whisper 는 "ASR 모델"** 이라는 차이. 클로바가
필러를 지우는 건 읽기 좋은 회의록을 만들기 위한 후처리이고, Whisper 에는 그
단계가 없음. → 3-3 의 존재 이유였던 전제 자체가 Whisper 에는 해당하지 않음.

### 그래서 현재 방침

| 경로 | 위치 |
|---|---|
| 어휘 (`FILLER_STRONG` / `FILLER_WEAK` 매칭) | **주력** |
| 음향 (VAD ∧ ¬STT) | **보류** — 실제 녹음으로 판정 후 유지/폐기 |

코드는 지우지 않고 `--ablate-lexical` 로 두 경로를 분리 측정할 수 있게 유지.
**결론은 사람 녹음 하나로 결정됨:**

```bash
python -m stt_test run <사람녹음>.wav --model large-v3                  # 어휘 포함
python -m stt_test run <사람녹음>.wav --model large-v3 --ablate-lexical  # 음향만
```
두 결과의 차이 = 음향 경로가 추가로 기여하는 양. 없으면 3-3 폐기하고
`filler.py` 를 어휘 매칭만 남겨 대폭 단순화.

### 픽스처의 한계
TTS 필러는 또박또박 발음된 고립 단어라 **사람이 문장 중간에 웅얼거리는
필러보다 훨씬 쉬움.** 위 결과는 판별 원리의 sanity check 이지 실제 성능 근거가
아님. 실제 성능은 사람 녹음 + `report.html` 라벨링으로 재야 함.

개발 중 발견: 초기 픽스처는 성문파+포먼트로 **합성한** 지속 모음을 필러로 썼는데
Silero VAD 가 이걸 발화로 **0%** 인정 → 3-3 을 시험조차 못 했음. 픽스처의 필러는
반드시 실제 발성(TTS 또는 사람) 기반이어야 함.

## 알려진 이슈 — uploads/ 테스트 녹음에 음성이 없음

| 세션 | 길이 | 상태 |
|---|---|---|
| 1 | 105s | 완전 무음 (-91dB = 디지털 0) |
| 2 | 840s | 완전 무음 |
| 3 | 88.6s | 발화 3.3초 (96% 무음) |
| 4 | 99.3s | 발화 2.3초 (98% 무음) |

원본 `full_video.webm` 도 동일하게 -91dB → **STEP 1 ffmpeg 추출 버그 아님.**
녹화 시점에 마이크가 안 잡힘(권한/음소거 추정). 촬영 페이지에 입력 레벨 미터나
무음 경고를 넣으면 이런 세션이 다시 쌓이는 걸 막을 수 있음.
