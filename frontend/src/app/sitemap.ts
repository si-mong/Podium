import type { MetadataRoute } from "next";

// 검색엔진에 알려줄 공개 페이지 목록 (로그인 없이 볼 수 있는 화면만).
const SITE = "https://www.podium-it.co.kr";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/login`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE}/signup`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE}/privacy`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
