"""
Step 3: 음성 분석 (STT + 무음 + 필러 + 반복 + 발화속도)

입력: step1_preprocess 가 만든 `full_audio.wav`
출력: DB 테이블에 그대로 매핑되는 dict

    3-1 VAD      무음 구간          Silero VAD — STT 무관, 단독 동작
    3-2 STT      문장 + 단어 시각    SeloWhisper (한국어 비유창성 파인튜닝)
    3-3 필러     어휘 매칭 + 음향    모델 태그(<um> 등) + 사전 + VAD∧¬STT
    3-4 발화속도  음절/분            무음 포함/제외 두 가지
    3-5 반복     말더듬             STT 단어 목록에서 인접 비교

임계값은 `voice/config.py` 한 곳에서 읽는다. 개발용 테스트 페이지(`stt_test/`,
포트 8002)에서 맞춘 값이 그대로 여기에 적용된다 — 두 경로가 같은 코어를 공유.

모델은 `settings.whisper_model` 로 교체 가능:
    hf:rearleg/SeloWhisper-ko-disfluency   transformers. 비유창성 태그 O, 메모리 ~3.2GB
    stt_test/models/rearleg_SeloWhisper... CTranslate2. 태그 X, 메모리 ~825MB
    small / large-v3-turbo / large-v3      기본 Whisper
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def run(
    wav_path: Path,
    model_size: str | None = None,
    keywords: str = "",
    on_progress=None,
) -> dict:
    """STEP 3 전체 실행.

    keywords: 발표 주제·고유명사. hotwords 로 전달돼 해당 어휘 인식률이 올라간다.
      **발표에 실제로 나오는 고유명사만** 넣을 것 — 무관한 단어는 디코딩을 흔든다.

    반환 dict (DB 매핑):
        voice_raw      → voice_raws           (total_duration, silence_segments, filler_words)
        repetitions    → voice_raws.repetitions  ※ 컬럼 추가 필요 (아래 주석)
        stt_sentences  → stt_sentences
        metrics        → segment_analyses / session_summaries 집계용
        diagnostics    → 저장 대상 아님 (튜닝·디버그용)
    """
    from app.core.config import settings          # lazy — 무거운 의존 회피
    from app.pipeline.voice.analyze import analyze

    model = model_size or settings.whisper_model

    if settings.stt_remote_url:
        # GPU 서버에 wav 를 보내 분석. 결과 dict 모양은 로컬 실행과 같다.
        # (모델은 GPU 서버의 설정값을 쓰므로 model_size 는 전달하지 않음)
        logger.info("STEP 3 시작: %s (GPU 서버 %s)", wav_path.name, settings.stt_remote_url)
        result = _run_remote(settings.stt_remote_url, wav_path, keywords)
    else:
        logger.info("STEP 3 시작: %s (model=%s)", wav_path.name, model)
        result = analyze(wav_path, model_size=model, keywords=keywords,
                         on_progress=on_progress)

    m = result["metrics"]
    logger.info(
        "STEP 3 완료: 무음 %d구간 / 필러 %d / 반복 %d / 조음 %.0f음절분",
        m["silence_count"], m["filler_count"], m["repetition_count"],
        m["articulation_rate_spm"],
    )
    return result


# 10분 발표 기준 수 분 걸리므로 넉넉하게 30분.
REMOTE_TIMEOUT_SEC = 1800


def _run_remote(url: str, wav_path: Path, keywords: str) -> dict:
    """GPU 서버(gpu_server/stt_server.py)의 /step3 에 wav 를 올리고 결과 dict 를 받는다.

    GPU 서버는 학교 내부망에서만 접속된다. 연결이 안 되면 로컬로 대신 돌리지 않고
    에러를 낸다 — 로컬(RAM 8GB)에서 SeloWhisper 를 돌리면 컴퓨터 전체가 느려지기 때문.
    """
    import httpx

    try:
        with open(wav_path, "rb") as f:
            resp = httpx.post(
                f"{url.rstrip('/')}/step3",
                files={"file": (wav_path.name, f, "audio/wav")},
                data={"keywords": keywords},
                timeout=REMOTE_TIMEOUT_SEC,
            )
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"GPU 서버({url})에 연결할 수 없습니다. 학교 내부망인지, 서버가 켜져 있는지 확인하세요."
        ) from e

    resp.raise_for_status()
    return resp.json()


def to_db_rows(session_id: int, result: dict) -> dict:
    """analyze 결과를 테이블별 행으로 분해. 저장은 호출부(라우터)가 담당.

    `repetitions` 는 마이그레이션 b2e93e11bdc0 에서 voice_raws 에 추가됨.
    """
    # analyze 출력에는 DB 에 없는 진단용 키도 섞여 있으므로(예: no_speech_prob)
    # 컬럼에 해당하는 것만 골라 넘긴다.
    sentence_cols = ("text", "t_start", "t_end")
    return {
        "voice_raw": {
            "session_id": session_id,
            **result["voice_raw"],
            "repetitions": result["repetitions"],
        },
        "stt_sentences": [
            {"session_id": session_id, **{k: s[k] for k in sentence_cols}}
            for s in result["stt_sentences"]
        ],
        "metrics": result["metrics"],
    }
