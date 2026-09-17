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
