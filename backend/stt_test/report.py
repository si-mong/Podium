"""검증 도구 — 필러 후보를 클립으로 잘라내고 청취/라벨링 HTML 을 생성.

3-3 이 실제로 작동하는지는 임계값을 노려보는 걸로는 알 수 없음. 후보 구간을
**직접 듣는 게** 가장 빠른 판정이고, 듣는 김에 정답 라벨까지 찍으면
그대로 precision/recall 계산용 ground truth 가 됨 (→ evaluate.py).

생성물:
    out/<name>/result.json      analyze() 전체 출력
    out/<name>/clips/*.wav      후보별 클립 (앞뒤 문맥 포함)
    out/<name>/report.html      청취 + 라벨링 페이지
    out/<name>/labels.json      (사용자가 페이지에서 내려받아 저장)
"""
from __future__ import annotations

import json
from pathlib import Path

from app.pipeline.voice.audio import load_wav, slice_samples, write_wav

# 클립 앞뒤로 붙이는 문맥(초). 필러는 앞뒤 발화가 있어야 필러인지 판단됨.
CLIP_CONTEXT_SEC = 0.8


def write_clips(result: dict, wav_path: Path, out_dir: Path, prefix: str = "cand") -> None:
    """후보 구간을 앞뒤 문맥 포함해 wav 로 잘라내고, 각 후보에 `clip`/`index` 를 채움.

    서버 UI 와 정적 report.html 이 공유하는 단계.
    """
    clips_dir = out_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    samples, sr = load_wav(wav_path)

    for i, c in enumerate(result["diagnostics"]["candidates"]):
        seg = slice_samples(
            samples, sr,
            c["t_start"] - CLIP_CONTEXT_SEC,
            c["t_end"] + CLIP_CONTEXT_SEC,
        )
        name = f"{prefix}_{i:04d}.wav"
        write_wav(clips_dir / name, seg, sr)
        c["clip"] = f"clips/{name}"
        c["index"] = i


def build_report(result: dict, wav_path: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    write_clips(result, wav_path, out_dir)

    (out_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    html_path = out_dir / "report.html"
    html_path.write_text(_render_html(result), encoding="utf-8")
    return html_path


def _render_html(result: dict) -> str:
    m = result["metrics"]
    d = result["diagnostics"]
    payload = json.dumps(d["candidates"], ensure_ascii=False)
    metrics_rows = "".join(
        f"<div class='m'><span>{k}</span><b>{v}</b></div>" for k, v in m.items()
    )
    return _TEMPLATE.replace("__METRICS__", metrics_rows) \
                    .replace("__CANDIDATES__", payload) \
                    .replace("__SOURCE__", str(d["source"])) \
                    .replace("__MODEL__", str(d["model_size"])) \
                    .replace("__REFDB__", str(d["speech_reference_db"]))


_TEMPLATE = r"""<!doctype html>
<meta charset="utf-8">
<title>STEP 3 필러 후보 검증</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif;
         margin: 0; padding: 24px; max-width: 1400px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { opacity: .65; font-size: 13px; margin-bottom: 16px; }
  .metrics { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .m { border: 1px solid #8883; border-radius: 8px; padding: 6px 10px; font-size: 12px; }
  .m span { opacity: .6; margin-right: 6px; }
  .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  button { font: inherit; padding: 5px 12px; border-radius: 7px; border: 1px solid #8886;
           background: transparent; cursor: pointer; }
  button.on { background: #4a7dff; color: #fff; border-color: #4a7dff; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border-bottom: 1px solid #8882; padding: 6px 8px; text-align: left; vertical-align: middle; }
  th { position: sticky; top: 0; background: Canvas; font-size: 12px; opacity: .7; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  audio { height: 30px; width: 190px; }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 20px; border: 1px solid #8886; }
  .ok { background: #16a34a22; border-color: #16a34a; }
  .no { background: #88888822; }
  .lex { background: #a855f722; border-color: #a855f7; }
  .ctx { max-width: 300px; opacity: .75; font-size: 12px; }
  .lb button { padding: 3px 9px; font-size: 12px; }
  .lb button.y.on { background: #16a34a; border-color: #16a34a; color: #fff; }
  .lb button.n.on { background: #dc2626; border-color: #dc2626; color: #fff; }
  .lb button.q.on { background: #ca8a04; border-color: #ca8a04; color: #fff; }
  .stat { margin-left: auto; font-size: 12px; opacity: .8; }
</style>

<h1>STEP 3 — 필러 후보 검증</h1>
<div class="sub">__SOURCE__ · model=__MODEL__ · 발화 기준 레벨 __REFDB__ dB</div>
<div class="metrics">__METRICS__</div>

<div class="bar">
  <span style="opacity:.6">보기</span>
  <button data-f="all" class="on">전체</button>
  <button data-f="yes">채택된 필러</button>
  <button data-f="no">기각</button>
  <button data-f="lexical">어휘 기반</button>
  <span style="width:16px"></span>
  <button id="dl">라벨 JSON 내려받기</button>
  <span class="stat" id="stat"></span>
</div>

<table>
  <thead><tr>
    <th>#</th><th>시간</th><th>길이</th><th>듣기</th><th>정답 라벨</th>
    <th>판정</th><th>기각 사유</th><th class="num">상대dB</th>
    <th class="num">유성비</th><th class="num">F0편차<br>(반음)</th><th>문맥</th>
  </tr></thead>
  <tbody id="tb"></tbody>
</table>

<script>
const CANDS = __CANDIDATES__;
const KEY = "podium_step3_labels_" + location.pathname;
let labels = JSON.parse(localStorage.getItem(KEY) || "{}");
let filter = "all";

function fmt(t){ const m=Math.floor(t/60), s=(t%60).toFixed(1).padStart(4,"0"); return m+":"+s; }

function visible(c){
  if (filter === "all") return true;
  if (filter === "yes") return c.is_filler;
  if (filter === "no")  return !c.is_filler;
  if (filter === "lexical") return c.source === "lexical";
}

function setLabel(i, v){
  if (labels[i] === v) delete labels[i]; else labels[i] = v;
  localStorage.setItem(KEY, JSON.stringify(labels));
  render();
}

function stat(){
  const n = Object.keys(labels).length;
  let tp=0, fp=0;
  CANDS.forEach(c => {
    const l = labels[c.index];
    if (l === undefined) return;
    if (c.is_filler && l === "y") tp++;
    if (c.is_filler && l === "n") fp++;
  });
  const prec = (tp+fp) ? (tp/(tp+fp)*100).toFixed(0)+"%" : "–";
  document.getElementById("stat").textContent =
    `라벨 ${n}/${CANDS.length} · 채택분 precision ${prec} (TP ${tp} / FP ${fp})`;
}

function render(){
  const tb = document.getElementById("tb");
  tb.innerHTML = "";
  CANDS.filter(visible).forEach(c => {
    const tr = document.createElement("tr");
    const l = labels[c.index];
    const verdict = c.source === "lexical"
      ? `<span class="tag lex">어휘 «${c.text ?? ""}»</span>`
      : (c.is_filler ? `<span class="tag ok">필러</span>` : `<span class="tag no">기각</span>`);
    tr.innerHTML = `
      <td class="num">${c.index}</td>
      <td class="num">${fmt(c.t_start)}</td>
      <td class="num">${c.duration.toFixed(2)}s</td>
      <td><audio controls preload="none" src="${c.clip}"></audio></td>
      <td class="lb">
        <button class="y ${l==="y"?"on":""}" data-i="${c.index}" data-v="y">필러</button>
        <button class="n ${l==="n"?"on":""}" data-i="${c.index}" data-v="n">아님</button>
        <button class="q ${l==="q"?"on":""}" data-i="${c.index}" data-v="q">모호</button>
      </td>
      <td>${verdict}</td>
      <td style="opacity:.6">${c.reject_reason ?? ""}</td>
      <td class="num">${c.relative_db?.toFixed(1) ?? ""}</td>
      <td class="num">${c.voiced_ratio?.toFixed(2) ?? ""}</td>
      <td class="num">${c.f0_std_semitone?.toFixed(2) ?? ""}</td>
      <td class="ctx">${(c.context_text||"").replace(/</g,"&lt;")}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll(".lb button").forEach(b =>
    b.onclick = () => setLabel(+b.dataset.i, b.dataset.v));
  stat();
}

document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => {
  document.querySelectorAll("[data-f]").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); filter = b.dataset.f; render();
});

document.getElementById("dl").onclick = () => {
  const rows = CANDS.map(c => ({
    index: c.index, t_start: c.t_start, t_end: c.t_end,
    source: c.source, predicted: c.is_filler, label: labels[c.index] ?? null
  }));
  const blob = new Blob([JSON.stringify(rows, null, 2)], {type: "application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "labels.json"; a.click();
};

render();
</script>
"""
