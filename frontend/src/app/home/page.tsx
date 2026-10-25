"use client";

// 홈 화면(/home) — 로그인한 사용자용 서비스 안내 (사용 순서·화면 구성).
// 로그인 전 첫 화면(/)과 내용이 똑같도록 ServiceGuide 를 같이 쓴다. 다른 건 상단 버튼과 시작 버튼뿐.
// 대시보드 로고를 누르면 여기로 온다.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, LogOut, ShieldCheck } from "lucide-react";
import ServiceGuide from "@/components/ServiceGuide";
import { API_BASE, apiFetch } from "@/utils/api";
import { clearTokens, getRefreshToken, isLoggedIn } from "@/utils/auth";

export default function HomePage() {
  const router = useRouter();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    // 관리자에게만 상단에 "관리자" 버튼을 보인다. 실패해도 홈 화면엔 영향 없음.
    apiFetch("/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => setIsAdmin(Boolean(me?.is_admin)))
      .catch(() => {});
  }, [router]);

  // 로그아웃: 서버에 refresh 토큰 폐기를 알리고(실패해도 무시), 저장된 토큰을 지운 뒤 첫 화면(랜딩)으로.
  const logout = async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).catch(() => {});
    }
    clearTokens();
    router.replace("/");
  };

  return (
    <ServiceGuide
      headerActions={
        <>
          {isAdmin && (
            <button
              onClick={() => router.push("/admin")}
              className="h-10 flex items-center gap-1.5 px-4 rounded-full text-sm font-semibold text-stone-700 hover:bg-white transition-colors"
            >
              <ShieldCheck className="w-4 h-4" />
              관리자
            </button>
          )}
          <button
            onClick={() => router.push("/dashboard")}
            className="h-10 flex items-center gap-1.5 px-4 rounded-full text-sm font-semibold text-stone-700 hover:bg-white transition-colors"
          >
            내 기록
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={logout}
            className="h-10 flex items-center gap-1.5 px-4 rounded-full text-sm font-semibold text-stone-500 hover:bg-white hover:text-stone-700 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            로그아웃
          </button>
        </>
      }
      primaryAction={{ label: "내 기록으로 가기", onClick: () => router.push("/dashboard") }}
    />
  );
}
