// 마운트 prefix 보정 shim.
// devtools/server.py 가 각 앱을 /vlm, /voice 아래에 마운트하므로 페이지 안의
// 절대 경로(`/api/...`)는 부모 앱으로 새어 404 가 난다. fetch/EventSource 를
// 감싸서 APP_BASE 를 앞에 붙인다. 각 페이지는 이 스크립트를 **가장 먼저** 로드할 것.
(function () {
  const base = window.APP_BASE || "";
  if (!base) return;
  const fix = u => (typeof u === "string" && u.startsWith("/") && !u.startsWith(base))
    ? base + u : u;

  const _fetch = window.fetch;
  window.fetch = (u, o) => _fetch(fix(u), o);

  const _ES = window.EventSource;
  window.EventSource = function (u, o) { return new _ES(fix(u), o); };

  // innerHTML 로 만들어지는 <audio src="/..."> 등을 위해 노출
  window.withBase = fix;
})();
