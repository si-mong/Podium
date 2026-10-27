// 분석 실행 (STEP 3~5) — 전처리(/end)가 끝난 세션에 분석 단계를 차례로 호출한다.
// 촬영·업로드 화면(record)의 "분석 시작"이 쓴다. (관리자 "다시 분석하기"를 다시 만들 때도 이걸 쓰면 된다)
//
// 순서: 음성 → 구간 분리 → 동작 → 구간 피드백 → 종합 피드백.
// 동작은 구간을 기준으로 잘라 보내므로 구간 분리가 먼저 끝나야 한다.
// 음성·구간 분리가 실패하면 뒤 단계를 할 수 없어 멈추고(예외), 나머지는 실패해도 경고만 남기고 넘어간다.

import { apiFetch } from "./api";

export type LogLevel = "info" | "success" | "warn" | "error";

export interface AnalysisCallbacks {
  onStep?: (label: string) => void;                  // 지금 하는 단계 (진행 표시용 한 줄)
  onLog?: (message: string, level?: LogLevel) => void;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// 분석 단계 하나를 호출한다. 실패하면 서버가 알려준 이유(detail)를 담아 에러를 던진다.
async function callStep(sessionId: string | number, path: string) {
  const res = await apiFetch(`/sessions/${sessionId}${path}`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function runAnalysis(sessionId: string | number, { onStep, onLog }: AnalysisCallbacks = {}) {
  const step = (label: string) => onStep?.(label);
  const log = (message: string, level?: LogLevel) => onLog?.(message, level);

  step("목소리를 분석하는 중이에요 (몇 분 정도 걸려요)");
  log("목소리를 살펴보고 있어요...");
  try {
    await callStep(sessionId, "/analyze/voice");
  } catch (err) {
    // 음성 결과 없이는 구간을 나눌 수 없어서 실패하면 멈춘다.
    throw new Error(`음성 분석 실패: ${errText(err)}`);
  }
  log("목소리 분석을 마쳤어요.", "success");

  step("발표 내용을 구간으로 나누는 중이에요");
  const seg = await callStep(sessionId, "/analyze/segments");
  log(`발표를 ${seg.segment_count}개 구간으로 나눴어요.`, "success");

  step("구간별로 동작을 분석하는 중이에요");
  log("동작을 살펴보고 있어요...");
  try {
    await callStep(sessionId, "/analyze/motion-by-segment");
    log("동작 분석을 마쳤어요.", "success");
  } catch {
    // 영상 분석은 실패해도 계속 진행한다 (제스처 값만 비게 됨).
    log("동작 분석에 문제가 있었지만, 나머지는 계속 진행할게요.", "warn");
  }

  // 구간별 피드백은 실패해도 앞 단계 결과는 볼 수 있으니 경고만 남기고 넘어간다.
  step("구간별로 자세한 피드백을 만드는 중이에요");
  try {
    await callStep(sessionId, "/analyze/segment-feedback");
    log("구간별 피드백이 완성됐어요!", "success");
  } catch {
    log("구간별 피드백 생성에는 실패했어요. 다른 결과는 확인할 수 있어요.", "warn");
  }

  // 종합 피드백(발표 전체 총평)도 마찬가지로 실패해도 넘어간다.
  step("전체 총평을 정리하는 중이에요");
  try {
    await callStep(sessionId, "/analyze/overall-feedback");
    log("전체 총평까지 완성됐어요!", "success");
  } catch {
    log("총평 생성에는 실패했어요. 나머지 결과는 확인할 수 있어요.", "warn");
  }
}
