// 공용 네비게이션 — STEP 2(영상) / STEP 3(음성) 전 페이지가 이 파일 하나를 쓴다.
//
// 사용법: <div id="nav-mount"></div> + <script src="/shared/nav.js"></script>
// `/shared` 는 부모 앱(devtools/server.py)이 서빙하므로 어느 하위 앱에서 불러도 동일.
//
// 2단 구조:
//   1단 모듈 바   STEP 2 / STEP 3 — **모든 페이지에서 동일**
//   2단 서브 메뉴  현재 모듈의 하위 페이지. 하위 페이지가 없는 모듈은 이 줄이 생략됨.
(function () {
  const MODULES = [
    {
      base: "/vlm/", text: "STEP 2 영상",
      groups: [
        { label: "테스트", items: [
          { url: "/vlm/smart-analyze", text: "스마트 분석" },
          { url: "/vlm/",              text: "v1 분석" },
          { url: "/vlm/smart-preview", text: "청크 계획 (시뮬)" },
          { url: "/vlm/preview",       text: "v1 임계값 (시뮬)" },
        ]},
        { label: "기록", items: [
          { url: "/vlm/smart-analyze/history", text: "스마트 분석 결과" },
          { url: "/vlm/history",               text: "v1 분석 결과" },
          { url: "/vlm/smart-preview/history", text: "스마트 청킹 기록" },
          { url: "/vlm/preview/history",       text: "v1 시뮬 기록" },
        ]},
      ],
    },
    {
      base: "/voice/", text: "STEP 3·4 음성",
      groups: [
        { label: "테스트", items: [
          { url: "/voice/",         text: "STEP 3 음성분석" },
          { url: "/voice/segments", text: "STEP 4 구간분리" },
        ]},
      ],
    },
    {
      base: "/voice/run", text: "STEP1~4 통합",
      groups: [],
    },
    {
      base: "/voice/step5", text: "STEP 5 종합피드백",
      groups: [],
    },
  ];

  // 페이지마다 body 폭·색이 달라 토큰을 못 쓰므로 투명도/테두리 기반으로 칠한다.
  const CSS = `
    .pd-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      padding:0 0 10px; font:13px/1.6 -apple-system, BlinkMacSystemFont,
      "Apple SD Gothic Neo", "Segoe UI", sans-serif; }
    .pd-brand { font-size:12px; font-weight:600; opacity:.45;
      letter-spacing:.04em; margin-right:6px; }
    .pd-mod { color:inherit; text-decoration:none; font-size:13px; font-weight:500;
      padding:5px 14px; border-radius:8px; border:1px solid #8884; }
    .pd-mod:hover { border-color:#4a7dff; text-decoration:none; }
    .pd-mod.active { background:#4a7dff; color:#fff; border-color:#4a7dff; }
    .pd-sub { display:flex; align-items:center; gap:16px; flex-wrap:wrap;
      padding:8px 0 10px; border-top:1px solid #8883;
      font:13px/1.6 -apple-system, BlinkMacSystemFont,
      "Apple SD Gothic Neo", "Segoe UI", sans-serif; }
    .pd-group { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
    .pd-label { font-size:11px; font-weight:600; opacity:.45;
      text-transform:uppercase; letter-spacing:.06em; padding-right:4px; }
    .pd-link { color:inherit; text-decoration:none; font-size:13px;
      padding:3px 9px; border-radius:6px; border:1px solid transparent; }
    .pd-link:hover { border-color:#8884; text-decoration:none; }
    .pd-link.active { background:#11182710; border-color:#8886; font-weight:600; }
    .pd-nav-wrap { margin:0 0 18px; border-bottom:1px solid #8883; }
  `;

  const esc = s => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;");

  const path = () => location.pathname.replace(/\/+$/, "") || "/";
  const norm = u => u.replace(/\/+$/, "") || "/";
  const inModule = base => path() === norm(base) || location.pathname.startsWith(norm(base) + "/");
  const isHere = url => path() === norm(url);

  function render() {
    if (!document.getElementById("pd-nav-style")) {
      const st = document.createElement("style");
      st.id = "pd-nav-style"; st.textContent = CSS;
      document.head.appendChild(st);
    }
    const mount = document.getElementById("nav-mount");
    if (!mount) return;

    // base 가 서로의 접두사인 경우("/voice/" vs "/voice/step5")가 있어
    // 배열 순서가 아니라 **가장 구체적으로 일치하는 것**을 고른다.
    const current = MODULES.filter(m => inModule(m.base))
      .sort((a, b) => norm(b.base).length - norm(a.base).length)[0];

    // 1단 — 모든 페이지 동일
    const bar = `<div class="pd-bar">
      <span class="pd-brand">PODIUM 개발 테스트</span>
      ${MODULES.map(m =>
        `<a class="pd-mod${m === current ? " active" : ""}" href="${esc(m.base)}">${esc(m.text)}</a>`
      ).join("")}
    </div>`;

    // 2단 — 현재 모듈에 하위 페이지가 있을 때만
    const sub = (current && current.groups.length)
      ? `<div class="pd-sub">` + current.groups.map(g =>
          `<div class="pd-group"><span class="pd-label">${esc(g.label)}</span>` +
          g.items.map(it =>
            `<a class="pd-link${isHere(it.url) ? " active" : ""}" href="${esc(it.url)}">${esc(it.text)}</a>`
          ).join("") + `</div>`).join("") + `</div>`
      : "";

    mount.outerHTML = `<div class="pd-nav-wrap">${bar}${sub}</div>`;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
