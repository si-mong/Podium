"""
uvicorn vlm_test.server:app --reload --port 8001
http://localhost:8001/voice-analyze
"""
"""
음성 분석 모듈 (Gemini 버전)

동영상 파일에서 오디오를 추출하고 Gemini AI로 분석합니다.
- Gemini: 전사 + 문맥 필러단어 (그니까, 그러니까 - 의미 있는 경우 제외)
- 코드:   고정 필러단어 (아, 어, 음, 으, 에, 자, 뭐, 좀, 그냥) → 100% 일관성
- ffmpeg: 무음 구간 탐지
- 코드:   말 속도 계산
"""

import json
import re
import subprocess
import time
from pathlib import Path

from google import genai
from google.genai import types


# 코드로 직접 세는 고정 필러 (항상 필러로 취급 → 100% 일관성)
CORE_FILLERS = ["아", "어", "음", "으", "에", "자", "뭐", "좀", "그냥"]

# Gemini에게 보낼 분석 요청 내용
# 고정 필러는 코드가 세므로 Gemini는 문맥 판단이 필요한 단어만 분석
ANALYSIS_PROMPT = """
아래는 발표 음성입니다. 두 가지를 분석해서 JSON으로만 답해줘 (다른 텍스트 없이).

[분석 항목]
1. transcript_sentences: 발화 내용을 문장 단위로 분리해서 전사. 필러단어(아, 어, 음 등)도 포함.
   각 문장마다 시작/끝 타임스탬프(MM:SS 형식)를 함께 기록.
2. filler_words: "그니까"와 "그러니까"만 탐지.
   - 문장에서 의미 있게 쓰인 경우는 제외하고, 말 습관으로 나온 경우만 포함.

아래 형식으로만 답해줘:
{
  "transcript_sentences": [
    {"text": "안녕하세요 오늘은 발표를 시작하겠습니다.", "start": "00:00", "end": "00:05"},
    {"text": "어 먼저 개요를 설명드리겠습니다.", "start": "00:05", "end": "00:12"}
  ],
  "filler_words": [
    {"word": "그니까", "count": 5, "timestamps": ["03:02", "04:25", "15:05"]},
    {"word": "그러니까", "count": 3, "timestamps": ["03:32", "05:46", "10:07"]}
  ],
  "filler_total": 8,
  "notes": "개선 포인트 1~2문장 (반드시 한국어로). 없으면 빈 문자열."
}
"""


def _merge_filler_words(filler_words):
    """같은 단어가 중복 항목으로 온 경우 count를 합산합니다."""
    merged = {}
    for item in filler_words:
        word = item.get("word", "")
        if word in merged:
            merged[word]["count"] += item.get("count", 0)
            merged[word].setdefault("timestamps", []).extend(item.get("timestamps", []))
        else:
            merged[word] = dict(item)
    return list(merged.values())


def _mmss_to_sec(ts):
    """'MM:SS' 문자열을 초(float)로 변환합니다."""
    try:
        parts = ts.split(":")
        return int(parts[0]) * 60 + int(parts[1])
    except Exception:
        return 0.0


def _build_sentence_map(transcript_sentences):
    """문장별 (시작 단어 인덱스, 끝 단어 인덱스, 시작 초, 끝 초) 목록을 만듭니다.

    transcript = sentences를 join한 것이므로 단어 인덱스가 일치합니다.
    """
    mapping = []
    cursor = 0
    for s in transcript_sentences:
        text = s.get("text", "")
        word_count = len(text.split())
        start_sec = _mmss_to_sec(s.get("start", "00:00"))
        end_sec = _mmss_to_sec(s.get("end", "00:00"))
        mapping.append((cursor, cursor + word_count, start_sec, end_sec))
        cursor += word_count
    return mapping


def _estimate_time(word_idx, sentence_map, speaking_duration, total_words):
    """단어 인덱스를 실제 시각(초)으로 변환합니다.

    sentence_map이 있으면 문장 타임스탬프 기반 보간,
    없으면 전체 단어 수 비율 방식으로 폴백합니다.
    """
    if sentence_map:
        for (w_start, w_end, t_start, t_end) in sentence_map:
            if w_start <= word_idx < w_end:
                span = w_end - w_start
                if span > 0:
                    ratio = (word_idx - w_start) / span
                else:
                    ratio = 0.0
                return t_start + ratio * (t_end - t_start)
    # 폴백: 전체 단어 수 비율
    return (word_idx / max(total_words, 1)) * speaking_duration


def detect_stutters(transcript, speaking_duration, transcript_sentences=None):
    """연속으로 같은 단어가 반복되는 말 더듬 구간을 탐지합니다.

    예: "그 그 다음에" → "그" 말 더듬으로 탐지
    """
    words = transcript.split()
    total_words = max(len(words), 1)
    sentence_map = _build_sentence_map(transcript_sentences) if transcript_sentences else []

    stutter_map = {}

    for i in range(1, len(words)):
        prev = re.sub(r'[,.!?~。、]', '', words[i - 1]).strip()
        curr = re.sub(r'[,.!?~。、]', '', words[i]).strip()

        if prev and curr and prev == curr:
            estimated_sec = _estimate_time(i - 1, sentence_map, speaking_duration, total_words)
            mm = int(estimated_sec // 60)
            ss = int(estimated_sec % 60)
            stutter_map.setdefault(prev, []).append(f"{mm:02d}:{ss:02d}")

    return [
        {"word": word, "count": len(tss), "timestamps": tss}
        for word, tss in stutter_map.items()
    ]


def count_core_fillers(transcript, speaking_duration, transcript_sentences=None):
    """아, 어, 음 등 핵심 필러를 코드로 직접 셉니다.

    transcript_sentences가 있으면 문장별 타임스탬프로 정확하게 추정하고,
    없으면 단어 위치 비율로 폴백합니다.
    """
    words = transcript.split()
    total_words = max(len(words), 1)
    sentence_map = _build_sentence_map(transcript_sentences) if transcript_sentences else []
    results = []

    for filler in CORE_FILLERS:
        timestamps = []
        for i, word in enumerate(words):
            # 문장부호 제거 후 비교
            clean = re.sub(r'[,.!?~。、]', '', word).strip()
            if clean == filler:
                estimated_sec = _estimate_time(i, sentence_map, speaking_duration, total_words)
                mm = int(estimated_sec // 60)
                ss = int(estimated_sec % 60)
                timestamps.append(f"{mm:02d}:{ss:02d}")

        if timestamps:
            results.append({
                "word": filler,
                "count": len(timestamps),
                "timestamps": timestamps,
            })

    return results


def extract_audio(video_path, output_wav):
    """동영상에서 오디오만 뽑아서 wav 파일로 저장합니다."""
    output_wav.parent.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            str(output_wav),
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"오디오 추출 실패:\n{result.stderr[-500:]}")

    return output_wav


def get_audio_duration(audio_path):
    """ffprobe로 오디오 파일의 총 길이(초)를 가져옵니다."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0 or not result.stdout.strip():
        return None

    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def detect_silence(audio_path, min_duration=2.0, noise_level=-30):
    """ffmpeg silencedetect로 무음 구간을 찾습니다."""
    result = subprocess.run(
        [
            "ffmpeg", "-i", str(audio_path),
            "-af", f"silencedetect=noise={noise_level}dB:duration={min_duration}",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
    )

    silence_intervals = []
    starts = re.findall(r"silence_start: (\d+\.?\d*)", result.stderr)
    ends   = re.findall(r"silence_end: (\d+\.?\d*)", result.stderr)

    for start, end in zip(starts, ends):
        start_sec = float(start)
        end_sec   = float(end)
        silence_intervals.append({
            "start_sec":    round(start_sec, 2),
            "end_sec":      round(end_sec, 2),
            "duration_sec": round(end_sec - start_sec, 2),
        })

    return silence_intervals


def calculate_speech_rate(transcript, total_duration, total_silence_sec):
    """말 속도를 계산합니다 (분당 단어 수)."""
    speaking_time = total_duration - total_silence_sec

    if speaking_time <= 0:
        return 0

    word_count = len(transcript.split())
    speech_rate = int(word_count / (speaking_time / 60))
    return speech_rate


def upload_audio_to_gemini(client, audio_path):
    """오디오 파일을 Gemini에 업로드하고 준비될 때까지 기다립니다."""
    uploaded = client.files.upload(
        file=str(audio_path),
        config={"mime_type": "audio/wav"},
    )

    while uploaded.state.name == "PROCESSING":
        time.sleep(3)
        uploaded = client.files.get(name=uploaded.name)

    if uploaded.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini 업로드 실패 (상태: {uploaded.state.name})")

    return uploaded


def run_voice_analysis(video_path, work_dir, api_key, on_event):
    """
    Gemini 버전 음성 분석 전체 흐름

    1단계: 오디오 추출
    2단계: ffmpeg로 무음 구간 탐지
    3단계: 말 속도 계산
    4단계: Gemini로 전사 + 습관어 필러 분석
    5단계: 코드로 핵심 필러(아,어,음) 카운트 후 합산
    """
    client = genai.Client(api_key=api_key)

    # ── 1단계: 오디오 추출 ────────────────────────────────────────────
    on_event("voice_extracting", {"video": video_path.name})

    full_audio = work_dir / "full_audio.wav"
    extract_audio(video_path, full_audio)

    on_event("voice_extracted", {"file": "full_audio.wav"})

    # ── 2단계: ffmpeg로 무음 구간 탐지 ───────────────────────────────
    on_event("voice_silence_detecting", {})

    silence_intervals = detect_silence(full_audio)
    total_silence_sec = sum(s["duration_sec"] for s in silence_intervals)

    on_event("voice_silence_detected", {"count": len(silence_intervals)})

    # ── 3단계: 말 속도 계산 ───────────────────────────────────────────
    total_duration = get_audio_duration(full_audio) or 0
    speaking_duration = max(total_duration - total_silence_sec, 1)

    # ── 4단계: Gemini로 전사 + 습관어 필러 분석 ──────────────────────
    on_event("voice_analyzing", {})

    uploaded = None
    done_sent = False

    for attempt in range(1, 4):
        try:
            uploaded = upload_audio_to_gemini(client, full_audio)

            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[uploaded, ANALYSIS_PROMPT],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.0,
                ),
            )

            gemini_result = json.loads(response.text)

            # 문장별 타임스탬프 배열 (interactive transcript용)
            transcript_sentences = gemini_result.get("transcript_sentences", [])
            # 문장 텍스트를 합쳐서 전체 전사문 string 생성
            transcript = " ".join(s.get("text", "") for s in transcript_sentences)

            speech_rate = calculate_speech_rate(transcript, total_duration, total_silence_sec)

            # 습관어 필러 (Gemini 분석) - 중복 합산
            habit_fillers = _merge_filler_words(gemini_result.get("filler_words", []))

            # ── 5단계: 핵심 필러(아,어,음) 코드로 카운트 후 합산 ──────
            core_fillers = count_core_fillers(transcript, speaking_duration, transcript_sentences)

            # 핵심 필러 + 습관어 필러 합치기
            all_fillers = core_fillers + habit_fillers
            filler_total = sum(w["count"] for w in all_fillers)

            # ── 6단계: 말 더듬 탐지 (연속 같은 단어) ─────────────────
            stutter_words = detect_stutters(transcript, speaking_duration, transcript_sentences)
            stutter_total = sum(w["count"] for w in stutter_words)

            result = {
                "transcript": transcript,
                "transcript_sentences": transcript_sentences,
                "silence_intervals": silence_intervals,
                "total_silence_sec": round(total_silence_sec, 2),
                "speech_rate_wpm": speech_rate,
                "filler_words": all_fillers,
                "filler_total": filler_total,
                "stutter_words": stutter_words,
                "stutter_total": stutter_total,
                "notes": gemini_result.get("notes", ""),
            }

            if not done_sent:
                done_sent = True
                on_event("done", result)
            return result

        except Exception as e:
            on_event("voice_retry", {"attempt": attempt, "error": str(e)})

            if attempt < 3:
                time.sleep(10)

        finally:
            if uploaded is not None:
                try:
                    client.files.delete(name=uploaded.name)
                except Exception:
                    pass
                uploaded = None

    on_event("error", {"message": "음성 분석 3회 모두 실패"})
    return {}
