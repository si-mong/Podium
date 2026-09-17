"""STEP 3-5 — 말더듬(반복) 검출.

**텍스트만 사용한다.** STT 가 이미 뽑아둔 단어 timestamp 위에서 인접 토큰을
비교할 뿐이라 STT 재실행도, 새 모델도, 음향 분석도 필요 없음.

왜 반복만 하는가 — TTS 픽스처로 유형별 검증한 결과:

    전체어절 반복  "그래서 그래서 그래서 저희는"  → 그대로 전사됨        ✅
    음절 반복      "제 제 제가 발표를"            → 그대로 전사됨        ✅
    첫음절 반복    "그 그 그러니까 결과적으로"     → 그대로 전사됨        ✅
    연장           "그으으래서 저희는"            → "그을에서" 로 뭉개짐  ❌
    자기수정       "저는 아니 저희는"             → 텍스트는 보존되나
                                                   인접 비교로는 안 잡힘 ⚠️

→ **연장·막힘은 범위 밖.** 연장은 STT 가 존재하지 않는 단어로 망가뜨려 텍스트로
  못 잡고, 음향으로 가면 3-3 음향 경로가 실패한 그 벽(지속 모음 판별)을 그대로 만남.
  막힘(silent block)은 음향적으로 평범한 멈춤과 구분 불가이며 이미 3-1 이 무음으로
  보고하고 있음.
  자기수정은 STT 가 막는 게 아니라 규칙 문제라 2순위 후보로 남겨둠.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.pipeline.voice.filler import FILLER_STRONG, _STRIP
from app.pipeline.voice.stt import Word

# 반복으로 묶을 최대 간격(초). 이보다 벌어지면 말더듬이 아니라 서로 다른 문장에서
# 우연히 같은 단어가 나온 것으로 봄.
MAX_GAP_SEC = 1.0

# 어간 반복("제"→"제가")으로 인정할 앞 토큰의 최대 길이(음절).
MAX_STEM_LEN = 2

# stem 반복 전용 간격 상한(초). exact 보다 훨씬 좁게 잡는 이유:
#   "이 이야기", "그 그림", "저 저녁" 처럼 **정상 관형사+명사**가 같은 규칙에 걸린다.
#   말더듬의 반복은 앞 조각이 튀어나오듯 빠르게 이어지는 반면(<0.35초),
#   정상 관형사+명사는 일반적인 어절 경계를 가진다. 완벽히 갈리지는 않으므로
#   stem 은 **exact 보다 신뢰도가 낮은 후보**로 취급하고 UI 에서 구분해 보여준다.
STEM_MAX_GAP_SEC = 0.35

# 한국어에서 반복이 정상인 강조 표현 — 오검출 방지용 제외 목록.
EMPHASIS_ALLOWLIST = {"정말", "진짜", "아주", "매우", "점점", "다시", "빨리", "천천히"}


@dataclass
class Repetition:
    """반복 1건. 연속된 반복은 하나로 묶고 count 로 횟수를 표시."""

    t_start: float
    t_end: float
    kind: str                 # "exact"(동일 토큰) | "stem"(앞음절 반복)
    tokens: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.tokens)

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start

    def to_dict(self) -> dict:
        return {
            "t_start": round(self.t_start, 3),
            "t_end": round(self.t_end, 3),
            "duration": round(self.duration, 3),
            "kind": self.kind,
            "count": self.count,
            "text": " ".join(self.tokens),
        }


_TAG_RE = re.compile(r"<[a-z]+>")


def _norm(w: Word) -> str:
    return w.text.strip(_STRIP)


def _drop_tags(words: list[Word]) -> list[Word]:
    """모델 비유창성 태그(`<um>`, `<repeat>` …)를 제거.

    태그가 단어 사이에 끼면 인접 비교가 끊긴다. 예를 들어 SeloWhisper 는
    "제<repeat> 제<repeat> 제가" 처럼 출력하는데, 태그를 그대로 두면
    "제"와 "제"가 인접하지 않아 반복을 놓친다.
    """
    return [w for w in words if not _TAG_RE.fullmatch(_norm(w))]


def _is_filler(token: str) -> bool:
    """순수 필러("음","어")만 반복 집계에서 제외 — 3-3 이 이미 세므로 이중 집계 방지.

    FILLER_WEAK("그","그래서","저기"…)는 **제외하지 않는다.** 이들은 실제 단어라
    3-3 이 늘어졌을 때만 필러로 세는데, "그래서 그래서 그래서" 처럼 **반복되는 건
    길이와 무관하게 명백한 말더듬**이기 때문. 제외하면 가장 흔한 유형을 놓친다.
    """
    return token in FILLER_STRONG


def detect_repetitions(words: list[Word]) -> list[Repetition]:
    """인접 단어 비교로 반복 검출.

    두 가지를 잡는다:
      exact  같은 토큰이 연달아 나옴          "그래서 그래서 그래서"
      stem   짧은 토큰이 다음 토큰의 앞부분    "제 제가" / "그 그러니까"
    """
    words = _drop_tags(words)
    out: list[Repetition] = []
    n = len(words)
    i = 1
    while i < n:
        prev, cur = words[i - 1], words[i]
        a, b = _norm(prev), _norm(cur)

        if not a or not b or cur.t_start - prev.t_end > MAX_GAP_SEC:
            i += 1
            continue
        if _is_filler(a) or a in EMPHASIS_ALLOWLIST:
            i += 1
            continue

        gap = cur.t_start - prev.t_end
        if a == b:
            kind = "exact"
        elif (len(a) <= MAX_STEM_LEN and b.startswith(a)
              and gap <= STEM_MAX_GAP_SEC):
            kind = "stem"
        else:
            i += 1
            continue

        # 연속된 반복을 하나로 묶음: "그래서 그래서 그래서" → 1건(count=3)
        rep = Repetition(prev.t_start, cur.t_end, kind, [a, b])
        j = i + 1
        while j < n:
            nxt = words[j]
            c = _norm(nxt)
            if not c or nxt.t_start - words[j - 1].t_end > MAX_GAP_SEC:
                break
            last = _norm(words[j - 1])
            if c == last or (len(last) <= MAX_STEM_LEN and c.startswith(last)):
                rep.tokens.append(c)
                rep.t_end = nxt.t_end
                j += 1
            else:
                break
        out.append(rep)
        i = j

    return out
