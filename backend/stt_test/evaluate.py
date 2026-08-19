"""라벨 대비 3-3 성능 측정 + 임계값 스윕.

report.html 에서 내려받은 labels.json 과 result.json 을 물려서:
  1) 현재 임계값의 precision/recall/F1
  2) 임계값을 훑어서 F1 이 가장 높은 조합 탐색

⚠️ recall 의 한계
    여기서 재는 recall 은 "**후보로 제안된 것들 중**" 놓친 비율임.
    VAD∧¬STT 가 애초에 제안조차 안 한 필러(예: STT 가 필러를 일반 단어로
    잘못 인식해 빈틈이 안 생긴 경우)는 분모에 안 들어감.
    진짜 recall 을 재려면 오디오를 처음부터 독립적으로 라벨링해야 함.
    → 1차 판단은 precision 위주로, recall 은 참고치로 볼 것.
"""
from __future__ import annotations

import json
from itertools import product
from pathlib import Path

from stt_test.filler import (
    MAX_F0_STD_SEMITONE,
    MIN_RELATIVE_DB,
    MIN_VOICED_RATIO,
)


def _load(out_dir: Path) -> tuple[list[dict], dict[int, str]]:
    result = json.loads((out_dir / "result.json").read_text(encoding="utf-8"))
    cands = result["diagnostics"]["candidates"]
    labels_path = out_dir / "labels.json"
    if not labels_path.exists():
        raise SystemExit(
            f"{labels_path} 없음. report.html 에서 라벨을 찍고 "
            f"'라벨 JSON 내려받기' 로 저장한 뒤 이 디렉터리에 두세요."
        )
    rows = json.loads(labels_path.read_text(encoding="utf-8"))
    labels = {r["index"]: r["label"] for r in rows if r.get("label") in ("y", "n")}
    return cands, labels


def _score(cands: list[dict], labels: dict[int, str], predict) -> dict:
    tp = fp = fn = tn = 0
    for c in cands:
        truth = labels.get(c["index"])
        if truth is None:
            continue
        pred = predict(c)
        if pred and truth == "y":
            tp += 1
        elif pred and truth == "n":
            fp += 1
        elif not pred and truth == "y":
            fn += 1
        else:
            tn += 1
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3)}


def evaluate(out_dir: Path, sweep: bool = True) -> dict:
    cands, labels = _load(out_dir)
    if not labels:
        raise SystemExit("라벨이 비어 있음 (필러/아님을 하나도 안 찍음).")

    report: dict = {
        "labeled": len(labels),
        "current": _score(cands, labels, lambda c: c["is_filler"]),
    }
    print(f"라벨 {len(labels)}건")
    print(f"현재 임계값: {report['current']}")

    if not sweep:
        return report

    # 어휘 기반 후보는 음향 임계값과 무관하므로 스윕에서 제외하고 별도 집계.
    acoustic = [c for c in cands if c["source"] == "acoustic"]
    lexical = [c for c in cands if c["source"] == "lexical"]
    if lexical:
        report["lexical_only"] = _score(lexical, labels, lambda c: True)
        print(f"어휘 기반만: {report['lexical_only']}")

    best = None
    db_grid = [-24, -21, -18, -15, -12, -9]
    voiced_grid = [0.3, 0.4, 0.45, 0.5, 0.6, 0.7]
    f0_grid = [0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]

    for db, vr, f0 in product(db_grid, voiced_grid, f0_grid):
        def predict(c, db=db, vr=vr, f0=f0):
            return (
                c["duration"] >= 0.20
                and c["relative_db"] >= db
                and c.get("voiced_ratio", 0) >= vr
                and c.get("f0_std_semitone", 99) <= f0
            )
        s = _score(acoustic, labels, predict)
        if best is None or s["f1"] > best[0]["f1"]:
            best = (s, {"MIN_RELATIVE_DB": db, "MIN_VOICED_RATIO": vr,
                        "MAX_F0_STD_SEMITONE": f0})

    if best:
        report["best_sweep"] = {"score": best[0], "thresholds": best[1]}
        print("\n임계값 스윕 최적 (음향 후보만):")
        print(f"  {best[1]}")
        print(f"  {best[0]}")
        print(f"\n현재값: MIN_RELATIVE_DB={MIN_RELATIVE_DB}, "
              f"MIN_VOICED_RATIO={MIN_VOICED_RATIO}, "
              f"MAX_F0_STD_SEMITONE={MAX_F0_STD_SEMITONE}")
    return report


# ---------------------------------------------------------------------------
# 합성 픽스처 자동 채점
# ---------------------------------------------------------------------------

def _overlaps(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def check_fixture(result: dict, truth_path: Path) -> dict:
    """make_fixture 로 만든 정답과 검출 결과를 자동 대조.

    주입 구간과 겹치는 확정 필러가 하나라도 있으면 검출된 것으로 봄.
    어느 주입과도 겹치지 않는 확정 필러는 spurious(허위 검출) 로 집계.
    """
    truth = json.loads(truth_path.read_text(encoding="utf-8"))
    accepted = [c for c in result["diagnostics"]["candidates"] if c["is_filler"]]
    speech = result["diagnostics"]["speech_regions"]

    rows, tp, fn, fp = [], 0, 0, 0
    matched: set[int] = set()

    for inj in truth["injections"]:
        hits = [
            (i, c) for i, c in enumerate(accepted)
            if _overlaps(inj["t_start"], inj["t_end"], c["t_start"], c["t_end"]) > 0
        ]
        matched.update(i for i, _ in hits)
        detected = bool(hits)
        # 3-3 의 전제조건: VAD 가 이 구간을 발화로 인정했는가
        vad_cov = sum(
            _overlaps(inj["t_start"], inj["t_end"], s["t_start"], s["t_end"]) for s in speech
        ) / max(1e-9, inj["t_end"] - inj["t_start"])

        ok = detected == inj["expect_filler"]
        if inj["expect_filler"]:
            tp += detected
            fn += not detected
        else:
            fp += detected
        rows.append({
            "kind": inj["kind"],
            "text": inj["text"],
            "t_start": inj["t_start"],
            "expect": inj["expect_filler"],
            "detected": detected,
            "vad_coverage": round(vad_cov, 2),
            "via": hits[0][1]["source"] if hits else None,
            "pass": ok,
        })

    spurious = [c for i, c in enumerate(accepted) if i not in matched]
    fp += len(spurious)

    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0

    print(f"\n=== 합성 픽스처 채점 ({truth_path.name}) ===")
    print(f"  {'종류':<8} {'텍스트':<8} {'시각':>7}  {'VAD인정':>7}  {'기대':>5} {'검출':>5}  경로     결과")
    for r in rows:
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"  {r['kind']:<8} {(r['text'] or '-'):<8} {r['t_start']:7.2f}  "
              f"{r['vad_coverage']*100:6.0f}%  {str(r['expect']):>5} {str(r['detected']):>5}  "
              f"{(r['via'] or '-'):<8} {mark}")
    if spurious:
        print(f"\n  허위 검출 {len(spurious)}건:")
        for c in spurious:
            print(f"    {c['t_start']:6.2f}-{c['t_end']:6.2f} d={c['duration']:.2f} "
                  f"vr={c.get('voiced_ratio')} f0sd={c.get('f0_std_semitone')} "
                  f"ctx={c.get('context_text','')[:40]}")
    print(f"\n  TP={tp} FN={fn} FP={fp}  precision={prec:.2f} recall={rec:.2f}")

    return {"rows": rows, "tp": tp, "fn": fn, "fp": fp,
            "precision": round(prec, 3), "recall": round(rec, 3),
            "spurious": spurious}
