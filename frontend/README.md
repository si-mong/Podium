# Podium Frontend

Next.js 14 (App Router) 웹 앱 — 촬영·업로드, 분석 대시보드, 회차 비교, 관리자 화면. 2026-11-27 기준.
배포: Vercel (main push 마다 자동) → https://podium-it.co.kr

## 스택

Next.js 14 · React 18 · TypeScript · Tailwind CSS · recharts(그래프) · lucide-react(아이콘) · MediaPipe tasks-vision(촬영 배경 블러) · Pretendard / Geist 글꼴

## 로컬 실행

```bash
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                        # http://localhost:3000
```

백엔드(`http://localhost:8000`)가 떠 있어야 로그인·분석이 된다 → [backend/README.md](../backend/README.md).
로그인은 구글 로그인(백엔드 `.env` 에 구글 키 필요) 또는 `DEBUG=true` 일 때의 이메일 로그인.

| 명령 | 설명 |
|---|---|
| `npm run dev` | 개발 서버 (HMR) |
| `npm run build` / `npm start` | 프로덕션 빌드 / 실행 |
| `npm run lint` | ESLint |

| 환경변수 | 설명 |
|---|---|
| `NEXT_PUBLIC_API_URL` | 백엔드 주소. 없으면 `http://localhost:8000`. 배포는 Vercel 환경변수에 API 도메인 |

## 화면 (`src/app/`)

| 경로 | 화면 |
|---|---|
| `/` | 랜딩 — 돋보기 데모(LoupeHero), 분석 항목·사용 방법 단 이동 |
| `/login` | 로그인 (`/signup` 은 구글 로그인 안내만 — 이메일 가입은 없앰) |
| `/auth/callback` | 구글 로그인 후 1회용 코드 → 토큰 교환 |
| `/profile` | 첫 로그인 프로필 (이름·소속·발표 목적, 건너뛰기 가능) / 내 정보 |
| `/home` | 로그인 후 홈 |
| `/record` | 촬영(배경 블러, 전면·후면 카메라) 또는 영상 업로드 → 방향 확인 → 분석 실행 |
| `/dashboard` | 내 기록·분석·비교·휴지통 (아래) |
| `/admin` | 관리자 — 외부 API 연결 점검, 분석 실행 기록 (`is_admin` 회원만) |
| `/privacy`, `/terms` | 개인정보 처리방침, 이용약관 |

### `/dashboard` — 화면 상태는 주소에 담는다

어느 메뉴·폴더·세션을 보는지 변수 대신 **URL 쿼리**에 둔다. 그래서 뒤로가기·새로고침이 화면과 맞게 동작한다.

| 쿼리 | 값 |
|---|---|
| `view` | `sessions`(내 기록, 기본) · `single`(단일 분석) · `compare`(회차 비교) · `trash`(휴지통) |
| `folder` | 열어 둔 폴더 id. 없으면 폴더 목록 |
| `session` | 선택한 세션 id |

예) `/dashboard?view=single&folder=3&session=12`. 촬영 화면은 `/dashboard?session=12` 로 돌아온다 (`view` 없이 `session` 만 있으면 단일 분석).

| 파일 | 내용 |
|---|---|
| `dashboard/page.tsx` | 메뉴·폴더·세션 목록, 종합추이 그래프, 휴지통, 다시 분석하기 |
| `dashboard/SingleView.tsx` | 단일 분석 — 종합 피드백, 구간별 지표 그래프, 영상 타임라인, 구간별 AI 피드백 |
| `dashboard/InteractiveScript.tsx` | 분석 스크립트 — 문장 위에 무음·필러·반복·동작 표시, 누르면 그 시점부터 재생 |
| `dashboard/CompareView.tsx` | 회차 비교 — 지표 레이더 차트, AI 비교 피드백, 구간별 비교(영상·스크립트 나란히) |

## 공용 코드 (`src/utils/`, `src/components/`)

| 파일 | 내용 |
|---|---|
| `utils/api.ts` | `apiFetch` — access 토큰 자동 첨부, 401 이면 refresh 로 갱신 후 재시도, 실패 시 로그인으로. `API_BASE` |
| `utils/auth.ts` | 토큰 보관 (localStorage) |
| `utils/analysis.ts` | 분석 단계를 순서대로 호출: `/end` → voice → segments → motion-by-segment → segment-feedback → overall-feedback. 앞 세 단계 실패 시 멈추고, 나머지는 경고만 |
| `utils/theme.ts` | 다크모드 저장 |
| `components/` | LoupeHero, SegmentMetrics, ServiceGuide, UsageSteps, ThemeToggle, GoogleLogo |

## 주의

- 영상은 `<video src>` 에 토큰 헤더를 못 붙이므로 **재생 티켓**(`POST /sessions/{id}/video/ticket`, 30분)을 받아 쿼리로 붙인다.
- 분석 API 는 전부 동기 호출이라 응답까지 수 분 걸릴 수 있다. 진행 상황은 `analysis.ts` 의 `onStep`·`onLog` 콜백으로 표시한다.
- iPhone(WebKit)에서 화면 방향 고정을 켜면 세로 영상으로 녹화된다 → 촬영 후 방향 확인 카드(`record/OrientationCheck.tsx`)에서 고르면 서버가 회전한다.

API 는 [docs/Dev-API명세.md](../docs/Dev-API명세.md), 전체 흐름은 [docs/Design-시스템흐름.md](../docs/Design-시스템흐름.md).
