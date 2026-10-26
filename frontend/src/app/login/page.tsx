"use client";

// 로그인 페이지 — POST /auth/login 으로 토큰을 받아 저장하고 대시보드로 이동한다.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Lock, Loader2, Eye, EyeOff } from "lucide-react";
import { PodiumLogo } from "@/components/ServiceGuide";
import Link from "next/link";
import { API_BASE, apiFetch, errorMessage } from "@/utils/api";
import { saveTokens } from "@/utils/auth";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password.trim()) {
      setError("이메일과 비밀번호를 모두 입력해주세요.");
      return;
    }
    if (!email.includes("@")) {
      setError("이메일 형식이 올바르지 않습니다.");
      return;
    }

    setLoading(true);
    try {
      // 로그인은 아직 토큰이 없으니 apiFetch 가 아니라 fetch 로 직접 부른다.
      // (apiFetch 는 401 이면 로그인 화면으로 보내버리는데, 여기선 "비밀번호 틀림"을 보여줘야 함)
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "로그인에 실패했어요. 잠시 후 다시 시도해주세요."));
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

        {/* 로그인 카드 */}
        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
          <h2 className="text-lg font-bold text-stone-800 mb-6">로그인</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-stone-600 mb-1.5">이메일</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-stone-600 mb-1.5">비밀번호</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="비밀번호"
                  className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-500 font-medium">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-700 disabled:opacity-60 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              로그인
            </button>
          </form>

          <p className="text-center text-sm text-stone-500 mt-6">
            아직 계정이 없으신가요?{" "}
            <Link href="/signup" className="text-stone-900 font-semibold hover:underline">
              회원가입
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
