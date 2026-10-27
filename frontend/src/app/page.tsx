"use client";

// 첫 화면(/) — 로그인돼 있으면 대시보드로 보내고, 아니면 서비스 안내 화면을 보여준다.
// 로그아웃하면 여기로 온다.
// 안내 내용(사용 순서·화면 구성)은 로그인 후 홈(/home)과 똑같이 ServiceGuide 를 같이 쓴다.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ServiceGuide from "@/components/ServiceGuide";
import { isLoggedIn } from "@/utils/auth";

export default function LandingPage() {
  const router = useRouter();
  // 로그인 여부를 확인하기 전에는 아무것도 그리지 않는다 (로그인 사용자에게 랜딩이 깜빡이지 않게).
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) router.replace("/dashboard");
    else setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <ServiceGuide
      headerActions={
        <>
          <Link
            href="/login"
            className="h-10 px-4 rounded-full text-sm font-semibold text-stone-700 hover:bg-white flex items-center transition-colors"
          >
            로그인
          </Link>
          <Link
            href="/login"
            className="h-10 px-4 rounded-full text-sm font-semibold text-white bg-stone-900 hover:bg-stone-700 flex items-center transition-colors"
          >
            시작하기
          </Link>
        </>
      }
      primaryAction={{ label: "구글 계정으로 시작하기", onClick: () => router.push("/login") }}
    />
  );
}
