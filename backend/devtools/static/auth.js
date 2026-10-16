// 본 API 서버(:8000) 로그인 도우미 — 실제 DB 세션을 다루는 테스트 페이지 공용.
//
// 본 API 는 /auth 로 받은 토큰이 있어야 프로젝트·세션을 만질 수 있다. 테스트 페이지마다
// 로그인을 따로 구현하지 않도록 여기에 모은다. 토큰은 이 테스트 서버(:8001)의
// localStorage 에 저장되므로 한 번 로그인하면 모든 테스트 페이지에서 유지된다.
// (본 프론트엔드(:3000)와는 저장소가 달라 로그인이 공유되지 않음)
//
// 사용법:
//   <script src="/shared/auth.js"></script>
//   PodiumAuth.mount(document.getElementById("auth"), loggedIn => { ... });
//   const r = await PodiumAuth.apiFetch("/projects");          // 본 API 호출 (토큰 자동 첨부)
//   fetch("/api/...", {headers: PodiumAuth.authHeader()});     // 테스트 서버 중계 API 에 토큰 전달
(function () {
  const MAIN_API = "http://localhost:8000";
  const K = { access: "podium_dev_access", refresh: "podium_dev_refresh", email: "podium_dev_email" };

  const get = k => localStorage.getItem(K[k]);
  const save = (access, refresh, email) => {
    localStorage.setItem(K.access, access);
    localStorage.setItem(K.refresh, refresh);
    if (email) localStorage.setItem(K.email, email);
  };
  const clear = () => Object.values(K).forEach(k => localStorage.removeItem(k));

  const listeners = [];
  const notify = () => listeners.forEach(fn => fn());

  async function login(email, password) {
    const r = await fetch(`${MAIN_API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : `로그인 실패 (${r.status})`);
    save(d.access_token, d.refresh_token, email);
    notify();
  }

  async function logout() {
    const refresh = get("refresh");
    if (refresh) {
      await fetch(`${MAIN_API}/auth/logout`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      }).catch(() => {});
    }
    clear();
    notify();
  }

  // refresh 토큰은 한 번 쓰면 폐기되므로(회전) 동시에 여러 번 부르지 않게 Promise 를 공유한다.
  let refreshing = null;
  function refreshOnce() {
    if (!refreshing) {
      refreshing = (async () => {
        const refresh = get("refresh");
        if (!refresh) return false;
        const r = await fetch(`${MAIN_API}/auth/refresh`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refresh }),
        }).catch(() => null);
        if (!r || !r.ok) return false;
        const d = await r.json();
        save(d.access_token, d.refresh_token);
        return true;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  const authHeader = () => (get("access") ? { Authorization: `Bearer ${get("access")}` } : {});

  // 본 API 호출. 401 이면 토큰을 새로 받아 한 번만 다시 시도, 그래도 401 이면 로그아웃 상태로.
  async function apiFetch(path, options = {}) {
    const send = () => fetch(`${MAIN_API}${path}`, {
      ...options, headers: { ...(options.headers || {}), ...authHeader() },
    });
    let r;
    try {
      r = await send();
    } catch {
      // 서버가 꺼져 있을 때뿐 아니라 **서버 내부 오류(500)** 때도 여기로 온다 —
      // 500 응답엔 CORS 헤더가 없어 브라우저가 응답 자체를 막기 때문.
      throw new Error(`본 API 서버(${MAIN_API}) 응답을 받지 못했습니다 — 서버가 꺼져 있거나 서버 내부 오류입니다. 본 API 터미널 로그를 확인하세요.`);
    }
    if (r.status !== 401) return r;
    if (await refreshOnce()) {
      const retry = await send();
      if (retry.status !== 401) return retry;
    }
    clear();
    notify();
    return r;
  }

  // 로그인 상자. 로그인 상태가 바뀔 때마다 onChange(loggedIn) 호출.
  function mount(el, onChange) {
    const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const render = () => {
      if (get("refresh")) {
        el.innerHTML = `<div class="pa-row"><span>로그인: <b>${esc(get("email"))}</b></span>
          <button type="button" class="pa-out">로그아웃</button></div>`;
        el.querySelector(".pa-out").onclick = logout;
      } else {
        el.innerHTML = `<form class="pa-row">
          <input type="email" class="pa-email" placeholder="이메일" autocomplete="username" required>
          <input type="password" class="pa-pw" placeholder="비밀번호" autocomplete="current-password" required>
          <button type="submit" class="primary">로그인</button>
          <span class="pa-err"></span></form>
          <div class="pa-hint">본 API(:8000)에 가입한 계정으로 로그인합니다. 없으면 본 프론트(:3000)에서 먼저 가입하세요.</div>`;
        el.querySelector("form").onsubmit = async e => {
          e.preventDefault();
          const err = el.querySelector(".pa-err");
          err.textContent = "";
          try {
            await login(el.querySelector(".pa-email").value, el.querySelector(".pa-pw").value);
          } catch (ex) {
            err.textContent = ex.message;
          }
        };
      }
      onChange && onChange(Boolean(get("refresh")));
    };
    listeners.push(render);
    render();
  }

  if (!document.getElementById("pa-style")) {
    const st = document.createElement("style");
    st.id = "pa-style";
    st.textContent = `
      .pa-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .pa-err { color:#dc2626; font-size:12px; }
      .pa-hint { font-size:12px; opacity:.6; margin-top:6px; }`;
    (document.head || document.documentElement).appendChild(st);
  }

  window.PodiumAuth = {
    MAIN_API, login, logout, apiFetch, authHeader, mount,
    isLoggedIn: () => Boolean(get("refresh")),
  };
})();
