"use client";

// 회원가입 페이지 — POST /auth/signup 으로 계정을 만들고 로그인 페이지로 보낸다.
// (백엔드는 가입 때 토큰을 주지 않는다 → 로그인은 따로 한 번 해야 함)
// 백엔드가 이메일·비밀번호만 받아서 "이름" 칸은 없앴다.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart2, Mail, Lock, Loader2, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { API_BASE, errorMessage } from "@/utils/api";

export default function SignupPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password.trim() || !passwordConfirm.trim()) {
      setError("모든 항목을 입력해주세요.");
      return;
    }
    if (!email.includes("@")) {
      setError("이메일 형식이 올바르지 않습니다.");
      return;
    }
    if (password.length < 8) {
      setError("비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        // 이미 가입된 이메일(409), 비밀번호 규칙 위반(422) 등 — 서버가 보낸 한국어 문구를 그대로 보여준다.
        setError(await errorMessage(res, "회원가입에 실패했어요. 잠시 후 다시 시도해주세요."));
        return;
      }
      alert("회원가입이 완료됐어요! 로그인해주세요.");
      router.push("/login");
    } catch {
      setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-sm">
        {/* 로고 */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="bg-blue-600 p-3 rounded-2xl shadow-sm shadow-blue-200">
            <BarChart2 className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-extrabold text-slate-800 tracking-tight">발표 영상 분석</h1>
        </div>

        {/* 회원가입 카드 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h2 className="text-lg font-bold text-slate-800 mb-6">회원가입</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-slate-600 mb-1.5">이메일</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-600 mb-1.5">비밀번호</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8자 이상, 영문·숫자·특수기호 (공백 불가)"
                  className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-600 mb-1.5">비밀번호 확인</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  placeholder="비밀번호 재입력"
                  className="w-full pl-10 pr-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-500 font-medium">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              회원가입
            </button>
          </form>

          <p className="text-center text-sm text-slate-500 mt-6">
            이미 계정이 있으신가요?{" "}
            <Link href="/login" className="text-blue-600 font-semibold hover:underline">
              로그인
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
