// 로그인 토큰 보관함 — 브라우저 localStorage 에 저장한다.
//
// 토큰 두 개 (백엔드 POST /auth/login 응답):
//   - access 토큰 : API 요청마다 "Authorization: Bearer ..." 로 붙이는 입장권. 60분짜리.
//   - refresh 토큰: access 가 만료됐을 때 새 토큰을 받는 데만 쓴다. 14일짜리 (= 로그인 유지 기간).
//
// localStorage 는 탭을 닫아도 남아서 다시 열었을 때 로그인이 유지된다.
// 서버(Next.js)에서 실행될 때는 window 가 없으므로 항상 "없음"으로 처리한다.

const ACCESS_KEY = "podium_access_token";
const REFRESH_KEY = "podium_refresh_token";

export function saveTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// refresh 토큰이 있으면 "로그인된 상태"로 본다 (access 가 만료됐어도 refresh 로 다시 받을 수 있으니까).
export function isLoggedIn(): boolean {
  return getRefreshToken() !== null;
}
