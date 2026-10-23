"use client";

// 구글 로그인 콜백(/auth/callback) — 백엔드가 #code=...&next=... 를 붙여 보낸다.
// 1회용 코드(60초)를 POST /auth/oauth/exchange 로 토큰 쌍과 바꿔 저장하고 next 로 이동한다.
// 코드는 주소의 # 뒤라 서버 로그·Referer 에 남지 않고, 읽자마자 주소에서 지운다.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { API_BASE, errorMessage } from "@/utils/api";
import { saveTokens } from "@/utils/auth";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const done = useRef(false); // 개발 모드에서 effect 가 두 번 돌아 코드를 두 번 쓰는 것 방지 (1회용이라 두 번째는 401)

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const hash = new URLSearchParams(window.location.hash.slice(1));
    const code = hash.get("code");
    const next = hash.get("next");
    window.history.replaceState(null, "", window.location.pathname);
    if (!code) {
      setError("로그인 정보가 없어요. 다시 로그인해주세요.");
      return;
    }

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/oauth/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!res.ok) {
          setError(await errorMessage(res, "로그인에 실패했어요. 다시 시도해주세요."));
          return;
        }
        const data = await res.json();
        saveTokens(data.access_token, data.refresh_token);
        router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
      } catch {
        setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.");
      }
    })();
  }, [router]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
      {error ? (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-sm w-full text-center space-y-4">
          <p className="text-sm text-red-500 font-medium">{error}</p>
          <Link href="/login" className="inline-block text-sm font-bold text-blue-600 hover:underline">
            로그인 화면으로
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          로그인하는 중…
        </div>
      )}
    </div>
  );
}
