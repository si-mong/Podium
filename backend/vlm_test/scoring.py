"""청크별 경량 스코어 계산 + VLM 호출 정책 판정.

VLM(Gemini) 호출은 청크당 5~30초 + 비용이 들기 때문에, 의미 없는 청크는
호출 전에 걸러야 함. 이 모듈은 두 단계를 담당:

  1) 청크별 스코어 계산 — motion_score (OpenCV) + audio_db (ffmpeg)
  2) 스코어 기반 KEEP/SKIP 판정 — classify_chunks

정책 설계 배경 (각 시도와 약점):
  - 단순 절대 임계값:  영상마다 적정 임계값이 달라 매번 튜닝 필요.
  - 분포 기반 (하위 N%): 동적 영상에서도 25%를 강제로 버려서 정보 손실.
  - 시계열 변화만:     활발한 동작이 계속되는 영상에서 변화가 작아 SKIP되어
                       fidgeting/emphasizing 같은 구분을 못 함.

→ 최종 정책: "절대값으로 정적/동적 구분 + 정적 청크 구간에만 시계열 압축"
  - 동적 청크는 무조건 KEEP (활발한 동작 자체가 분석 가치)
  - 정적 청크는 첫 한 개만 KEEP, 같은 정적 상태가 이어지면 SKIP
  - 시작/끝 청크와 너무 길게 정적이 이어지면 강제 KEEP (안전장치)
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2

# ---------------------------------------------------------------------------
# 스코어 계산
# ---------------------------------------------------------------------------

# 청크 안에서 비교할 초당 프레임 수. 원본이 30fps여도 5fps로만 비교 → 매우 가벼움.
# 사람의 동작은 5Hz면 충분히 잡힘 (인간 시각 인지 임계 ~10Hz).
SAMPLE_FPS = 5

# ffmpeg volumedetect 출력에서 mean_volume 추출 (예: "mean_volume: -23.5 dB")
_VOL_RE = re.compile(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB")


@dataclass
class ChunkScore:
    idx: int
    name: str
    duration_sec: float
    motion_score: float       # 0~수십. 일반 발표 영상은 0.5~15 범위
    audio_db: float | None    # -inf~0. None 이면 측정 실패

    def to_dict(self) -> dict:
        return {
            "idx": self.idx,
            "name": self.name,
            "duration_sec": round(self.duration_sec, 2),
            "motion_score": round(self.motion_score, 3),
            "audio_db": None if self.audio_db is None else round(self.audio_db, 2),
        }


def motion_score(chunk_path: Path, sample_fps: int = SAMPLE_FPS) -> float:
    """청크 내에서 연속 프레임 간 픽셀 차이의 평균.

    구체:
      - 그레이스케일 변환으로 색상/조명 변화 영향 최소화
      - 5fps로 다운샘플 (30초 청크면 150 프레임만 비교, <100ms)
      - cv2.absdiff: 픽셀별 절대차 (0~255 스케일)
      - 청크당 평균값으로 정규화 (해상도/길이에 덜 민감)

    실제 발표 영상의 대략적 분포 (경험치):
      - ~0.5  : 카메라 자체 노이즈 (현실적 최저)
      - 1~2  : 거의 가만히 있음 (조명 깜빡임만)
      - 2~5  : 가만히 서서 말함 (입/표정 미세 변화)
      - 5~10 : 가벼운 손동작/표정
      - 10~20: 활발한 제스처
      - 20+  : 큰 움직임 (걷기 등)
    """
    cap = cv2.VideoCapture(str(chunk_path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(int(src_fps // sample_fps), 1)

    prev = None
    total = 0.0
    n = 0
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if prev is not None:
                diff = cv2.absdiff(gray, prev)
                total += float(diff.mean())
                n += 1
            prev = gray
        idx += 1
    cap.release()
    return total / n if n > 0 else 0.0


def mean_audio_db(chunk_path: Path) -> float | None:
    """ffmpeg volumedetect 로 청크 평균 볼륨(dB). 무음이거나 측정 실패 시 None.

    참고 범위:
      -inf ~ -60 dB : 거의 무음
      -50 ~ -40 dB  : 배경 잡음 / 매우 작은 소리
      -30 ~ -20 dB  : 일반 발표/대화
      -10 ~ 0 dB    : 매우 큰 소리 (드물게 클리핑 수준)
    """
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(chunk_path),
         "-af", "volumedetect", "-vn", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    # volumedetect 결과는 stderr 로 출력됨
    match = _VOL_RE.search(result.stderr or "")
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def chunk_duration(chunk_path: Path) -> float:
    """ffprobe로 청크 길이(초). 실패 시 0."""
    result = subprocess.run(
        ["ffprobe", "-v", "error",
         "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1",
         str(chunk_path)],
        capture_output=True, text=True,
    )
    try:
        return float(result.stdout.strip())
    except (ValueError, AttributeError):
        return 0.0


def score_chunk(idx: int, chunk_path: Path) -> ChunkScore:
    return ChunkScore(
        idx=idx,
        name=chunk_path.name,
        duration_sec=chunk_duration(chunk_path),
        motion_score=motion_score(chunk_path),
        audio_db=mean_audio_db(chunk_path),
    )


def score_all(chunk_paths: list[Path]) -> list[ChunkScore]:
    """청크 경로 리스트 → 각 청크의 스코어. 순서 보존."""
    return [score_chunk(i + 1, p) for i, p in enumerate(sorted(chunk_paths))]


# ---------------------------------------------------------------------------
# v2 스마트 청킹 — 영상 전체 motion 시계열 + 동적 청크 계획
# ---------------------------------------------------------------------------
#
# v1 (preview.py) 의 한계:
#   영상을 0~30, 30~60... 고정 30초로 자른 뒤 청크별 스코어로 SKIP 판정.
#   문제 1: 짧은 동작이 청크 경계에 걸치면 두 청크에 흩어져 패턴 분석 흐려짐
#   문제 2: 정적 30초 안에 짧은 동작이 묻혀버림
#   문제 3: 청크 자체는 다 생성되어 ffmpeg 비용은 그대로
#
# v2 정책 (교수 면담 피드백):
#   처음부터 영상을 읽으면서 "동작이 시작되는 시점"부터 30초 청크를 잘라냄.
#   정적 구간은 청크 자체를 안 만들어 ffmpeg + VLM 호출 둘 다 절감.
#
# 결정사항:
#   1A. intro 강제   : 영상 0~30초는 무조건 청크 (도입부 라벨 확보)
#   2A. 30초 고정    : VLM 분석 단위 일관성 유지
#   3A. 곧장 다음    : 30초 청크 끝나면 동작 지속 시 즉시 다음 청크 시작 가능
#   4B. 정적 강제 X : 정적이 아무리 길어도 강제 청크 생성 안 함 (실험)


@dataclass
class SmartChunk:
    """v2 청크 계획의 한 단위. 청크를 어디서~어디까지 잘라낼지 정의."""
    start_sec: float
    end_sec: float
    kind: str            # "intro" / "motion" / "outro"

    def to_dict(self) -> dict:
        return {
            "start_sec": round(self.start_sec, 2),
            "end_sec": round(self.end_sec, 2),
            "duration_sec": round(self.end_sec - self.start_sec, 2),
            "kind": self.kind,
        }


def video_motion_timeline(
    video_path: Path,
    sample_fps: int = SAMPLE_FPS,
) -> list[tuple[float, float]]:
    """영상 전체에서 프레임 간 motion을 시계열로 추출.

    반환 형식: [(time_sec, motion_value), ...]

    각 점은 (현재 프레임 시각, 직전 샘플 프레임 대비 픽셀 변화 평균).
    motion_score() 와 동일한 원리지만 청크 평균이 아닌 시점별 값을 반환.

    Note: 영상 전체를 스캔하므로 motion_score() 보다 무거움.
          5fps 다운샘플 + 그레이스케일로 가볍게 유지.
    """
    cap = cv2.VideoCapture(str(video_path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(int(src_fps // sample_fps), 1)

    timeline: list[tuple[float, float]] = []
    prev_gray = None
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if prev_gray is not None:
                # 직전 샘플 프레임과의 픽셀 변화 평균 (0~255 스케일)
                diff = cv2.absdiff(gray, prev_gray)
                time_sec = idx / src_fps
                timeline.append((time_sec, float(diff.mean())))
            prev_gray = gray
        idx += 1
    cap.release()
    return timeline


def smart_chunk_plan(
    timeline: list[tuple[float, float]],
    video_duration: float,
    motion_thresh: float = 3.5,
    hysteresis_frames: int = 5,
    chunk_duration: float = 20.0,
    sample_fps: int = SAMPLE_FPS,
) -> list[SmartChunk]:
    """motion 시계열 → 동적 청크 시작점 계획.

    정책 v2:
      1. intro: 0 ~ chunk_duration 무조건 청크 (1A)
      2. intro 이후: motion이 임계값 초과 + hysteresis_frames 연속 → "동작 시작"
                    동작 시작 시점부터 chunk_duration 청크 (2A)
      3. 30초 청크 종료 후: idle 상태 복귀. 동작 지속되면 곧장 다음 청크 (3A)
      4. 정적이 아무리 길어도 강제 청크 안 만듦 (4B 실험)
      5. outro: 마지막 chunk_duration 강제 청크 (기존 청크와 안 겹치면)

    Args:
        timeline: video_motion_timeline() 결과
        video_duration: 영상 총 길이(초)
        motion_thresh: 프레임 motion이 이 값 초과 시 "동작 있음"
        hysteresis_frames: 연속 몇 프레임 초과해야 "동작 시작" 으로 확정 (깜빡임 방지)
        chunk_duration: 청크 길이 (초)
        sample_fps: timeline 의 샘플링 주파수

    Returns:
        SmartChunk 리스트. 시간 순.
    """
    chunks: list[SmartChunk] = []

    # ── 1. intro 강제 (1A) ────────────────────────────────────────────────
    # 도입부에 동작이 없을 수 있으므로(가만히 서서 인사) 무조건 첫 청크 잡음.
    intro_end = min(chunk_duration, video_duration)
    chunks.append(SmartChunk(start_sec=0.0, end_sec=intro_end, kind="intro"))

    # 영상이 30초 이하면 intro 하나로 끝.
    if video_duration <= chunk_duration:
        return chunks

    # ── 2. intro 이후 motion 스캔 ─────────────────────────────────────────
    state = "idle"           # "idle" | "active"
    chunk_start = None       # active 상태일 때 현재 청크의 시작 시각
    streak = 0               # 연속으로 임계값 초과한 샘플 개수

    for time_sec, motion in timeline:
        # intro 구간 안의 시계열은 무시 (이미 청크로 잡힘)
        if time_sec < chunk_duration:
            continue

        if state == "active":
            # 현재 청크 진행 중. 30초 채워졌나 확인.
            if time_sec - chunk_start >= chunk_duration:
                chunks.append(SmartChunk(
                    start_sec=chunk_start,
                    end_sec=chunk_start + chunk_duration,
                    kind="motion",
                ))
                # 3A: 곧장 다음 청크 가능. idle로 돌아가지만,
                #     동작이 지속되면 streak이 다시 빠르게 쌓여 곧장 새 청크 시작.
                state = "idle"
                chunk_start = None
                streak = 0
            continue

        # idle 상태에서 동작 시작 감지 (hysteresis 적용)
        if motion > motion_thresh:
            streak += 1
            if streak >= hysteresis_frames:
                # 살짝 뒤로 (놓친 동작 시작 부분 포함). streak/sample_fps 초 만큼.
                offset = streak / sample_fps
                candidate_start = max(chunk_duration, time_sec - offset)

                # 직전 청크 끝과 겹치지 않도록 보정
                if chunks:
                    candidate_start = max(candidate_start, chunks[-1].end_sec)

                chunk_start = candidate_start
                state = "active"
        else:
            # 임계값 미만 샘플이 나오면 streak 리셋
            streak = 0

    # 영상 끝까지 동작 지속 케이스 — 청크 마무리
    if state == "active" and chunk_start is not None:
        chunks.append(SmartChunk(
            start_sec=chunk_start,
            end_sec=min(chunk_start + chunk_duration, video_duration),
            kind="motion",
        ))

    # ── 3. outro 강제 ─────────────────────────────────────────────────────
    # 결론부 라벨 확보. 단, 마지막 청크와 겹치면 추가 안 함.
    outro_start = max(0.0, video_duration - chunk_duration)
    if chunks[-1].end_sec <= outro_start:
        chunks.append(SmartChunk(
            start_sec=outro_start,
            end_sec=video_duration,
            kind="outro",
        ))

    return chunks


def extract_smart_chunks(
    video_path: Path,
    plan: list[SmartChunk],
    out_dir: Path,
) -> list[Path]:
    """청크 계획에 따라 ffmpeg 로 실제 청크 파일을 추출.

    각 SmartChunk 의 (start_sec, end_sec) 범위로 영상을 잘라 chunk_NNN.mp4 생성.

    구현 노트:
      - `-i` 뒤에 `-ss` 를 두는 "정확한 시킹" 사용. 키프레임이 아닌 임의 시점도 정확.
        대신 약간 느릴 수 있음 (PoC 단계라 정확성 우선).
      - `-c copy` 로 재인코딩 회피 → 빠름. 단 일부 컨테이너에선 키프레임 정렬 이슈로
        시작 부분이 검을 수 있는데 분석에는 영향 미미.
      - 출력 파일명은 1-based 인덱스 (chunk_001.mp4, ...).

    Args:
        video_path: 원본 영상
        plan: smart_chunk_plan() 결과
        out_dir: 청크 출력 디렉터리

    Returns:
        생성된 청크 파일 경로 리스트 (plan 과 동일 순서)
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # 기존 청크 정리 (이전 분석 결과 섞이지 않게)
    for old in out_dir.glob("chunk_*.mp4"):
        old.unlink()

    chunk_paths: list[Path] = []
    for i, chunk in enumerate(plan, start=1):
        out_path = out_dir / f"chunk_{i:03d}.mp4"
        duration = chunk.end_sec - chunk.start_sec
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(video_path),       # -i 먼저 → -ss 가 정확 시킹 모드
                "-ss", f"{chunk.start_sec:.3f}",
                "-t", f"{duration:.3f}",
                "-c", "copy",
                "-map", "0",
                "-avoid_negative_ts", "make_zero",
                str(out_path),
            ],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            tail = result.stderr[-500:] if result.stderr else ""
            raise RuntimeError(
                f"ffmpeg extract failed for chunk {i} ({chunk.start_sec:.1f}~{chunk.end_sec:.1f}): {tail}"
            )
        chunk_paths.append(out_path)

    return chunk_paths


# ---------------------------------------------------------------------------
# KEEP / SKIP 판정 정책
# ---------------------------------------------------------------------------


@dataclass
class Verdict:
    keep: bool
    reason: str           # "동적" / "시작 강제" / "끝 강제" / "이전과 동일 (정적)" /
                          # "주기적 강제" / "정적 전환"


def classify_chunks(
    scores: list[ChunkScore],
    motion_thresh: float,
    audio_thresh: float,
    max_consec_skip: int = 4,
) -> list[Verdict]:
    """청크별 KEEP/SKIP 판정.

    정책 흐름 (각 청크에 순서대로 적용):

      is_static = (motion < motion_thresh) AND (audio < audio_thresh)

      1. is_static == False  → KEEP  (사유: "동적")
           ─ 활발한 동작 자체가 분석 가치. 무조건 분석.

      2. 첫 청크 / 마지막 청크 → KEEP  (사유: "시작/끝 강제")
           ─ 도입부와 결론부는 발표 흐름상 중요. 빠뜨리지 않음.

      3. 직전 KEEP 청크가 정적이었고 연속 SKIP 한도 미달 → SKIP
           (사유: "이전과 동일 (정적)")
           ─ 같은 정적 상태가 이어지면 첫 청크의 라벨이 그대로 적용됨.

      4. 연속 SKIP 한도 초과 → KEEP  (사유: "주기적 강제")
           ─ 정적이 너무 길게 이어지면 중간에 한 번 확인.

      5. 위 어디에도 안 걸림 (직전이 동적이었음) → KEEP
           (사유: "정적 전환")
           ─ 동적 → 정적 전환 시점. 새 상태의 시작이라 KEEP.

    Args:
        scores: score_all() 의 결과
        motion_thresh: 이 값 미만이면 "정적"으로 판정 (motion 절대 임계값)
        audio_thresh:  이 값 미만이면 "정적"으로 판정 (audio dB 절대 임계값)
        max_consec_skip: 연속 SKIP 허용 한도 (안전장치)

    Returns:
        scores 와 동일 길이의 Verdict 리스트. 순서 보존.
    """
    verdicts: list[Verdict] = []
    last_keep_was_static = False
    consec_skip = 0
    last_idx = len(scores) - 1

    for i, s in enumerate(scores):
        audio = s.audio_db if s.audio_db is not None else float("-inf")
        is_static = s.motion_score < motion_thresh and audio < audio_thresh

        if not is_static:
            verdicts.append(Verdict(True, "동적"))
            last_keep_was_static = False
            consec_skip = 0
        elif i == 0:
            verdicts.append(Verdict(True, "시작 강제"))
            last_keep_was_static = True
            consec_skip = 0
        elif i == last_idx:
            verdicts.append(Verdict(True, "끝 강제"))
            last_keep_was_static = True
            consec_skip = 0
        elif last_keep_was_static and consec_skip < max_consec_skip:
            verdicts.append(Verdict(False, "이전과 동일 (정적)"))
            consec_skip += 1
        elif consec_skip >= max_consec_skip:
            verdicts.append(Verdict(True, "주기적 강제"))
            last_keep_was_static = True
            consec_skip = 0
        else:
            # 직전이 동적이었던 경우. 새 정적 상태의 시작이므로 KEEP.
            verdicts.append(Verdict(True, "정적 전환"))
            last_keep_was_static = True
            consec_skip = 0

    return verdicts
