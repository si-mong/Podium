import type { MetadataRoute } from "next";

// 검색엔진 안내 — 공개 페이지만 보게 하고, 로그인해야 쓰는 화면은 막는다.
// 대표 주소는 www (podium-it.co.kr 은 www 로 리디렉션됨).
const SITE = "https://www.podium-it.co.kr";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/record", "/admin", "/profile", "/home", "/auth"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
