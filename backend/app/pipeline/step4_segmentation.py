"""
Step 4: 구간 분리 (LLM)

STT 문장들을 의미 단위로 묶어 발표 구간을 나눈다.

입력: stt_sentences (문장 + 시각)
출력: segments 행 (label / title / t_start / t_end)

핵심 설계 — **LLM 에게 타임스탬프를 묻지 않는다.**
    문장에 번호를 붙여 넘기고 **번호 범위**로 경계를 받은 뒤, 시각은 우리가
    가진 `stt_sentences.t_start/t_end` 에서 그대로 가져온다.

    이유 두 가지:
      1) LLM 은 오디오를 측정하는 게 아니라 그럴듯한 토큰을 생성하므로
         시각을 직접 받으면 환각이 섞인다. 번호는 우리 데이터와 1:1 이라 안전.
      2) 번호는 기계적으로 검증된다 — 범위·연속성·누락·중복을 다 확인할 수 있다.
         시각을 받으면 맞는지 알 방법이 없다.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

MODEL = "gemini-2.5-flash"

# ── 구간 크기 정책 ────────────────────────────────────────────────────────
# PPT 목차 수준의 **큰 덩어리**를 원한다. 세부 화제가 바뀔 때마다 자르면 구간이
# 잘게 부서져 회차 비교도, 구간별 피드백도 의미가 흐려진다.
#
# 두 겹으로 막는다:
#   1) 프롬프트에 발표 길이 기준 목표 개수 제시 (LLM 이 크게 묶도록)
#   2) 그래도 짧게 나오면 후처리로 이웃에 병합 (LLM 출력에 의존하지 않음)
# 구간을 크게 만드는 수단은 **길이 제약이 아니라 라벨 설계와 흡수 규칙**이다.
# 45초로 잡았더니 «주제소개 10초 → 배경설명 22초 → 문제제시 16초» 같은
# 정상적인 흐름까지 통째로 뭉개졌다. 여기서는 부스러기만 걷어낸다.
MIN_SEGMENT_SEC = 5.0      # 명백한 부스러기만 흡수 (정상 흐름은 10초대도 유효)

# 같은 라벨이 다시 나오면 사이에 낀 구간까지 하나로 합친다.
#   예: 한계 → 개념설명 → 한계  ⇒  하나의 «한계»
#   중간의 개념설명은 그 한계를 설명하려고 곁들인 것이지 독립 구간이 아니다.
# 다만 발표 앞뒤로 멀리 떨어진 동일 라벨까지 합치면 안 되므로 간격을 제한한다.
MAX_SANDWICH_GAP = 1       # 사이에 **하나만** 낀 경우만 병합 (과병합 방지)
MAX_ATTEMPTS = 3
RETRY_WAIT_SEC = 5

# ── 라벨 ──────────────────────────────────────────────────────────────────
# 순서를 강제하지 않는다. 발표마다 흐름이 다르고 같은 라벨이 여러 번 나올 수도 있다.
# 폭을 넓게 잡아 LLM 이 "가장 가까운 것"을 고르게 한다 — 억지로 끼워맞추면
# 라벨 신뢰도가 떨어져 STEP 5 피드백이 엉뚱해진다.
# 라벨은 **발표의 큰 흐름**만 담는다. 처음엔 17종이었으나 「개념설명」·「고찰」·
# 「선행사례」 같은 항목이 문제였다 — 이들은 대개 독립 구간이 아니라 **다른 구간을
# 설명하려고 곁들이는 것**이라, 남겨두면 «한계 → 개념설명 → 한계 → 개념설명» 처럼
# 하나의 논의가 잘게 쪼개진다. 그런 내용은 해당 맥락의 구간에 흡수시킨다.
LABELS = [
    "인사",          # 자기소개, 발표 시작 인사
    "주제소개",      # 무엇에 대한 발표인지
    "배경설명",      # 맥락, 선행 사례, 왜 이 주제가 나왔는지
    "문제제시",      # 해결하려는 문제
    "해결방안",      # 제안하는 접근 (개념·원리 설명 포함)
    "시스템구조",    # 아키텍처, 구성도
    "구현",          # 개발 내용, 기술 스택
    "시연",          # 데모, 화면 설명
    "결과",          # 성과, 수치, 실험 결과, 해석
    "한계",          # 부족한 점, 제약 (그에 관한 설명 포함)
    "향후계획",      # 다음 단계
    "결론",          # 요약, 정리, 마무리 인사
]

# ⚠️ "기타" 라벨은 두지 않는다. 주제가 잠시 곁길로 새는 일이 흔한데 그때마다
#    구간이 쪼개지면 분리가 지나치게 빈번해진다. **주제가 바뀌는 시작점**을
#    기준으로만 자르고, 곁가지는 직전 구간에 포함시킨다.
#    (재검토 대상 — Todo-회의필요 참고)

PROMPT = """당신은 발표 영상을 분석하는 도우미입니다.
아래는 한 발표의 음성을 문장 단위로 전사한 것입니다. 각 줄 앞의 [숫자]는 문장 번호입니다.

이 발표를 의미 단위 구간으로 나누세요.

## 규칙

1. **문장 번호로만** 경계를 지정하세요. 시간(초)은 쓰지 마세요.
2. 구간은 빠짐없이 이어져야 합니다. 첫 구간은 [0]에서 시작하고, 마지막 구간은
   마지막 문장에서 끝나며, 구간 사이에 빈 번호나 겹치는 번호가 없어야 합니다.
3. **주제가 바뀌는 지점**에서만 자르세요. 이야기가 잠시 곁길로 새는 정도로는
   자르지 말고 직전 구간에 포함시키세요.
4. 어떤 내용을 **설명하기 위해** 곁들인 이야기(용어 설명, 사례, 부연)는
   독립 구간으로 만들지 마세요. **설명 대상이 속한 구간에 포함**시킵니다.
   예: 「한계」를 말하다가 그 한계와 관련된 기술을 설명했다면, 그 설명까지
   전체가 하나의 「한계」입니다. 설명이 끝나고 다시 한계 이야기로 돌아와도
   쪼개지 말고 하나로 두세요.
5. 각 구간에 아래 라벨 중 **가장 가까운 것 하나**를 고르세요.
   순서는 정해져 있지 않고, 같은 라벨이 여러 번 나와도 됩니다.
   목록에 없는 라벨을 새로 만들지 마세요.

## 라벨 목록
{labels}

## 출력 형식
아래 JSON 배열만 출력하세요. 설명이나 마크다운은 쓰지 마세요.

[
  {{"label": "라벨", "title": "이 구간을 한 줄로 요약(20자 이내)", "start": 0, "end": 4}},
  ...
]

## 전사문
{transcript}
"""


@dataclass
class Segment:
    label: str
    title: str
    start_idx: int
    end_idx: int
    t_start: float = 0.0
    t_end: float = 0.0

    def to_dict(self) -> dict:
        return {"label": self.label, "title": self.title,
                "start_idx": self.start_idx, "end_idx": self.end_idx,
                "t_start": round(self.t_start, 3), "t_end": round(self.t_end, 3),
                "duration": round(self.t_end - self.t_start, 3)}


@dataclass
class SegmentResult:
    segments: list[Segment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    raw: str = ""

    def to_dict(self) -> dict:
        return {"segments": [s.to_dict() for s in self.segments],
                "warnings": self.warnings}


def build_transcript(sentences: list[dict]) -> str:
    """LLM 에 넘길 번호 매긴 전사문. **시각은 넣지 않는다** — 시각을 보여주면
    모델이 그걸 흉내 내 출력하려 들고, 우리는 번호만 필요하다."""
    return "\n".join(f"[{i}] {s['text']}" for i, s in enumerate(sentences))


def _repair(items: list[dict], n: int) -> tuple[list[Segment], list[str]]:
    """LLM 출력을 검증하고 고칠 수 있는 건 고친다.

    번호 기반이라 기계적 검증이 가능하다는 게 이 설계의 핵심 이점.
    """
    warns: list[str] = []
    segs: list[Segment] = []

    for it in items:
        try:
            a, b = int(it["start"]), int(it["end"])
        except (KeyError, TypeError, ValueError):
            warns.append(f"번호 없음/형식 오류: {it}")
            continue
        label = str(it.get("label", "")).strip()
        if label not in LABELS:
            warns.append(f"목록 밖 라벨 '{label}' → 그대로 사용")
        segs.append(Segment(label=label or "미분류",
                            title=str(it.get("title", "")).strip()[:255],
                            start_idx=max(0, min(a, n - 1)),
                            end_idx=max(0, min(b, n - 1))))

    if not segs:
        return [], warns + ["구간을 하나도 못 받음"]

    segs.sort(key=lambda s: s.start_idx)

    # 이어붙이기 — 겹침/빈틈을 직전 구간 끝을 기준으로 보정
    fixed: list[Segment] = []
    cursor = 0
    for s in segs:
        if s.start_idx != cursor:
            warns.append(f"경계 불연속 [{s.start_idx}] → [{cursor}] 로 보정")
            s.start_idx = cursor
        if s.end_idx < s.start_idx:
            warns.append(f"끝이 시작보다 앞섬 → [{s.start_idx}] 로 보정")
            s.end_idx = s.start_idx
        fixed.append(s)
        cursor = s.end_idx + 1
        if cursor >= n:
            break

    if fixed[-1].end_idx != n - 1:
        warns.append(f"마지막 문장 누락 → [{n-1}] 까지 확장")
        fixed[-1].end_idx = n - 1

    return fixed, warns


def _dur(seg, sentences) -> float:
    return sentences[seg.end_idx]["t_end"] - sentences[seg.start_idx]["t_start"]


def _merge_short(segs, sentences, min_sec):
    """min_sec 보다 짧은 구간을 이웃에 흡수. 라벨·제목은 **긴 쪽**을 따른다.

    LLM 이 지침을 무시하고 잘게 쪼개도 여기서 막힌다.
    """
    warns = []
    while len(segs) > 1:
        short = next((i for i, s in enumerate(segs)
                      if _dur(s, sentences) < min_sec), None)
        if short is None:
            break
        # 이웃 중 더 짧은 쪽과 합쳐 한쪽만 비대해지는 것을 막는다
        if short == 0:
            other = 1
        elif short == len(segs) - 1:
            other = short - 1
        else:
            other = (short - 1 if _dur(segs[short - 1], sentences)
                     <= _dur(segs[short + 1], sentences) else short + 1)
        a, b = sorted((short, other))
        keep = segs[a] if _dur(segs[a], sentences) >= _dur(segs[b], sentences) else segs[b]
        merged = Segment(label=keep.label, title=keep.title,
                         start_idx=segs[a].start_idx, end_idx=segs[b].end_idx)
        warns.append(f"짧은 구간({_dur(segs[short], sentences):.0f}초) 병합 → «{merged.label}»")
        segs = segs[:a] + [merged] + segs[b + 1:]
    return segs, warns


def _merge_sandwich(segs, sentences, max_gap: int):
    """같은 라벨이 되돌아오면 사이에 낀 구간까지 하나로 합친다.

    «한계 → 개념설명 → 한계» 처럼 중간에 낀 것은 앞뒤 논의를 설명하려고
    곁들인 경우가 대부분이다. 라벨을 줄여도 LLM 이 이런 구조를 만들 수 있으므로
    후처리로 한 번 더 막는다.
    """
    warns = []
    changed = True
    while changed and len(segs) > 2:
        changed = False
        for i in range(len(segs) - 2):
            for j in range(i + 2, min(i + 2 + max_gap, len(segs))):
                if segs[i].label != segs[j].label:
                    continue
                inner = [x.label for x in segs[i + 1:j]]
                merged = Segment(label=segs[i].label, title=segs[i].title,
                                 start_idx=segs[i].start_idx, end_idx=segs[j].end_idx)
                warns.append(
                    f"«{segs[i].label}» 사이에 낀 {'·'.join(inner)} 흡수 → 하나의 «{merged.label}»")
                segs = segs[:i] + [merged] + segs[j + 1:]
                changed = True
                break
            if changed:
                break
    return segs, warns


def _stitch(segs, total_duration: float | None):
    """구간을 빈틈 없이 이어붙인다.

    경계는 문장의 시작/끝에서 오는데 **문장 사이에는 침묵이 있다.** 그 틈에서
    시작한 필러·무음·반복은 어느 구간에도 안 속해 집계에서 누락된다
    (실측: 구간별 필러 합 17 vs 전체 19).

    구간 사이의 침묵은 '다음 주제로 넘어가는 사이'이므로 **앞 구간에 붙인다.**
    → 구간별 개수를 다 더하면 전체와 일치한다.
    """
    if not segs:
        return segs
    segs[0].t_start = 0.0
    for a, b in zip(segs, segs[1:]):
        a.t_end = b.t_start
    if total_duration is not None and total_duration > segs[-1].t_end:
        segs[-1].t_end = total_duration
    return segs


def run(sentences: list[dict], total_duration: float | None = None,
        on_progress=None) -> SegmentResult:
    """문장 목록 → 구간. sentences 는 stt_sentences 형식(text/t_start/t_end)."""
    from google import genai
    from google.genai import types

    from app.core.config import settings

    if not sentences:
        return SegmentResult(warnings=["문장이 없음"])

    # 환경변수는 settings 로 접근한다 (docs/CLAUDE.md 규칙).
    # os.getenv + load_dotenv 조합은 호출 위치에 따라 .env 를 못 찾는 경우가 있다 —
    # load_dotenv() 는 cwd 가 아니라 **호출한 파일 위치**에서 거슬러 올라가며 찾는다.
    api_key = settings.gemini_api_key
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY 없음 (.env 확인)")

    prompt = PROMPT.format(labels="\n".join(f"- {x}" for x in LABELS),
                           transcript=build_transcript(sentences))
    client = genai.Client(api_key=api_key)

    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if on_progress:
            on_progress("llm", f"구간 분리 요청 ({attempt}/{MAX_ATTEMPTS})")
        try:
            resp = client.models.generate_content(
                model=MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.2,     # 분류 작업이라 낮게
                ),
            )
            items = json.loads(resp.text)
            segs, warns = _repair(items, len(sentences))
            if not segs:
                raise ValueError("유효 구간 0개")
            # 순서 주의: 샌드위치를 먼저 합쳐야 짧은 구간 병합이 엉뚱한 이웃을 안 고른다
            segs, swarns = _merge_sandwich(segs, sentences, MAX_SANDWICH_GAP)
            segs, mwarns = _merge_short(segs, sentences, MIN_SEGMENT_SEC)
            warns += swarns + mwarns

            # ── 시각 매핑: LLM 이 아니라 우리 데이터에서 ──
            for s in segs:
                s.t_start = sentences[s.start_idx]["t_start"]
                s.t_end = sentences[s.end_idx]["t_end"]
            _stitch(segs, total_duration)

            logger.info("STEP 4: 문장 %d개 → 구간 %d개", len(sentences), len(segs))
            return SegmentResult(segments=segs, warnings=warns, raw=resp.text)

        except Exception as exc:  # noqa: BLE001 — 재시도 대상
            last_err = exc
            logger.warning("STEP 4 시도 %d 실패: %s", attempt, exc)
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_WAIT_SEC)

    raise RuntimeError(f"STEP 4 구간 분리 실패 ({MAX_ATTEMPTS}회): {last_err}")
