"use client";

// 첫 화면(/) — 로그인돼 있으면 대시보드로, 아니면 로그인 화면으로 보낸다.
// (예전엔 Next.js 기본 안내 화면이 그대로 남아 있었다)

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "@/utils/auth";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace(isLoggedIn() ? "/dashboard" : "/login");
  }, [router]);

  return null;
}
