"""STEP 2 스마트 청킹 (v2).

VLM(Gemini) 호출은 청크당 5~30초 + 비용이 든다. 녹화 영상을 30초 고정으로 자르면
가만히 서 있는 구간까지 전부 분석하게 되므로, "동작이 시작되는 시점"부터만 청크를
잘라내 ffmpeg 추출과 VLM 호출을 둘 다 줄인다.

vlm_test/scoring.py 의 v2 로직(smart_chunk_plan)을 본 파이프라인으로 역이식한 것.
v1(고정 30초 청크 KEEP/SKIP 판정, classify_chunks)은 폐기됐으므로 옮기지 않았다.

정책:
  1A. intro 강제   : 0 ~ chunk_duration 은 무조건 청크 (도입부 확보)
  2A. 고정 길이    : 청크 길이는 chunk_duration 으로 통일 (VLM 분석 단위 일관성)
  3A. 곧장 다음    : 청크가 끝난 뒤 동작이 지속되면 즉시 다음 청크 시작 가능
  4B. 정적 강제 X : 정적 구간이 아무리 길어도 강제 청크를 만들지 않음
  5.  outro 강제   : 마지막 chunk_duration 은 무조건 청크 (결론부 확보)

외부 의존성: ffmpeg / ffprobe (시스템 설치), opencv (requirements-pipeline.txt).
"""
from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

from app.pipeline import motion_config

logger = logging.getLogger(__name__)

# 튜닝 기본값 — vlm_test/smart-analyze 실험에서 확정된 값.
MOTION_THRESH = 3.5
HYSTERESIS_FRAMES = 5
CHUNK_DURATION = 20.0

# 초당 몇 번 비교할지. 원본이 30fps여도 5fps(0.2초 간격)로만 비교 → 매우 가벼움.
# 사람의 동작은 5Hz면 충분히 잡힘 (인간 시각 인지 임계 ~10Hz).
SAMPLE_FPS = 5


@dataclass
class SmartChunk:
    """청크 계획의 한 단위. 영상의 어디서~어디까지 잘라낼지 정의."""
    start_sec: float
    end_sec: float
    kind: str            # "intro" / "motion" / "outro"

    @property
    def duration_sec(self) -> float:
        return self.end_sec - self.start_sec

    def to_dict(self) -> dict:
        return {
            "start_sec": round(self.start_sec, 2),
            "end_sec": round(self.end_sec, 2),
            "duration_sec": round(self.duration_sec, 2),
            "kind": self.kind,
        }


# ---------------------------------------------------------------------------
# 영상 길이
# ---------------------------------------------------------------------------

def probe_video_duration(video_path: Path, fallback: float | None = None) -> float:
    """영상 길이(초). ffprobe 실패 시 fallback 사용.

    MediaRecorder 가 만든 webm 은 스트리밍 특성상 컨테이너에 duration 이 안 박히는
    경우가 흔하다(ffprobe 가 N/A 반환). 이때는 호출부가 넘겨준 fallback
    (보통 STEP 1 에서 만든 full_audio.wav 의 길이)을 쓴다.
    """
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True, text=True,
    )
    raw = (result.stdout or "").strip()
    if result.returncode == 0 and raw and raw.lower() != "n/a":
        try:
            duration = float(raw)
            if duration > 0:
                return duration
        except ValueError:
            pass

    if fallback and fallback > 0:
        logger.warning(
            "ffprobe로 영상 길이를 못 구함(%s) → fallback %.2f초 사용", video_path.name, fallback
        )
        return fallback
    raise RuntimeError(f"영상 길이를 구할 수 없습니다: {video_path}")


# ---------------------------------------------------------------------------
# motion 시계열
# ---------------------------------------------------------------------------

def _sane_fps(cap, default: float = 30.0) -> float:
    """CAP_PROP_FPS 를 믿을 수 있을 때만 쓰고, 아니면 default.

    MediaRecorder 가 만든 webm 은 CAP_PROP_FPS 로 **1000** 을 돌려준다.
    프레임레이트가 아니라 Matroska 타임베이스(1ms)다. (CAP_PROP_FRAME_COUNT 도
    프레임 수가 아니라 밀리초를 돌려준다.) 이걸 그대로 믿으면 샘플 간격이
    200프레임(≈6.7초)이 되어 motion 값이 완전히 망가진다.

    이 값은 타임스탬프를 못 읽을 때의 폴백으로만 쓰이므로 대략만 맞으면 된다.
    """
    import cv2

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps and 1.0 <= fps <= 120.0:
        return float(fps)
    logger.debug("CAP_PROP_FPS=%s 신뢰 불가 → %.1f 로 가정", fps, default)
    return default


def video_motion_timeline(
    video_path: Path,
    sample_fps: int = SAMPLE_FPS,
) -> list[tuple[float, float]]:
    """영상 전체에서 프레임 간 motion 을 시계열로 추출.

    반환 형식: [(time_sec, motion_value), ...]
    각 점은 (프레임 시각, 직전 샘플 프레임 대비 픽셀 변화 평균).

    구체:
      - 그레이스케일 변환으로 색상/조명 변화 영향 최소화
      - sample_fps 로 다운샘플 (기본 5fps = 0.2초 간격)
      - cv2.absdiff: 픽셀별 절대차 (0~255 스케일)

    실제 발표 영상의 대략적 분포 (경험치, 5fps 기준):
      1~2 거의 정지 / 2~5 서서 말함 / 5~10 가벼운 손동작 / 10~20 활발 / 20+ 큰 이동

    **프레임 인덱스가 아니라 타임스탬프로 샘플링한다.** webm 은 CAP_PROP_FPS 가
    엉뚱한 값(1000)이라 `idx % step` 방식을 쓰면 샘플 간격이 수 초로 벌어지고,
    위 임계값들이 전부 무의미해진다. 타임스탬프 기준이면 컨테이너 메타데이터가
    틀려도 실제 0.2초 간격이 보장된다.

    비용: 건너뛸 프레임은 grab() 으로 디코딩만 하고 색변환을 생략한다.
    """
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"영상을 열 수 없습니다: {video_path}")

    interval_ms = 1000.0 / sample_fps
    fallback_fps = _sane_fps(cap)

    timeline: list[tuple[float, float]] = []
    prev_gray = None
    next_sample_ms = 0.0
    idx = 0

    try:
        while True:
            # read()/grab() 전에 읽어야 "지금 읽을 프레임"의 타임스탬프가 된다.
            pos_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
            if not pos_ms or pos_ms <= 0:
                # 타임스탬프가 없는 컨테이너 → 프레임 인덱스로 추정
                pos_ms = idx * 1000.0 / fallback_fps

            if pos_ms < next_sample_ms:
                # 샘플 대상 아님 — 색변환 없이 넘긴다.
                if not cap.grab():
                    break
                idx += 1
                continue

            ok, frame = cap.read()
            if not ok:
                break
            idx += 1
            next_sample_ms = pos_ms + interval_ms

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if prev_gray is not None:
                diff = cv2.absdiff(gray, prev_gray)
                timeline.append((pos_ms / 1000.0, float(diff.mean())))
            prev_gray = gray
    finally:
        cap.release()

    return timeline


# ---------------------------------------------------------------------------
# 청크 계획
# ---------------------------------------------------------------------------

def smart_chunk_plan(
    timeline: list[tuple[float, float]],
    video_duration: float,
    motion_thresh: float = MOTION_THRESH,
    hysteresis_frames: int = HYSTERESIS_FRAMES,
    chunk_duration: float = CHUNK_DURATION,
    sample_fps: int = SAMPLE_FPS,
) -> list[SmartChunk]:
    """motion 시계열 → 동적 청크 계획.

    Args:
        timeline: video_motion_timeline() 결과
        video_duration: 영상 총 길이(초)
        motion_thresh: 프레임 motion 이 이 값 초과 시 "동작 있음"
        hysteresis_frames: 연속 몇 샘플 초과해야 "동작 시작" 확정 (깜빡임 방지)
        chunk_duration: 청크 길이 (초)
        sample_fps: timeline 의 샘플링 주파수

    Returns:
        SmartChunk 리스트 (시간 순).
    """
    chunks: list[SmartChunk] = []

    # ── 1. intro 강제 (1A) ────────────────────────────────────────────────
    # 도입부에 동작이 없을 수 있으므로(가만히 서서 인사) 무조건 첫 청크를 잡는다.
    intro_end = min(chunk_duration, video_duration)
    chunks.append(SmartChunk(start_sec=0.0, end_sec=intro_end, kind="intro"))

    # 영상이 청크 길이 이하면 intro 하나로 끝.
    if video_duration <= chunk_duration:
        return chunks

    # ── 2. intro 이후 motion 스캔 ─────────────────────────────────────────
    state = "idle"           # "idle" | "active"
    chunk_start: float | None = None
    streak = 0               # 연속으로 임계값 초과한 샘플 개수

    for time_sec, motion in timeline:
        # intro 구간은 이미 청크로 잡혔으므로 무시.
        if time_sec < chunk_duration:
            continue

        if state == "active":
            assert chunk_start is not None
            if time_sec - chunk_start >= chunk_duration:
                chunks.append(SmartChunk(
                    start_sec=chunk_start,
                    end_sec=min(chunk_start + chunk_duration, video_duration),
                    kind="motion",
                ))
                # 3A: idle 로 돌아가지만 동작이 지속되면 streak 이 다시 빠르게
                #     쌓여 곧장 새 청크가 시작된다.
                state = "idle"
                chunk_start = None
                streak = 0
            continue

        # idle 상태에서 동작 시작 감지 (hysteresis 적용)
        if motion > motion_thresh:
            streak += 1
            if streak >= hysteresis_frames:
                # 살짝 뒤로 당김 (놓친 동작 시작 부분 포함).
                offset = streak / sample_fps
                candidate_start = max(chunk_duration, time_sec - offset)
                # 직전 청크 끝과 겹치지 않도록 보정
                candidate_start = max(candidate_start, chunks[-1].end_sec)

                if candidate_start < video_duration:
                    chunk_start = candidate_start
                    state = "active"
                streak = 0
        else:
            streak = 0

    # 영상 끝까지 동작이 지속된 케이스 — 열려 있는 청크 마무리.
    if state == "active" and chunk_start is not None:
        chunks.append(SmartChunk(
            start_sec=chunk_start,
            end_sec=min(chunk_start + chunk_duration, video_duration),
            kind="motion",
        ))

    # ── 3. outro 강제 ─────────────────────────────────────────────────────
    # 결론부 확보. 단, 마지막 청크와 겹치면 추가하지 않는다.
    outro_start = max(0.0, video_duration - chunk_duration)
    if chunks[-1].end_sec <= outro_start:
        chunks.append(SmartChunk(
            start_sec=outro_start,
            end_sec=video_duration,
            kind="outro",
        ))

    return chunks


# ---------------------------------------------------------------------------
# 청크 추출
# ---------------------------------------------------------------------------

def extract_smart_chunks(
    video_path: Path,
    plan: list[SmartChunk],
    out_dir: Path,
) -> list[Path]:
    """청크 계획에 따라 ffmpeg 로 실제 청크 파일(mp4)을 추출.

    구현 노트:
      - `-i` 뒤에 `-ss` 를 두는 "정확한 시킹" 사용. 키프레임이 아닌 임의 시점도 정확.
      - vlm_test 는 mp4 원본이라 `-c copy` 로 잘랐지만, 여기 원본은 MediaRecorder
        webm 이라 키프레임이 희소하다. `-c copy` 로 자르면 청크 앞부분이 깨지거나
        검게 나오므로 **재인코딩**한다(libx264 ultrafast). 20초 청크라 비용은 작고,
        mp4 는 Gemini File API 호환성도 더 좋다.
      - 출력 파일명은 1-based (chunk_001.mp4, ...).

    Returns:
        생성된 청크 파일 경로 리스트 (plan 과 동일 순서, 동일 길이).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # 기존 청크 정리 (이전 분석 결과가 섞이지 않게)
    for old in out_dir.glob("chunk_*.mp4"):
        old.unlink()

    chunk_paths: list[Path] = []
    for i, chunk in enumerate(plan, start=1):
        out_path = out_dir / f"chunk_{i:03d}.mp4"
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(video_path),          # -i 먼저 → -ss 가 정확 시킹 모드
                "-ss", f"{chunk.start_sec:.3f}",
                "-t", f"{chunk.duration_sec:.3f}",
                "-c:v", "libx264", "-preset", "ultrafast",
                "-c:a", "aac",
                "-avoid_negative_ts", "make_zero",
                str(out_path),
            ],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            tail = result.stderr[-500:] if result.stderr else ""
            raise RuntimeError(
                f"ffmpeg extract failed for chunk {i} "
                f"({chunk.start_sec:.1f}~{chunk.end_sec:.1f}): {tail}"
            )
        chunk_paths.append(out_path)

    return chunk_paths


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------

def plan_and_extract(
    video_path: Path,
    out_dir: Path,
    duration_fallback: float | None = None,
    motion_thresh: float | None = None,
    hysteresis_frames: int | None = None,
    chunk_duration: float | None = None,
) -> tuple[list[SmartChunk], list[Path]]:
    """영상 → motion 시계열 → 청크 계획 → 실제 청크 파일 추출까지 한 번에.

    Args:
        video_path: 원본 영상 (full_video.webm)
        out_dir: 청크 출력 디렉터리
        duration_fallback: ffprobe 로 길이를 못 구할 때 쓸 값 (full_audio 길이 등)

    Returns:
        (청크 계획, 생성된 청크 파일 경로). 두 리스트는 인덱스가 대응한다.
    """
    # 인자를 안 주면 저장된 설정을 따른다. 개발 도구(/vlm/smart-preview/history)에서
    # 맞춘 값이 본 파이프라인에 그대로 적용되도록 하기 위함.
    cfg = motion_config.load()
    motion_thresh = cfg["motion_thresh"] if motion_thresh is None else motion_thresh
    hysteresis_frames = (cfg["hysteresis_frames"] if hysteresis_frames is None
                         else hysteresis_frames)
    chunk_duration = cfg["chunk_duration"] if chunk_duration is None else chunk_duration

    duration = probe_video_duration(video_path, fallback=duration_fallback)
    timeline = video_motion_timeline(video_path)
    plan = smart_chunk_plan(
        timeline,
        video_duration=duration,
        motion_thresh=motion_thresh,
        hysteresis_frames=hysteresis_frames,
        chunk_duration=chunk_duration,
    )
    covered = sum(c.duration_sec for c in plan)
    logger.info(
        "스마트 청킹: 영상 %.1f초 → 청크 %d개 (%.1f초, 절감 %.1f%%)",
        duration, len(plan), covered,
        (1 - covered / duration) * 100 if duration > 0 else 0.0,
    )
    chunk_paths = extract_smart_chunks(video_path, plan, out_dir)
    return plan, chunk_paths
