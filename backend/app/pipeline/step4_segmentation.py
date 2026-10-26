"""
Step 4: 구간 분리 (LLM)

STT 문장들을 의미 단위로 묶어 발표 구간을 나눈다.

입력: stt_sentences (문장 + 시각), 발표 목차(선택)
출력: segments 행 (label / title / t_start / t_end)

목차가 있으면 **목차 항목을 라벨로** 쓴다 (기본 라벨 9종 대신). 순서는 강제하지 않고,
말하지 않은 항목은 빠져도 된다. 구간 수 상한은 발표 길이 대신 목차 항목 수를 따른다.
목차 어디에도 안 맞는 내용(예: 질의응답)이 **30초 이상** 이어질 때만 새 이름을 허용한다
(OUTLINE_NEW_LABEL_MIN_SEC). 그보다 짧으면 이웃 목차 항목에 흡수한다.

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

# 2026-10-23: Gemini(gemini-2.5-flash) → OpenAI gpt-4.1. STEP 5 피드백과 같은 모델·키를 쓴다.
MODEL = "gpt-4.1"

# ── 구간 크기 정책 ────────────────────────────────────────────────────────
# PPT 목차 수준의 **큰 덩어리**를 원한다. 세부 화제가 바뀔 때마다 자르면 구간이
# 잘게 부서져 회차 비교도, 구간별 피드백도 의미가 흐려진다.
#
# 두 겹으로 막는다:
#   1) 프롬프트에 발표 길이 기준 목표 개수 제시 (LLM 이 크게 묶도록)
#   2) 그래도 짧게 나오면 후처리로 이웃에 병합 (LLM 출력에 의존하지 않음)
#   3) 그래도 목표 개수보다 많으면 가장 짧은 구간부터 이웃에 병합
# 45초로 잡았더니 «주제소개 10초 → 배경설명 22초 → 문제제시 16초» 같은
# 정상적인 흐름까지 통째로 뭉개졌다.
# 2026-10-23: 5초 → 20초. 실측에서 «도입 0~5초 → 배경 10~35초» 처럼 몇 초짜리
# 도입이 따로 남았다. 20초 미만은 구간별 피드백을 줄 만한 분량이 아니라고 보고 흡수한다.
MIN_SEGMENT_SEC = 20.0

# 발표 길이별 구간 개수 (상한, 하한). 길어져도 너무 잘게 자르지 않도록 상한을 6 으로 묶는다.
#   (이 길이 미만이면, 최소 개수, 최대 개수) — 마지막 줄은 그 이상 전부
SEGMENT_COUNT_RULES = [
    (4 * 60, 2, 4),
    (7 * 60, 3, 6),
    (None, 4, 6),
]


def target_count(total_sec: float) -> tuple[int, int]:
    """발표 길이(초) → (최소, 최대) 구간 개수."""
    for limit, lo, hi in SEGMENT_COUNT_RULES:
        if limit is None or total_sec < limit:
            return lo, hi
    return SEGMENT_COUNT_RULES[-1][1:]

# 같은 라벨이 다시 나오면 사이에 낀 구간까지 하나로 합친다.
#   예: 한계 → 개념설명 → 한계  ⇒  하나의 «한계»
#   중간의 개념설명은 그 한계를 설명하려고 곁들인 것이지 독립 구간이 아니다.
# 다만 발표 앞뒤로 멀리 떨어진 동일 라벨까지 합치면 안 되므로 간격을 제한한다.
MAX_SANDWICH_GAP = 1       # 사이에 **하나만** 낀 경우만 병합 (과병합 방지)
MAX_MERGE_RATIO = 0.5      # 병합 결과가 전체 길이의 이 비율을 넘으면 보류 (거대 구간 방지)
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
# 2026-09-23: 12종 → 6종 축소. 실측에서 「배경설명→배경설명→주제소개」,
# 「결론→인사」처럼 **같은 이야기가 라벨만 달라 쪼개지는** 경우가 많았다.
# 2026-10-16: 6종 → 9종. 라벨이 없으니 발표의 중심인 개념·배경 설명까지 다른 라벨로
# 뭉개졌고, 기술 발표 외 분야(사례 중심 발표 등)를 담을 자리가 없었다.
# 다시 잘게 쪼개지지 않도록 「배경」「핵심개념」은 **발표 전체 주제에 대한 설명일 때만**
# 붙이게 하고(프롬프트 규칙 6), 짧으면 이웃에 흡수한다(STRICT_LABEL_MIN_SEC).
# 「주제 소개」는 따로 두지 않는다 — 대개 몇 문장이고 인사와 붙어 나와 쪼개짐의 원인이었다.
LABELS = [
    "도입",          # 인사, 자기소개, 주제·목차 안내
    "배경",          # 현황, 맥락, 필요성, 선행 사례 — 발표 전체 주제에 대한 것만
    "핵심개념",      # 발표 전체를 이해하는 데 필요한 개념·이론·용어 — 발표 전체 주제에 대한 것만
    "문제제시",      # 해결하려는 문제, 동기
    "해결방안",      # 제안하는 접근·방법 (원리, 시스템구조, 구현 포함)
    "사례",          # 사례 분석, 근거 자료 — 사례가 발표의 중심 내용일 때
    "시연",          # 데모, 화면 설명
    "결과",          # 성과, 수치, 실험 결과, 해석
    "마무리",        # 요약, 정리, 한계, 향후계획, 결론, 마무리 인사
]

# 쪼개짐 위험이 큰 라벨은 최소 길이를 따로 둔다. 이보다 짧으면 독립 구간으로 보지 않고
# 이웃 구간에 흡수하며, 라벨은 **이웃 쪽**을 따른다 (짧은 개념 설명 = 곁들인 설명).
STRICT_LABELS = {"배경", "핵심개념"}
STRICT_LABEL_MIN_SEC = 20.0   # 지금은 MIN_SEGMENT_SEC 와 같다. 더 엄격하게 하려면 이 값만 올린다

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
   예: 「해결방안」을 말하다가 그와 관련된 기술·용어를 설명했다면, 그 설명까지
   전체가 하나의 「해결방안」입니다. 설명이 끝나고 다시 원래 이야기로 돌아와도
   쪼개지 말고 하나로 두세요.
{label_rules}

## 출력 형식
아래 형식의 JSON 객체만 출력하세요. 설명이나 마크다운은 쓰지 마세요.

{{"segments": [
  {{"label": "라벨", "title": "이 구간을 한 줄로 요약(20자 이내)", "start": 0, "end": 4}},
  ...
]}}

## 전사문
{transcript}
"""


# 기본 모드(목차 없음)의 규칙 5~8 + 라벨 목록. {labels}·{minutes}·{lo}·{hi} 를 채워서 PROMPT 의 {label_rules} 에 넣는다.
DEFAULT_RULES = """5. 각 구간에 아래 라벨 중 **가장 가까운 것 하나**를 고르세요.
   순서는 정해져 있지 않고, 같은 라벨이 여러 번 나와도 됩니다.
   목록에 없는 라벨을 새로 만들지 마세요.
6. 「배경」「핵심개념」은 아래 두 조건을 **모두** 만족할 때만 쓰세요.
   - 발표 **전체 주제**에 대한 배경·개념이다. (특정 방법이나 결과를 말하다가 그 안에서
     쓰인 기술·용어를 설명하는 것은 해당하지 않습니다 — 규칙 4대로 그 구간에 포함)
   - 그 설명이 빠지면 **발표 전체**를 이해하기 어려워진다.
   조건이 애매하면 독립 구간으로 만들지 말고 앞뒤 구간에 포함시키세요.
7. 「사례」는 사례·근거 자료를 소개하는 것이 **발표의 중심 내용**일 때만 쓰세요.
   다른 내용을 뒷받침하려고 짧게 든 예시는 그 내용의 구간에 포함시키세요.
8. 이 발표는 약 {minutes}분입니다. 구간은 **{lo}~{hi}개**로 나누세요. 발표가 길어도
   {hi}개를 넘기지 말고, 20초가 안 되는 짧은 구간은 만들지 말고 앞뒤 구간에 포함시키세요.

## 라벨 목록
{labels}"""

# ── 목차 모드: 두 단계 ───────────────────────────────────────────────────────
# 1) OUTLINE_RULES — 목차는 참고만 하고, 실제 주제가 바뀌는 곳에서 나눈 뒤 label 에 실제 주제를 쓴다.
# 2) MAP_PROMPT    — 구간마다 "어느 목차 항목의 내용인가, 아니면 없음"만 따로 분류한다.
# 처음엔 한 번에 시켰더니(주제 판단 + 목차 매칭) topic 은 «엣지컴퓨팅 소개» 로 정확히 쓰면서
# label 은 앞 항목 «클라우드의 한계» 로 억지로 끼워 넣었고, 실행할 때마다 결과도 흔들렸다.
# 분류만 따로 물으면 끼워 맞추려는 경향이 줄어든다.
# "없음"이면 실제 주제를 새 라벨로 쓰되, 30초 미만이면 후처리(_absorb_off_outline)에서 이웃 목차 항목에 흡수한다.
OUTLINE_NEW_LABEL_MIN_SEC = 30.0

OUTLINE_RULES = """5. 발표자가 미리 정한 **목차**가 아래에 있습니다. 목차는 **참고용**입니다 — 구간 경계는
   목차가 아니라 **실제로 주제가 바뀌는 지점**으로 정하세요. 목차 순서대로 발표하지 않았을 수 있고,
   목차에 없는 내용이 있을 수도 있습니다.
6. label 에는 그 구간에서 **실제로 다룬 주제**를 10자 이내로 쓰세요. 그 주제가 목차 항목과
   같다면 목차 항목을 글자 그대로 쓰고, 목차에 없는 주제라면 목차에 맞추지 말고 실제 주제를 쓰세요.
7. 이 발표는 약 {minutes}분입니다. 20초가 안 되는 짧은 구간은 만들지 말고 앞뒤 구간에 포함시키세요.

## 목차 (참고용)
{labels}"""

MAP_PROMPT = """발표 구간 목록과 발표자가 미리 정한 목차가 있습니다.
각 구간이 **어느 목차 항목의 내용인지** 고르세요.

## 규칙
- 구간의 주제가 그 목차 항목이 말하는 내용 **그 자체(또는 그 일부)**일 때만 그 항목을 고르세요.
- 앞 항목에서 이어지는 이야기라도 주제가 다르면(예: 문제를 다 말한 뒤 해결책을 소개) 그 항목이 아닙니다.
- 어느 항목의 내용도 아니면 "없음"을 고르세요. "없음"은 정상적인 답입니다 — 억지로 맞추지 마세요.
- 목차 항목은 글자 그대로 쓰세요. 같은 항목을 여러 구간에 골라도 됩니다.

## 목차
{outline}

## 구간 (번호. 주제 — 요약 / 첫 문장)
{segments}

## 출력
구간 수만큼 순서대로, 아래 형식의 JSON 객체만 출력하세요.
{{"labels": ["목차 항목 또는 없음", ...]}}
"""


def _map_to_outline(client, items: list[dict], sentences: list[dict], outline: list[str]) -> list[str] | None:
    """2단계: 구간마다 목차 항목 또는 "없음". 실패하면 None (그러면 1단계 label 을 그대로 쓴다)."""
    lines = []
    for k, it in enumerate(items):
        try:
            first = sentences[max(0, min(int(it["start"]), len(sentences) - 1))]["text"][:60]
        except (KeyError, TypeError, ValueError):
            first = ""
        lines.append(f"{k + 1}. {it.get('label', '')} — {it.get('title', '')} / {first}")
    prompt = MAP_PROMPT.format(outline="\n".join(f"- {x}" for x in outline), segments="\n".join(lines))
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0,
        )
        labels = json.loads(resp.choices[0].message.content or "{}").get("labels")
        if isinstance(labels, list) and len(labels) == len(items):
            return [str(x).strip() for x in labels]
        logger.warning("STEP 4 목차 매칭: 개수 불일치 %s vs %d", labels, len(items))
    except Exception as exc:  # noqa: BLE001 — 매칭 실패는 치명적이지 않다
        logger.warning("STEP 4 목차 매칭 실패: %s", exc)
    return None


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


def _match_label(label: str, labels: list[str]) -> str | None:
    """목차 모드에서 LLM 이 라벨을 살짝 바꿔 쓴 경우(띄어쓰기·번호·괄호) 원래 항목으로 되돌린다."""
    if label in labels:
        return label
    key = lambda x: "".join(ch for ch in x.lower() if ch.isalnum())
    k = key(label)
    if not k:
        return None
    for cand in labels:
        if key(cand) == k:
            return cand
    for cand in labels:   # 한쪽이 다른 쪽을 포함 ("2. 해결 방법" ↔ "해결 방법")
        kc = key(cand)
        if kc and (kc in k or k in kc):
            return cand
    return None


def _repair(items: list[dict], n: int, labels: list[str] = LABELS,
            outline_mode: bool = False) -> tuple[list[Segment], list[str]]:
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
        if outline_mode:
            matched = None if label in ("", "없음") else _match_label(label, labels)
            if matched is None:
                # 목차 어느 항목에도 해당하지 않는 구간 → 실제 주제(topic)를 새 이름으로 (30초 이상일 때만 유지)
                label = (str(it.get("topic", "")).strip() or (label if label != "없음" else "") or "기타")[:30]   # segments.label 이 String(32)
                warns.append(f"목차 밖 구간 «{label}» (30초 이상일 때만 유지)")
            elif matched != label:
                warns.append(f"라벨 '{label}' → 목차 항목 «{matched}» 로 맞춤")
                label = matched
        elif label not in labels:
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


def _min_sec_for(seg, min_sec, strict_min_sec):
    return max(min_sec, strict_min_sec) if seg.label in STRICT_LABELS else min_sec


def _shorter_neighbor(segs, sentences, i: int) -> int:
    """i 번 구간과 합칠 이웃 — 더 짧은 쪽 (한쪽만 비대해지는 것을 막는다)."""
    if i == 0:
        return 1
    if i == len(segs) - 1:
        return i - 1
    return i - 1 if _dur(segs[i - 1], sentences) <= _dur(segs[i + 1], sentences) else i + 1


def _cap_count(segs, sentences, max_count: int):
    """구간이 목표 상한보다 많으면 가장 짧은 구간부터 이웃(더 짧은 쪽)에 합친다.

    라벨·제목은 **긴 쪽**을 따른다. LLM 이 개수 지침을 무시해도 여기서 막힌다.
    같은 라벨 병합의 MAX_MERGE_RATIO 는 여기서 보지 않는다 — 개수 상한이 우선이다.
    """
    warns = []
    while len(segs) > max(max_count, 1):
        short = min(range(len(segs)), key=lambda k: _dur(segs[k], sentences))
        other = _shorter_neighbor(segs, sentences, short)
        a, b = sorted((short, other))
        keep = segs[a] if _dur(segs[a], sentences) >= _dur(segs[b], sentences) else segs[b]
        merged = Segment(label=keep.label, title=keep.title,
                         start_idx=segs[a].start_idx, end_idx=segs[b].end_idx)
        warns.append(f"구간 수 상한({max_count}개) 초과 → {_dur(segs[short], sentences):.0f}초 구간 병합 → «{merged.label}»")
        segs = segs[:a] + [merged] + segs[b + 1:]
    return segs, warns


def _merge_short(segs, sentences, min_sec, strict_min_sec=STRICT_LABEL_MIN_SEC):
    """기준보다 짧은 구간을 이웃에 흡수. 라벨·제목은 **긴 쪽**을 따른다.

    기준은 보통 `min_sec`, STRICT_LABELS(배경·핵심개념)는 `strict_min_sec`.
    STRICT 라벨이 자기 기준에 못 미쳐 흡수될 때는 길이와 무관하게 **이웃 라벨**을 따른다
    — 짧은 개념 설명은 독립 구간이 아니라 이웃 이야기에 곁들인 설명으로 본다.

    LLM 이 지침을 무시하고 잘게 쪼개도 여기서 막힌다.
    """
    warns = []
    while len(segs) > 1:
        short = next((i for i, s in enumerate(segs)
                      if _dur(s, sentences) < _min_sec_for(s, min_sec, strict_min_sec)), None)
        if short is None:
            break
        other = _shorter_neighbor(segs, sentences, short)
        a, b = sorted((short, other))
        if _dur(segs[short], sentences) >= min_sec:
            keep = segs[other]   # STRICT 기준에만 걸린 경우 → 이웃 라벨
        else:
            keep = segs[a] if _dur(segs[a], sentences) >= _dur(segs[b], sentences) else segs[b]
        merged = Segment(label=keep.label, title=keep.title,
                         start_idx=segs[a].start_idx, end_idx=segs[b].end_idx)
        warns.append(f"짧은 구간({_dur(segs[short], sentences):.0f}초) 병합 → «{merged.label}»")
        segs = segs[:a] + [merged] + segs[b + 1:]
    return segs, warns


def _merge_same_label(segs, sentences, max_gap: int, max_ratio: float):
    """같은 라벨이 인접하거나 되돌아오면 하나로 합친다.

    두 경우를 함께 다룬다:
      - **인접**   «도입 → 도입»                 — 같은 이야기를 LLM 이 그냥 쪼갠 것
      - **샌드위치** «해결방안 → 용어설명 → 해결방안» — 사이에 낀 것은 앞뒤를 설명하려고
        곁들인 경우가 대부분

    `while changed` 루프라 인접 병합이 샌드위치를 새로 만들면 그것까지 연쇄로 잡는다.
    실측(521초 강연): 라벨 축소 전 «주제소개 → 배경설명 → 배경설명 → 주제소개» 4조각이
    인접 병합 → 샌드위치 연쇄로 하나가 됨. 축소 후에는 넷 다 «도입» 이라 인접 병합만으로
    정리된다.

    ⚠️ `max_ratio` — 병합 결과가 전체 길이의 이 비율을 넘으면 **보류**한다.
    같은 라벨이라도 «방법 1 / 방법 2» 처럼 병렬 구조인 경우가 있어, 무조건 합치면
    발표의 대부분이 한 구간이 되어 구간별 피드백이 뭉개진다.
    """
    warns = []
    total = sentences[-1]["t_end"] - sentences[0]["t_start"]
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i in range(len(segs) - 1):
            # j = i+1 이면 인접, i+2 이상이면 사이에 낀 것이 있는 샌드위치
            for j in range(i + 1, min(i + 2 + max_gap, len(segs))):
                if segs[i].label != segs[j].label:
                    continue
                merged = Segment(label=segs[i].label, title=segs[i].title,
                                 start_idx=segs[i].start_idx, end_idx=segs[j].end_idx)
                if total > 0 and _dur(merged, sentences) / total > max_ratio:
                    warns.append(
                        f"«{segs[i].label}» 병합 보류 — 결과가 전체의 "
                        f"{_dur(merged, sentences) / total:.0%} (상한 {max_ratio:.0%})")
                    continue
                inner = [x.label for x in segs[i + 1:j]]
                warns.append(
                    f"인접한 «{merged.label}» 병합" if not inner else
                    f"«{segs[i].label}» 사이에 낀 {'·'.join(inner)} 흡수 → 하나의 «{merged.label}»")
                segs = segs[:i] + [merged] + segs[j + 1:]
                changed = True
                break
            if changed:
                break
    return segs, warns


def _absorb_off_outline(segs, sentences, outline: list[str], min_sec: float):
    """목차에 없는 라벨인데 min_sec 보다 짧은 구간은 이웃(더 짧은 쪽) 목차 항목에 흡수한다.

    LLM 에게 "30초 이상일 때만 새 이름"이라고 했지만 지키지 않을 수 있어 여기서 확실히 막는다.
    흡수할 때 라벨·제목은 이웃 쪽을 따른다 (짧은 곁가지 = 앞뒤 이야기의 일부).
    """
    warns = []
    while len(segs) > 1:
        i = next((k for k, s in enumerate(segs)
                  if s.label not in outline and _dur(s, sentences) < min_sec), None)
        if i is None:
            break
        other = _shorter_neighbor(segs, sentences, i)
        a, b = sorted((i, other))
        keep = segs[other]
        merged = Segment(label=keep.label, title=keep.title,
                         start_idx=segs[a].start_idx, end_idx=segs[b].end_idx)
        warns.append(f"목차에 없는 짧은 구간 «{segs[i].label}»({_dur(segs[i], sentences):.0f}초) → «{keep.label}» 에 흡수")
        segs = segs[:a] + [merged] + segs[b + 1:]
    return segs, warns


def _merge_adjacent(segs):
    """바로 붙어 있는 같은 라벨을 길이 제한 없이 합친다 (목차 모드 전용).

    목차 항목은 발표자가 정한 한 덩어리라, «클라우드 → 클라우드» 처럼 이어지면 하나여야 한다.
    _merge_same_label 의 MAX_MERGE_RATIO(거대 구간 방지)는 기본 라벨용 안전장치라 여기선 쓰지 않는다.
    """
    warns, out = [], []
    for seg in segs:
        if out and out[-1].label == seg.label:
            prev = out[-1]
            out[-1] = Segment(label=prev.label, title=prev.title,
                              start_idx=prev.start_idx, end_idx=seg.end_idx)
            warns.append(f"이어진 목차 항목 «{seg.label}» 병합")
        else:
            out.append(seg)
    return out, warns


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
        on_progress=None, outline: list[str] | None = None) -> SegmentResult:
    """문장 목록 → 구간. sentences 는 stt_sentences 형식(text/t_start/t_end).

    outline: 발표자가 입력한 목차. 있으면 그 항목을 라벨로 쓰고, 구간 수 상한은 항목 수 + 2
    (같은 항목 반복·목차 밖 긴 내용 여유). 하한은 두지 않는다 — 말하지 않은 항목은 빠질 수 있다.
    """
    from openai import OpenAI

    from app.core.config import settings

    if not sentences:
        return SegmentResult(warnings=["문장이 없음"])

    # 환경변수는 settings 로 접근한다 (docs/CLAUDE.md 규칙).
    # os.getenv + load_dotenv 조합은 호출 위치에 따라 .env 를 못 찾는 경우가 있다 —
    # load_dotenv() 는 cwd 가 아니라 **호출한 파일 위치**에서 거슬러 올라가며 찾는다.
    api_key = settings.openai_api_key
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY 없음 (.env 확인)")

    total_sec = total_duration or (sentences[-1]["t_end"] - sentences[0]["t_start"])
    minutes = max(1, round(total_sec / 60))
    outline = [x for x in (outline or []) if x]
    if outline:
        labels, lo, hi = outline, 1, len(outline) + 2
        rules = OUTLINE_RULES.format(labels="\n".join(f"- {x}" for x in labels), minutes=minutes)
    else:
        labels = LABELS
        lo, hi = target_count(total_sec)
        rules = DEFAULT_RULES.format(labels="\n".join(f"- {x}" for x in labels),
                                     minutes=minutes, lo=lo, hi=hi)
    prompt = PROMPT.format(label_rules=rules, transcript=build_transcript(sentences))
    client = OpenAI(api_key=api_key)

    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if on_progress:
            on_progress("llm", f"구간 분리 요청 ({attempt}/{MAX_ATTEMPTS})")
        try:
            # response_format=json_object 는 최상위가 객체여야 해서 {"segments": [...]} 로 받는다
            # (프롬프트에 "JSON" 단어가 있어야 함)
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=0.2,     # 분류 작업이라 낮게
            )
            raw = resp.choices[0].message.content or ""
            data = json.loads(raw)
            items = data.get("segments") if isinstance(data, dict) else data
            if not isinstance(items, list):
                raise ValueError(f"segments 배열이 없음: {raw[:200]}")
            if outline:
                # 2단계: 1단계 label(실제 주제)을 topic 으로 옮기고, 목차 항목 또는 "없음"으로 다시 분류
                items = [it for it in items if isinstance(it, dict)]
                mapped = _map_to_outline(client, items, sentences, outline)
                for it, lab in zip(items, mapped or [None] * len(items)):
                    it["topic"] = str(it.get("label", "")).strip()
                    if lab is not None:
                        it["label"] = lab
            segs, warns = _repair(items, len(sentences), labels, outline_mode=bool(outline))
            if not segs:
                raise ValueError("유효 구간 0개")
            if outline:
                segs, owarns = _absorb_off_outline(segs, sentences, outline, OUTLINE_NEW_LABEL_MIN_SEC)
                warns += owarns
            # 순서 주의: 같은 라벨을 먼저 합쳐야 짧은 구간 병합이 엉뚱한 이웃을 안 고른다
            segs, swarns = _merge_same_label(segs, sentences,
                                             MAX_SANDWICH_GAP, MAX_MERGE_RATIO)
            segs, mwarns = _merge_short(segs, sentences, MIN_SEGMENT_SEC)
            segs, cwarns = _cap_count(segs, sentences, hi)
            warns += swarns + mwarns + cwarns
            if outline:   # 병합 과정에서 같은 항목이 다시 붙을 수 있어 마지막에 한 번 더
                segs, awarns = _merge_adjacent(segs)
                warns += awarns
            if len(segs) < lo:
                warns.append(f"구간 {len(segs)}개 — 목표 {lo}~{hi}개보다 적음 (내용상 더 나누지 않음)")

            # ── 시각 매핑: LLM 이 아니라 우리 데이터에서 ──
            for s in segs:
                s.t_start = sentences[s.start_idx]["t_start"]
                s.t_end = sentences[s.end_idx]["t_end"]
            _stitch(segs, total_duration)

            logger.info("STEP 4: 문장 %d개 → 구간 %d개", len(sentences), len(segs))
            return SegmentResult(segments=segs, warnings=warns, raw=raw)

        except Exception as exc:  # noqa: BLE001 — 재시도 대상
            last_err = exc
            logger.warning("STEP 4 시도 %d 실패: %s", attempt, exc)
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_WAIT_SEC)

    raise RuntimeError(f"STEP 4 구간 분리 실패 ({MAX_ATTEMPTS}회): {last_err}")
