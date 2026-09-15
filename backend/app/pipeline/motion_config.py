"""STEP 2 스마트 청킹 임계값 저장소.

STEP 3 의 `voice/config.py` 와 같은 역할. 임계값이 코드 상수로만 있으면
개발 도구(`/vlm/smart-preview/history`)에서 슬라이더로 아무리 맞춰봐야
**본 파이프라인에는 반영되지 않는다.** 이 모듈이 단일 저장소가 되고
`step2_chunking` 은 항상 여기서 읽는다.

    기본값(코드 상수) → motion_thresholds.json(사용자 저장) → 분석 시 적용
"""
from __future__ import annotations

import json
from pathlib import Path

CONFIG_PATH = Path(__file__).parent / "motion_thresholds.json"

# 키 → (기본값, 설명, 최소, 최대, 스텝)
# 기본값은 step2_chunking 의 코드 상수와 일치시킬 것.
SPEC: dict[str, tuple] = {
    "motion_thresh":     (3.5,  "motion 임계값",      0.0, 20.0, 0.1),
    "hysteresis_frames": (5,    "hysteresis (샘플)",  1,   20,   1),
    "chunk_duration":    (20.0, "청크 길이(초)",       10,  60,   5),
}

DEFAULTS: dict[str, float] = {k: v[0] for k, v in SPEC.items()}


def load() -> dict[str, float]:
    values = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            values.update({k: float(v) for k, v in saved.items() if k in DEFAULTS})
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            pass   # 깨진 설정은 무시하고 기본값 사용
    values["hysteresis_frames"] = int(values["hysteresis_frames"])
    return values


def save(values: dict) -> dict[str, float]:
    """알려진 키만, 허용 범위로 잘라서 저장."""
    current = load()
    for k, v in values.items():
        if k not in SPEC:
            continue
        _, _, lo, hi, _ = SPEC[k]
        try:
            current[k] = min(hi, max(lo, float(v)))
        except (TypeError, ValueError):
            continue
    current["hysteresis_frames"] = int(current["hysteresis_frames"])
    CONFIG_PATH.write_text(json.dumps(current, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    return current


def reset() -> dict[str, float]:
    CONFIG_PATH.unlink(missing_ok=True)
    return dict(DEFAULTS)


def ui_spec() -> list[dict]:
    values = load()
    return [
        {"key": k, "label": lab, "min": lo, "max": hi, "step": st,
         "value": values[k], "default": dflt}
        for k, (dflt, lab, lo, hi, st) in SPEC.items()
    ]
