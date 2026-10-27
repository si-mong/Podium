"""두 회차 AI 비교 피드백 (비교 분석 ③ 피드백 이행 추적).

지난 회차에 받은 개선점이 이번 회차에서 해결됐는지, 여전한지, 새로 생긴 문제가 있는지를 GPT 가 판정한다.
**숫자는 코드가 계산해서(app/services/compare.py) 넣고 GPT 는 해석만** 한다 — 수치를 지어내지 않게.
"좋아짐/비슷함/나빠짐" 판정도 코드가 미리 해서 넣는다 (작은 변화를 "개선"이라 부르지 않도록).

회차마다 시각이 달라서 시각(M:SS)은 쓰지 않게 하고, 결과에 시각이 있으면 STEP5 와 같은 검증으로
다시 요청하거나 그 문장을 뺀다 (허용 시각 = 없음).
"""
from __future__ import annotations

import json

from app.pipeline.step5_feedback import MODEL, _generate_validated, _make_client

STATUSES = ("resolved", "improved", "persists", "new")
MAX_ITEMS = 8

_VERDICT_KO = {"improved": "좋아짐", "same": "비슷함", "worse": "나빠짐", None: "판정 없음"}
_LABEL_STATUS_KO = {"both": "두 회차 모두 있음", "only_base": "이번 회차에는 없음", "only_target": "이번 회차에 새로 생김"}

PROMPT = """당신은 발표 코칭 전문가입니다.
같은 발표를 연습한 두 회차(이전 회차 → 이번 회차)의 분석 결과를 비교해서, 이전 회차에 받은 개선점을
이번 회차에서 고쳤는지 판정하세요.

## 지침
1. 판정 항목(items)의 status 는 아래 넷 중 하나입니다.
   - resolved : 이전 회차 피드백(previous_feedback)에서 지적된 문제가 이번 회차에서 고쳐짐
   - persists : 이전 회차에서 지적된 문제가 이번 회차에도 여전함
   - improved : 이전에 지적되진 않았지만 이번 회차에서 지표가 좋아진 점
   - new      : 이번 회차에 새로 생기거나 나빠진 문제
   resolved / persists 는 반드시 previous_feedback 에 실제로 있던 지적이어야 하고, 그 지적을 짧게 줄여
   previous 에 쓰세요. improved / new 는 previous 를 null 로 두세요.
2. 고쳐졌는지는 metrics(전체 지표)와 labels(같은 구간끼리 지표), 그리고 이번 회차 피드백(current_feedback)을
   근거로 판단하세요. 이번 회차 피드백에도 같은 지적이 또 있으면 persists 입니다.
   근거가 데이터에 없으면 그 항목은 쓰지 마세요.
3. 지표의 "판정"(좋아짐/비슷함/나빠짐)은 코드가 허용 오차를 고려해 미리 정한 값입니다. **그대로 따르세요.**
   "비슷함"인 지표를 좋아졌다거나 나빠졌다고 쓰지 마세요. "판정 없음" 지표는 좋고 나쁨을 말하지 마세요.
4. detail 에는 근거 숫자를 데이터 값 그대로 쓰세요. 예: "필러가 분당 3.2회에서 1.1회로 줄었어요."
   숫자를 계산하거나 지어내지 마세요. 회차마다 발표 길이가 달라서 횟수보다 **분당 횟수**를 우선 쓰세요.
   구간을 짚을 때는 라벨 이름(예: "도입", "해결방안")으로 짚으세요.
5. **시각(0:12 같은 M:SS)은 쓰지 마세요.** 두 회차의 시각이 달라 비교에 의미가 없습니다.
6. 느낌·감상 표현(신뢰감, 인상적, 자연스러운 등)을 쓰지 말고, 관찰된 변화와 다음 연습에서 할 행동을 쓰세요.
   persists / new 항목의 detail 에는 다음 연습에서 할 구체적인 행동을 한 문장 넣으세요.
7. 항목은 3~6개. 나아진 쪽(resolved/improved)과 남은 쪽(persists/new)이 둘 다 있으면 양쪽 모두 쓰세요.
   같은 내용을 두 번 쓰지 마세요.
8. headline 은 두 회차 사이 가장 큰 변화를 담은 한 문장(약 25~40자). 예: "필러는 확 줄었지만, 결과 구간 시선 처리는 여전해요"
9. filler_per_min 같은 영문 데이터 이름은 쓰지 말고 "필러", "무음 비율"처럼 읽는 말로 쓰세요.
   문장은 "~했어요", "~하세요"처럼 부드러운 존댓말로 쓰세요.

## 출력 형식 (JSON, 다른 텍스트 없이)
{{
  "headline": "한 문장",
  "items": [
    {{"status": "resolved", "title": "15자 이내 항목 이름", "previous": "이전 지적 요약 또는 null", "detail": "근거 숫자를 담은 1~2문장"}}
  ]
}}

## metrics (전체 지표: 이전 회차 → 이번 회차)
{metrics}

## labels (같은 구간끼리 비교)
{labels}

## previous_feedback (이전 회차가 받은 피드백)
{previous}

## current_feedback (이번 회차가 받은 피드백)
{current}
"""


def _fmt(value, unit: str) -> str | None:
    if value is None:
        return None
    if unit == "%":
        return f"{round(value * 100, 1)}%"
    if unit == "초":
        return f"{int(value) // 60}분 {int(value) % 60}초"
    return f"{value}{unit}"


def _metric_rows(metrics: list[dict]) -> list[dict]:
    rows = []
    for m in metrics:
        row = {"지표": m["label"], "이전": _fmt(m["base"], m["unit"]), "이번": _fmt(m["target"], m["unit"]),
               "판정": _VERDICT_KO[m["verdict"]]}
        if m.get("base_count") is not None or m.get("target_count") is not None:
            row["횟수"] = f"{m.get('base_count')}회 → {m.get('target_count')}회"
        rows.append(row)
    return rows


def _sanitize_items(raw) -> dict:
    """형식이 어긋난 항목은 버린다 (status 가 넷 중 하나가 아니거나 detail 이 없으면)."""
    items = []
    for it in (raw.get("items") or [])[:MAX_ITEMS]:
        if not isinstance(it, dict) or it.get("status") not in STATUSES or not it.get("detail"):
            continue
        prev = it.get("previous") if it["status"] in ("resolved", "persists") else None
        items.append({"status": it["status"], "title": str(it.get("title") or "").strip()[:40],
                      "previous": str(prev).strip() if prev else None, "detail": str(it["detail"]).strip()})
    return {"headline": str(raw.get("headline") or "").strip() or None, "items": items}


def run(metrics: list[dict], labels: list[dict], previous: dict, current: dict) -> dict:
    """반환: {"headline": str|None, "items": [{status, title, previous, detail}], "model": MODEL}"""
    label_rows = [{"구간": l["label"], "상태": _LABEL_STATUS_KO[l["status"]], "지표": _metric_rows(l["metrics"])}
                  for l in labels]
    dump = lambda o: json.dumps(o, ensure_ascii=False, indent=1)  # noqa: E731
    prompt = PROMPT.format(metrics=dump(_metric_rows(metrics)), labels=dump(label_rows),
                           previous=dump(previous), current=dump(current))
    raw = _generate_validated(_make_client(), prompt, set(), "비교 피드백")
    return {**_sanitize_items(raw), "model": MODEL}
