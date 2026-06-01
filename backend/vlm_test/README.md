# vlm_test — VLM 정적 테스트 도구

본 흐름(시스템 촬영 → sessions API)과 별개로, **이미 촬영된 영상을 빠르게 VLM(Gemini)으로 분석**하기 위한 검증 도구. 포트 8001에서 단독 구동. DB 연결 안 함.

## 사전 준비

```bash
# cwd = backend/
ffmpeg -version                    # 없으면: brew install ffmpeg
pip install -r requirements-vlm.txt
```

`.env` 에 Gemini API 키:
```
GEMINI_API_KEY=AIza...
```
키 발급: https://aistudio.google.com/apikey

## 실행

```bash
# cwd = backend/
uvicorn vlm_test.server:app --reload --port 8001
```

## 사용

| URL | 용도 |
|---|---|
| http://localhost:8001 | 영상 선택 → 분석 시작. SSE로 청크별 결과 실시간 표시 |
| http://localhost:8001/history | 분석 완료된 케이스 목록. 카드 클릭 시 영상 + 결과 표 + 로그 펼침 |

## 결과 저장

`backend/vlm_test/work/<job_id>/` 안에 자동 저장 (gitignored):

```
work/<job_id>/
├── input.mp4        업로드 원본
├── chunks/          30초 청크
├── meta.json        원본명, 시각, 사이즈
├── result.json      VLM 분석 결과
└── log.jsonl        진행 이벤트 로그
```

수동 정리: `rm -rf backend/vlm_test/work/*` 후 `touch backend/vlm_test/work/.gitkeep`

## 한계 / 메모

- Gemini 동시 호출 무제한 (`max_workers=None`). rate limit 걸리면 `analyzer.run_analysis(..., max_workers=2)`.
- 청크 분석은 최대 3회 재시도 후 실패 처리.
- 분석 중 페이지 떠나면 결과 못 봄(SSE 끊김). 결과 보려면 `/history`.
