// 백엔드 API 호출 도우미. 페이지에서는 fetch() 대신 apiFetch() 를 쓴다.
//
// apiFetch 가 해주는 일:
//   1) 요청마다 access 토큰을 "Authorization: Bearer ..." 헤더로 자동으로 붙인다.
//   2) 401(토큰 만료·없음)이 오면 refresh 토큰으로 새 토큰을 받아 **딱 한 번** 다시 시도한다.
//   3) 그래도 401 이면 토큰을 지우고 로그인 화면으로 보낸다.

import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from "./auth";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// 새 토큰 받기가 진행 중이면 그 약속(Promise)을 여기 담아둔다.
// 촬영 페이지처럼 요청 여러 개가 동시에 401 을 받아도 refresh 는 한 번만 부르기 위함 —
// 백엔드는 refresh 토큰을 한 번 쓰면 폐기(회전)하므로, 두 번 부르면 두 번째는 실패한다.
let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    saveTokens(data.access_token, data.refresh_token);
    return true;
  } catch {
    return false;
  }
}

function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    refreshing = refreshTokens().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

// 로그인 화면으로 보낸다. 이미 로그인 화면이면 그대로 둔다.
export function goToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

// path 는 "/projects" 처럼 API_BASE 뒤에 붙는 부분만 넘긴다.
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const send = () => {
    const headers = new Headers(options.headers);
    const token = getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${API_BASE}${path}`, { ...options, headers });
  };

  const res = await send();
  if (res.status !== 401) return res;

  // access 토큰이 만료됐을 수 있다 → 새로 받아서 한 번만 다시 시도
  if (await refreshOnce()) {
    const retry = await send();
    if (retry.status !== 401) return retry;
  }

  // refresh 도 실패 = 로그인이 풀린 것
  clearTokens();
  goToLogin();
  return res;
}

// 서버가 보낸 오류 메시지(detail)를 사람이 읽을 문장으로 꺼낸다.
// FastAPI 는 detail 이 문자열일 때도, 입력 검증 실패(422)처럼 목록일 때도 있다.
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  // 입력 검증 실패는 "Value error, 비밀번호에 공백을..." 처럼 앞에 영어가 붙어 와서 떼어낸다.
  if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg).replace(/^Value error, /, "");
  return fallback;
}
