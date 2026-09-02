"""STEP 3-3 — 필러/말더듬 구간 검출 (VAD ∧ ¬STT + 음향 특징).

핵심 아이디어
-------------
상용 STT 는 필러("음", "어")·반복·말더듬을 후처리로 제거하고 '읽기 좋은 전사' 를 줌.
이건 우리 입장에서 버그가 아니라 **신호**로 쓸 수 있음:

    VAD: "여기 목소리 있음"  ∧  STT: "여기 단어 없음"
                    ↓
        소리는 냈는데 어휘로 인식되지 않은 구간
        = 필러 / 말더듬 / 늘어짐 후보

여기에 음향 필터를 걸어 숨소리·입소리·잡음을 걷어냄. 특히 **F0 평탄성** 이 결정적:
한국어 필러는 음높이 변화 없이 모음이 길게 유지되는 반면, 실제 발화는 음높이가 움직임.

보조로 STT 가 **실제로 뱉은** 필러 어휘도 잡아서 합집합을 취함
(Whisper 는 필러를 뱉을 때도 있고 안 뱉을 때도 있어서 이것만으로는 부족).

임계값은 전부 추정 출발점이며 라벨링 데이터로 튜닝해야 함.
`report.py` 가 만드는 청취/라벨링 페이지 + `evaluate.py` 가 그 용도.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from stt_test.audio import PitchStats, pitch_stats, rms_db, slice_samples
from stt_test.stt import Word
from stt_test.vad import Region

# --- 임계값 (튜닝 대상) ---------------------------------------------------

# 단어 timestamp 오차 흡수용 패딩(초). Whisper 의 단어 경계는 cross-attention
# DTW 로 만든 근사치라 ±100~200ms 오차가 있음. 이만큼 부풀린 뒤 차집합을 구해서
# "단어 경계가 살짝 어긋나 생긴 가짜 빈틈" 을 없앰.
WORD_PAD_SEC = 0.12

# 필러 후보 최소 길이(초). 이보다 짧으면 조음 전이(transition)나 timestamp 오차로 봄.
#
# ⚠️ WORD_PAD_SEC 과 함께 읽을 것 — 둘이 곱해져서 벌을 두 번 준다.
#    후보 길이는 **패딩으로 깎인 뒤** 측정되므로:
#        측정 길이 = 실제 길이 - 2 x WORD_PAD_SEC   (= 실제 - 0.24초)
#    따라서 이 값이 0.20 이면 실질적으로 **0.44초 이상인 필러만** 통과했고,
#    0.3초짜리 짧은 "음" 은 구조적으로 검출 불가였음.
#    실측(사용자 녹음 2개) 후보 길이 중앙값이 0.17~0.20 이라 절반이 잘려나갔음.
#    → 0.10 으로 완화 (실제 길이 약 0.34초 이상에 해당).
#    UI 슬라이더로 실시간 조정 가능하며, 최종값은 라벨링 후 eval 스윕으로 결정할 것.
MIN_CANDIDATE_SEC = 0.10

# 후보가 이 길이를 넘으면 필러라기보다 STT 가 놓친 발화 or 잡음 → 별도 표시.
MAX_CANDIDATE_SEC = 3.0

# 발화 기준 레벨 대비 상대 임계값(dB). 숨소리/입소리/의자 소리는 실제 발화보다
# 훨씬 작음. 화자·마이크 게인에 무관하려고 절대값이 아닌 '상대값' 을 씀.
MIN_RELATIVE_DB = -18.0

# 유성음 프레임 비율 하한. 숨소리·마찰음성 잡음은 무성음이라 낮게 나옴.
MIN_VOICED_RATIO = 0.45

# F0 표준편차 상한(반음).
#
# 원래 근거였던 "필러는 F0 가 평탄하다" 는 **가설은 측정으로 반증됨**:
#     필러      2.87 ~ 3.82 반음
#     일반 발화  0.62 ~ 3.76 반음   ← 분포가 완전히 겹침
# 그래서 초기값 1.5 는 필러까지 전부 기각해 recall 0.00 인 차단벽이었음.
#
# 그렇다고 관문 자체를 없애면 오검출만 늘어난다. 정답 픽스처(음향 경로만) 실측:
#     상한   TP FN FP  precision recall
#     1.5     0  3  0    0.00    0.00   ← 아무것도 못 잡음
#     3.5     2  1  0    1.00    0.67   ← 채택
#     99      2  1  1    0.67    0.67   ← 제거해도 recall 그대로, precision 만 하락
#   실제 녹음에서도 제거 시 음향 채택이 4건 → 16건으로 폭증(대부분 오검출 추정).
#
# → 해석을 약화해 유지: "필러는 평탄하다" 가 아니라
#   **"음높이가 아주 크게 움직이는 구간은 필러가 아니다"** 정도의 약한 필터.
#
# ⚠️ 정답 샘플이 3건뿐이라 3.5 가 최적이라는 근거는 없음. 1.5 보다 낫다는 것만 확실.
#   실제 녹음 라벨링 후 `python -m stt_test eval` 스윕으로 재결정할 것.
MAX_F0_STD_SEMITONE = 3.5

# --- 어휘 기반 필러 ---------------------------------------------------------

# 항상 필러로 보는 어휘.
FILLER_STRONG = {"음", "어", "엄", "으", "어어", "음음", "에또", "으음", "어우"}

# 실제 단어로도 쓰이는 것들. **늘어졌을 때만** 필러로 인정
# (예: 짧은 "그"는 관형사, 길게 끄는 "그으..."는 필러).
FILLER_WEAK = {"그", "저", "저기", "이제", "뭐", "좀", "막", "아", "그래서", "인제"}
WEAK_MIN_DURATION_SEC = 0.35

_STRIP = " \t\n.,!?…·\"'​"


@dataclass
class FillerCandidate:
    """필러 후보 1건 + 판정 근거가 된 모든 측정값.

    기각된 후보도 버리지 않고 measurement 를 남김 — 임계값을 감이 아니라
    측정치 분포를 보고 조정하기 위해서.
    """

    t_start: float
    t_end: float
    source: str                  # "acoustic"(VAD∧¬STT) | "lexical"(STT 어휘)
    is_filler: bool
    reject_reason: str | None = None
    text: str | None = None      # lexical 일 때 인식된 단어
    rms_db: float = -120.0
    relative_db: float = -120.0
    pitch: PitchStats | None = None
    context_text: str = ""       # 앞뒤 STT 문맥 (청취 검증용)

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start

    def to_dict(self) -> dict:
        d = {
            "t_start": round(self.t_start, 3),
            "t_end": round(self.t_end, 3),
            "duration": round(self.duration, 3),
            "source": self.source,
            "is_filler": self.is_filler,
            "reject_reason": self.reject_reason,
            "text": self.text,
            "rms_db": round(self.rms_db, 1),
            "relative_db": round(self.relative_db, 1),
            "context_text": self.context_text,
        }
        if self.pitch is not None:
            d.update(self.pitch.to_dict())
        return d


@dataclass
class FillerResult:
    candidates: list[FillerCandidate] = field(default_factory=list)
    speech_reference_db: float = -120.0

    @property
    def accepted(self) -> list[FillerCandidate]:
        return [c for c in self.candidates if c.is_filler]


# ---------------------------------------------------------------------------
# 구간 연산
# ---------------------------------------------------------------------------

def _merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not intervals:
        return []
    out = [list(intervals[0])]
    for s, e in sorted(intervals)[1:]:
        if s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def subtract_intervals(regions: list[Region], holes: list[tuple[float, float]]) -> list[Region]:
    """regions 에서 holes 를 파낸 나머지 구간."""
    merged = _merge(holes)
    out: list[Region] = []
    for r in regions:
        cursor = r.t_start
        for h0, h1 in merged:
            if h1 <= cursor:
                continue
            if h0 >= r.t_end:
                break
            if h0 > cursor:
                out.append(Region(cursor, min(h0, r.t_end)))
            cursor = max(cursor, h1)
            if cursor >= r.t_end:
                break
        if cursor < r.t_end:
            out.append(Region(cursor, r.t_end))
    return out


# ---------------------------------------------------------------------------
# 검출
# ---------------------------------------------------------------------------

def _speech_reference_db(samples: np.ndarray, sr: int, words: list[Word]) -> float:
    """단어 구간들의 RMS 중앙값 = 이 화자의 '보통 발화 레벨'."""
    levels = [
        rms_db(slice_samples(samples, sr, w.t_start, w.t_end))
        for w in words
        if w.t_end > w.t_start
    ]
    levels = [x for x in levels if x > -119.0]
    return float(np.median(levels)) if levels else -120.0


def _context_text(words: list[Word], t_start: float, t_end: float, window: float = 2.0) -> str:
    """후보 구간 앞뒤 window 초의 STT 텍스트 — 클립 들을 때 맥락 파악용."""
    before = [w.text for w in words if t_start - window <= w.t_end <= t_start]
    after = [w.text for w in words if t_end <= w.t_start <= t_end + window]
    return f"{' '.join(before[-6:])} ⟨…⟩ {' '.join(after[:6])}".strip()


def _classify_acoustic(cand: FillerCandidate) -> None:
    """음향 특징으로 필러/기각 판정. cand 를 제자리 수정."""
    if cand.duration < MIN_CANDIDATE_SEC:
        cand.is_filler, cand.reject_reason = False, "too_short"
        return
    if cand.duration > MAX_CANDIDATE_SEC:
        cand.is_filler, cand.reject_reason = False, "too_long"
        return
    if cand.relative_db < MIN_RELATIVE_DB:
        cand.is_filler, cand.reject_reason = False, "too_quiet"
        return
    assert cand.pitch is not None
    if cand.pitch.voiced_ratio < MIN_VOICED_RATIO:
        cand.is_filler, cand.reject_reason = False, "unvoiced"
        return
    if cand.pitch.f0_std_semitone > MAX_F0_STD_SEMITONE:
        cand.is_filler, cand.reject_reason = False, "pitch_moves"
        return
    cand.is_filler, cand.reject_reason = True, None


def is_filler_token(token: str, duration: float) -> bool:
    """STT 가 뱉은 단어가 필러 어휘인가.

    FILLER_WEAK 는 실제 단어로도 쓰이므로 늘어졌을 때만 인정.
    """
    return token in FILLER_STRONG or (
        token in FILLER_WEAK and duration >= WEAK_MIN_DURATION_SEC
    )


def strip_filler_words(words: list[Word]) -> list[Word]:
    """STT 결과에서 필러 어휘를 제거 — 클로바노트류 '정제된 전사' 시뮬레이션.

    3-3 의 핵심 주장은 "STT 가 필러를 지워도 VAD 와의 차집합으로 잡아낼 수 있다"
    는 것. Whisper 는 필러를 뱉을 때가 있어서 그대로 두면 어휘 경로가 답을
    가로채 음향 경로가 검증되지 않음. 이 함수로 어휘 경로를 인위적으로 무력화해
    음향 경로만의 성능을 측정함 (ablation).
    """
    return [
        w for w in words
        if not is_filler_token(w.text.strip(_STRIP), w.t_end - w.t_start)
    ]


def detect_fillers(
    samples: np.ndarray,
    sr: int,
    speech: list[Region],
    words: list[Word],
    use_lexical: bool = True,
) -> FillerResult:
    """음향 후보(VAD∧¬STT) + 어휘 후보(STT 필러 단어) 를 합쳐 반환."""
    reference_db = _speech_reference_db(samples, sr, words)
    result = FillerResult(speech_reference_db=reference_db)

    # --- 1) 음향 후보: 발화 구간에서 단어 구간을 파낸 나머지 -----------------
    holes = [(w.t_start - WORD_PAD_SEC, w.t_end + WORD_PAD_SEC) for w in words]
    for gap in subtract_intervals(speech, holes):
        seg = slice_samples(samples, sr, gap.t_start, gap.t_end)
        level = rms_db(seg)
        cand = FillerCandidate(
            t_start=gap.t_start,
            t_end=gap.t_end,
            source="acoustic",
            is_filler=False,
            rms_db=level,
            relative_db=level - reference_db,
            pitch=pitch_stats(seg, sr),
            context_text=_context_text(words, gap.t_start, gap.t_end),
        )
        _classify_acoustic(cand)
        result.candidates.append(cand)

    # --- 2) 어휘 후보: STT 가 실제로 뱉은 필러 단어 -------------------------
    for w in words if use_lexical else []:
        token = w.text.strip(_STRIP)
        if not token or not is_filler_token(token, w.t_end - w.t_start):
            continue
        seg = slice_samples(samples, sr, w.t_start, w.t_end)
        level = rms_db(seg)
        result.candidates.append(
            FillerCandidate(
                t_start=w.t_start,
                t_end=w.t_end,
                source="lexical",
                is_filler=True,
                text=token,
                rms_db=level,
                relative_db=level - reference_db,
                pitch=pitch_stats(seg, sr),
                context_text=_context_text(words, w.t_start, w.t_end),
            )
        )

    result.candidates.sort(key=lambda c: c.t_start)
    return result


def merge_accepted(result: FillerResult, gap_tolerance: float = 0.05) -> list[dict]:
    """확정 필러들을 시간순으로 병합해 voice_raws.filler_words 형태로."""
    accepted = sorted(result.accepted, key=lambda c: c.t_start)
    out: list[dict] = []
    for c in accepted:
        if out and c.t_start - out[-1]["t_end"] <= gap_tolerance:
            out[-1]["t_end"] = max(out[-1]["t_end"], c.t_end)
            out[-1]["duration"] = round(out[-1]["t_end"] - out[-1]["t_start"], 3)
            if c.text and not out[-1]["text"]:
                out[-1]["text"] = c.text
            continue
        out.append({
            "t_start": round(c.t_start, 3),
            "t_end": round(c.t_end, 3),
            "duration": round(c.duration, 3),
            "source": c.source,
            "text": c.text,
        })
    return out
