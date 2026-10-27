"use client";

// 로그인 페이지 — 구글 로그인만 지원한다 (이메일 가입은 없앴다).
// 버튼을 누르면 백엔드 /auth/google/login 으로 이동 → 구글 → /auth/callback 에서 토큰을 받는다.
// 실패하면 백엔드가 /login#error=... 로 돌려보낸다.
// 로컬 개발(백엔드 DEBUG)에서만 예전 이메일·비밀번호 로그인 폼을 함께 보여준다.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { PodiumLogo } from "@/components/ServiceGuide";
import Link from "next/link";
import { API_BASE, apiFetch, errorMessage } from "@/utils/api";
import { saveTokens } from "@/utils/auth";

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<{ google: boolean; password: boolean } | null>(null);
  const [error, setError] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  // 개발용 이메일 로그인
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 백엔드가 실패 사유를 #error=... 로 붙여 돌려보낸다. 한 번 읽고 주소에서 지운다.
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const err = hash.get("error");
    if (err) {
      setError(err);
      window.history.replaceState(null, "", window.location.pathname);
    }
    fetch(`${API_BASE}/auth/providers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => setProviders(p ?? { google: true, password: false }))
      .catch(() => setProviders({ google: true, password: false }));
  }, []);

  const loginWithGoogle = () => {
    setRedirecting(true);
    const next = new URLSearchParams(window.location.search).get("next") || "/dashboard";
    window.location.href = `${API_BASE}/auth/google/login?next=${encodeURIComponent(next)}`;
  };

  const loginWithPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("이메일과 비밀번호를 모두 입력해주세요.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "로그인에 실패했어요."));
        return;
      }
      const data = await res.json();
      saveTokens(data.access_token, data.refresh_token);
      // 프로필 화면을 아직 안 거쳤으면(첫 로그인) 먼저 보낸다. 확인에 실패하면 그냥 대시보드로.
      const me = await apiFetch("/auth/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      router.push(me && !me.profile_completed_at ? "/profile?welcome=1" : "/dashboard");
    } catch {
      setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4 font-['Pretendard_Variable',Pretendard,sans-serif]">
      <div className="w-full max-w-sm">
        {/* 로고 — 누르면 첫 화면(랜딩)으로 */}
        <Link href="/" className="flex justify-center mb-8 group">
          <PodiumLogo className="h-10 w-auto group-hover:opacity-70 transition-opacity" />
        </Link>

        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
          <h2 className="text-lg font-bold text-stone-800">시작하기</h2>
          <p className="text-sm text-stone-500 mt-1 mb-6">구글 계정으로 바로 로그인하세요. 처음이면 자동으로 가입돼요.</p>

          <button
            onClick={loginWithGoogle}
            disabled={redirecting || providers?.google === false}
            className="w-full flex items-center justify-center gap-3 bg-white border border-stone-300 hover:bg-stone-50 disabled:opacity-60 text-stone-700 text-sm font-bold py-3 rounded-xl transition-colors"
          >
            {redirecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <GoogleLogo />}
            Google로 계속하기
          </button>
          {providers?.google === false && (
            <p className="text-xs text-amber-700 mt-2">서버에 구글 로그인이 아직 설정되지 않았어요.</p>
          )}

          <p className="text-xs text-stone-400 text-center mt-3">
            계속하면{" "}
            <Link href="/terms" className="underline hover:text-stone-600">이용약관</Link>과{" "}
            <Link href="/privacy" className="underline hover:text-stone-600">개인정보 처리방침</Link>에 동의하게 돼요.
          </p>

          {error && <p className="text-sm text-red-500 font-medium mt-4">{error}</p>}

          {providers?.password && (
            <form onSubmit={loginWithPassword} className="mt-8 pt-6 border-t border-dashed border-stone-200 space-y-3">
              <p className="text-xs font-bold text-stone-400">개발용 이메일 로그인 (로컬에서만 보여요)</p>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="비밀번호"
                className="w-full px-3 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-700 disabled:opacity-60 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                이메일로 로그인
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
