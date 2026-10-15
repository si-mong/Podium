"""관리자 라우터 — 외부 API 연결 점검.

  GET  /admin/health           -> API 키 설정 여부 + 단계별 사용 모델
  POST /admin/health/{target}  -> 해당 모델에 짧은 요청 1건을 보내 응답 여부·시간 확인

분석이 실패했을 때 "우리 코드 문제인지, Gemini/OpenAI 쪽 문제인지"를 실제 영상 없이
바로 가리기 위함이다. 단계마다 모델이 달라서(STEP2 영상 / STEP4 구간분리 / STEP5 피드백)
각각 따로 확인한다. 요청은 몇 토큰짜리라 비용은 무시할 수준.

전부 `require_admin` 으로 막는다. 일반 회원은 403.
"""
from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api._deps import require_admin
from app.core.config import settings
from app.pipeline import step2_video_analysis, step4_segmentation, step5_feedback


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

Target = Literal["step2_gemini", "step4_gemini", "step5_openai"]

# 점검 대상 → (단계 설명, 제공자, 모델). 모델은 각 단계 모듈의 상수를 그대로 읽어
# 단계에서 모델을 바꾸면 점검도 자동으로 따라간다.
TARGETS: dict[str, tuple[str, str, str]] = {
    "step2_gemini": ("STEP 2 영상 분석", "gemini", step2_video_analysis.MODEL),
    "step4_gemini": ("STEP 4 구간 분리", "gemini", step4_segmentation.MODEL),
    "step5_openai": ("STEP 5 피드백", "openai", step5_feedback.MODEL),
}

PING_PROMPT = "Reply with exactly: OK"
TIMEOUT_SEC = 30


class TargetInfo(BaseModel):
    target: str
    label: str
    provider: str
    model: str
    key_configured: bool


class HealthOverview(BaseModel):
    targets: list[TargetInfo]
    whisper_model: str   # STEP 3 STT — 외부 API 가 아니라 서버에서 직접 돌림


class PingResult(BaseModel):
    target: str
    model: str
    ok: bool
    latency_ms: int
    reply: str | None = None
    error: str | None = None


def _key_for(provider: str) -> str:
    return settings.gemini_api_key if provider == "gemini" else settings.openai_api_key


@router.get("/health", response_model=HealthOverview)
def health_overview():
    return HealthOverview(
        targets=[
            TargetInfo(target=t, label=label, provider=provider, model=model,
                       key_configured=bool(_key_for(provider)))
            for t, (label, provider, model) in TARGETS.items()
        ],
        whisper_model=settings.whisper_model,
    )


def _ping_gemini(model: str) -> str:
    from google import genai

    client = genai.Client(api_key=settings.gemini_api_key)
    resp = client.models.generate_content(model=model, contents=PING_PROMPT)
    return (resp.text or "").strip()


def _ping_openai(model: str) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key, timeout=TIMEOUT_SEC, max_retries=0)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": PING_PROMPT}],
        max_tokens=5,
    )
    return (resp.choices[0].message.content or "").strip()


@router.post("/health/{target}", response_model=PingResult)
def ping(target: Target):
    """모델에 짧은 요청 1건. 실패해도 500 이 아니라 ok=false + 에러 문구로 돌려준다
    — 점검 화면에서는 "실패했다는 사실과 이유"가 곧 결과이기 때문."""
    _, provider, model = TARGETS[target]
    if not _key_for(provider):
        raise HTTPException(400, f"{provider.upper()}_API_KEY 가 서버에 설정되지 않았습니다.")

    t0 = time.perf_counter()
    try:
        reply = _ping_gemini(model) if provider == "gemini" else _ping_openai(model)
        ok, error = True, None
    except Exception as exc:  # noqa: BLE001 — 어떤 오류든 화면에 그대로 보여준다
        reply, ok, error = None, False, f"{type(exc).__name__}: {exc}"[:500]
    latency_ms = int((time.perf_counter() - t0) * 1000)

    return PingResult(target=target, model=model, ok=ok, latency_ms=latency_ms,
                      reply=reply, error=error)
