// 공통 네비게이션 바.
// 모든 페이지에서 <div id="nav-mount"></div> + <script src="/static/nav.js">로 로드.
// 메뉴 변경은 이 파일만 수정하면 모든 페이지에 반영됨.

(function () {
  // ─────────────────────────────────────────────────────────────────────
  // 메뉴 정의 — "테스트(실행)" 와 "기록(보기)" 두 그룹으로 분리
  // ─────────────────────────────────────────────────────────────────────
  const NAV_GROUPS = [
    {
      label: "테스트",
      items: [
        { url: "/smart-analyze",  text: "★ 스마트 분석" },
        { url: "/",               text: "v1 분석" },
        { url: "/smart-preview",  text: "청크 계획 (시뮬)" },
        { url: "/preview",        text: "v1 임계값 (시뮬)" },
      ],
    },
    {
      label: "기록",
      items: [
        { url: "/smart-analyze/history",   text: "★ 스마트 분석 결과" },
        { url: "/history",                 text: "v1 분석 결과" },
        { url: "/smart-preview/history",   text: "스마트 청킹 기록" },
        { url: "/preview/history",         text: "v1 시뮬 기록" },
      ],
    },
  ];

  // ─────────────────────────────────────────────────────────────────────
  // 스타일 — 한 곳에서 관리
  // ─────────────────────────────────────────────────────────────────────
  const CSS = `
    .pd-nav {
      display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
      padding: 10px 0 14px;
      border-bottom: 1px solid #eee;
      margin-bottom: 18px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .pd-nav-group {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .pd-nav-label {
      font-size: 11.5px; font-weight: 700; color: #888;
      text-transform: uppercase; letter-spacing: 0.6px;
      padding-right: 4px;
    }
    .pd-nav-link {
      color: #1565c0; text-decoration: none;
      font-size: 13.5px; padding: 4px 10px; border-radius: 5px;
      transition: background 0.1s;
    }
    .pd-nav-link:hover { background: #f0f4f9; text-decoration: none; }
    .pd-nav-link.active {
      background: #111; color: #fff; font-weight: 600;
    }
    .pd-nav-sep {
      color: #ddd; user-select: none;
    }
  `;

  // ─────────────────────────────────────────────────────────────────────
  // 렌더
  // ─────────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function render() {
    // 스타일 1회 주입
    if (!document.getElementById("pd-nav-style")) {
      const s = document.createElement("style");
      s.id = "pd-nav-style";
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    const mount = document.getElementById("nav-mount");
    if (!mount) return;

    const here = window.location.pathname;

    const groupsHtml = NAV_GROUPS.map((g) => {
      const items = g.items.map((it) => {
        const active = it.url === here ? "active" : "";
        return `<a href="${it.url}" class="pd-nav-link ${active}">${escapeHtml(it.text)}</a>`;
      }).join("");
      return `
        <div class="pd-nav-group">
          <span class="pd-nav-label">${escapeHtml(g.label)}</span>
          ${items}
        </div>
      `;
    }).join('<span class="pd-nav-sep">|</span>');

    mount.innerHTML = `<nav class="pd-nav">${groupsHtml}</nav>`;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
