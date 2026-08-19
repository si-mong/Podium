"""STEP 3 PoC CLI.

    # 무음 지표만 (STT 없이 즉시)
    python -m stt_test run uploads/2/full_audio.wav --skip-stt

    # 전체 (STT 포함). 첫 실행은 모델 다운로드로 시간이 걸림
    python -m stt_test run uploads/2/full_audio.wav --model small
    python -m stt_test run uploads/2/full_audio.wav --model large-v3

    # 라벨링 후 성능 측정
    python -m stt_test eval stt_test/out/full_audio
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from stt_test.analyze import analyze
from stt_test.evaluate import check_fixture, evaluate
from stt_test.report import build_report

DEFAULT_OUT = Path(__file__).parent / "out"


def _cmd_run(args: argparse.Namespace) -> None:
    wav = Path(args.wav)
    out_dir = Path(args.out) if args.out else DEFAULT_OUT / wav.parent.name

    result = analyze(
        wav,
        model_size=args.model,
        language=args.language,
        verbatim_prompt=args.verbatim_prompt,
        skip_stt=args.skip_stt,
        ablate_lexical=args.ablate_lexical,
    )

    print(f"\n=== {wav} ===")
    for k, v in result["metrics"].items():
        print(f"  {k:24} {v}")

    cands = result["diagnostics"]["candidates"]
    accepted = [c for c in cands if c["is_filler"]]
    print(f"\n  필러 후보 {len(cands)}건 → 채택 {len(accepted)}건")
    reasons: dict[str, int] = {}
    for c in cands:
        if c["reject_reason"]:
            reasons[c["reject_reason"]] = reasons.get(c["reject_reason"], 0) + 1
    for r, n in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f"    기각 {r:14} {n}")
    print(f"  소요: {result['diagnostics']['elapsed']}")

    if args.json:
        print(json.dumps(result["voice_raw"], ensure_ascii=False, indent=2))

    truth = wav.with_suffix(".truth.json")
    if truth.exists():
        check_fixture(result, truth)

    if not args.no_report:
        html = build_report(result, wav, out_dir)
        print(f"\n  리포트: {html}")
        print(f"  열기:   open {html}")
        print(f"  (클립이 안 들리면) cd {out_dir} && python -m http.server 8123")


def _cmd_eval(args: argparse.Namespace) -> None:
    evaluate(Path(args.out_dir), sweep=not args.no_sweep)


def main() -> None:
    p = argparse.ArgumentParser(prog="stt_test", description="Podium STEP 3 음성분석 PoC")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="분석 실행 + 검증 리포트 생성")
    r.add_argument("wav", help="full_audio.wav 경로")
    r.add_argument("--model", default="large-v3", help="faster-whisper 모델 (기본 large-v3, 빠른 반복은 small)")
    r.add_argument("--language", default="ko")
    r.add_argument("--skip-stt", action="store_true", help="3-1 무음 지표만 (STT 생략)")
    r.add_argument("--verbatim-prompt", action="store_true", help="필러 유도 프롬프트 A/B 테스트")
    r.add_argument("--ablate-lexical", action="store_true",
                   help="STT 가 필러를 지우는 상황 시뮬레이션 — 음향 경로만으로 검출")
    r.add_argument("--out", help="출력 디렉터리")
    r.add_argument("--no-report", action="store_true")
    r.add_argument("--json", action="store_true", help="voice_raw dict 출력")
    r.set_defaults(func=_cmd_run)

    e = sub.add_parser("eval", help="labels.json 대비 성능 측정 + 임계값 스윕")
    e.add_argument("out_dir", help="run 이 만든 출력 디렉터리")
    e.add_argument("--no-sweep", action="store_true")
    e.set_defaults(func=_cmd_eval)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
