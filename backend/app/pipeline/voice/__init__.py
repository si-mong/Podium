"""STEP 3 음성분석 코어.

개발용 테스트 도구(`stt_test/`)와 본 파이프라인이 **같은 코드를 공유**한다.
테스트 UI 에서 맞춘 임계값(`config.py`)이 그대로 본 파이프라인에 적용된다.

    audio    오디오 로딩 + 음향 특징 (순수 numpy)
    vad      3-1 무음 구간
    stt      3-2 STT (faster-whisper / transformers 분기)
    stt_hf   3-2 transformers 백엔드 (비유창성 태그 모델용)
    filler   3-3 필러
    stutter  3-5 반복(말더듬)
    analyze  오케스트레이션
    config   임계값 저장소
"""
