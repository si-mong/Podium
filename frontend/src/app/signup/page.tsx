"use client";

// 이메일 회원가입은 없앴다 — 구글 로그인으로 처음 들어오면 자동으로 가입된다.
// 예전 링크·북마크로 들어온 사람을 로그인 화면으로 보낸다.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/login");
  }, [router]);
  return null;
}
