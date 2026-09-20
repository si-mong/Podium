"""STEP 3 임계값 설정 — 파일에 저장해 실행 간 유지.

지금까지 임계값은 모듈 상수로만 존재해서 UI 슬라이더는 **화면에서만** 재계산했다.
튜닝한 값이 실제 분석에 반영되지 않아 매번 코드를 고쳐야 했음.
이 모듈이 단일 저장소 역할을 하고, 분석은 항상 여기서 읽는다.

    기본값(코드 상수) → thresholds.json(사용자 저장) → 분석 시 적용

파이프라인 통합 시에도 같은 파일을 읽으므로, 개발용 UI 에서 맞춘 값이
본 파이프라인에 그대로 적용된다.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.pipeline.voice import filler as filler_mod
from app.pipeline.voice import vad as vad_mod

CONFIG_PATH = Path(__file__).parent / "thresholds.json"

# 키 → (코드 기본값, 설명, 최소, 최대, 스텝)
SPEC: dict[str, tuple] = {
    "min_silence_sec":      (vad_mod.MIN_SILENCE_SEC,          "무음 최소 길이(초)",   0.3,  5.0, 0.1),
    "min_candidate_sec":    (filler_mod.MIN_CANDIDATE_SEC,     "필러 최소 길이(초)",   0.02, 1.0, 0.01),
    "max_candidate_sec":    (filler_mod.MAX_CANDIDATE_SEC,     "필러 최대 길이(초)",   0.5,  6.0, 0.1),
    "min_relative_db":      (filler_mod.MIN_RELATIVE_DB,       "최소 상대dB",         -40.0, 0.0, 1.0),
    "min_voiced_ratio":     (filler_mod.MIN_VOICED_RATIO,      "최소 유성비",          0.0,  1.0, 0.05),
    "max_f0_std_semitone":  (filler_mod.MAX_F0_STD_SEMITONE,   "최대 F0편차(반음)",    0.3,  6.0, 0.1),
}

DEFAULTS: dict[str, float] = {k: v[0] for k, v in SPEC.items()}


def load() -> dict[str, float]:
    """저장된 값 + 기본값. 파일이 없거나 깨져도 기본값으로 동작."""
    values = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            values.update({k: float(v) for k, v in saved.items() if k in DEFAULTS})
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            pass   # 깨진 설정은 무시하고 기본값 사용
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
    CONFIG_PATH.write_text(json.dumps(current, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    return current


def reset() -> dict[str, float]:
    CONFIG_PATH.unlink(missing_ok=True)
    return dict(DEFAULTS)


def ui_spec() -> list[dict]:
    """UI 슬라이더 렌더링용 메타데이터."""
    values = load()
    return [
        {"key": k, "label": lab, "min": lo, "max": hi, "step": st,
         "value": values[k], "default": dflt}
        for k, (dflt, lab, lo, hi, st) in SPEC.items()
    ]
