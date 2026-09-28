<div align="center">

# Podium
2026-CBNU CapstoneDesign
### **당신의 발표, AI가 다시 봅니다.**

발표 영상 하나로 음성·자세·시선·제스처까지<br/>
**구간별로 분석하고 회차마다 성장 추이를 보여주는** AI 발표 코치

</div>

---

## 프로젝트 소개

### 배경

> "발표 연습은 했는데, 뭘 고쳐야 할지 모르겠어요."

발표는 누구나 하지만, 제대로 피드백받을 기회는 거의 없습니다.<br/>
혼자 영상을 다시 봐도 **무엇이 문제인지** 짚어내기 어렵고, 매번 누군가에게 부탁할 수도 없습니다.

### 목표

**Podium은 그 자리를 대신합니다.**<br/>
영상 한 편을 업로드하면 AI 코치가 발표 전체를 다시 보고, **구간별로 무엇을 잘했고 무엇을 고쳐야 하는지** 알려줍니다. 연습할수록 성장이 데이터로 쌓이는 경험을 제공합니다.

### 핵심 기능

#### 1. 멀티모달 분석
업로드하면 끝. 음성·언어·동작을 동시에 분석합니다.

| 영역 | 분석 항목 |
|---|---|
| 🗣️ **음성** | 발화 속도(WPM) · 무음 구간 · 필러 단어 ("음", "어") |
| 📝 **언어** | STT 기반 문장 분리 · 의미 단위 구간 분리 |
| 👁️ **시선·자세** | 카메라 응시율 · 자세 안정성 |
| 🤲 **제스처** | 손동작 활용도 · 불필요한 반복 동작 |

#### 2. 구간별 분석과 피드백
발표를 의미 단위로 자동 분할하고, **각 구간마다 발표 습관 결과**와 개선 코멘트를 제공합니다.

#### 3. 회차별 성장 추이
같은 발표를 여러 번 연습할수록 진짜 가치가 드러납니다.<br/>
회차를 거듭하며 **어떤 지표가 좋아졌는지, 어디서 정체됐는지** 한눈에 확인하세요.

---

## 기술 스택

<div align="center">

**Frontend**<br/>
![Next.js](https://img.shields.io/badge/Next.js_14-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![TanStack Query](https://img.shields.io/badge/TanStack_Query-FF4154?style=flat-square&logo=reactquery&logoColor=white)

**Backend**<br/>
![Python](https://img.shields.io/badge/Python_3.11-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![SQLAlchemy](https://img.shields.io/badge/SQLAlchemy-D71F00?style=flat-square&logo=sqlalchemy&logoColor=white)

**AI / Analysis**<br/>
![OpenAI](https://img.shields.io/badge/GPT--4o-412991?style=flat-square&logo=openai&logoColor=white)
![Whisper](https://img.shields.io/badge/Whisper_large--v3-74AA9C?style=flat-square&logo=openai&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=flat-square&logo=ffmpeg&logoColor=white)
![OpenCV](https://img.shields.io/badge/OpenCV-5C3EE8?style=flat-square&logo=opencv&logoColor=white)

**Infra**<br/>
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)
![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white)

</div>

## 팀

충북대학교 2026 캡스톤디자인

### 최은재 &nbsp;`PM` `Backend` `DB`

- 프로젝트 일정 · 범위 관리 및 기술 의사결정
- DB 스키마 설계 및 마이그레이션 관리
- 프로젝트 · 세션 · 분석 결과 REST API 설계 및 구현
- AI 파이프라인 — 전처리(STEP 1) · 음성 분석(STEP 3) · 구간 분리(STEP 4)

### 홍진수 &nbsp;`Frontend`

- 서비스 화면 설계 및 UI 컴포넌트 구현
- 분석 결과 · 회차별 추이 시각화
- AI 파이프라인 — VLM 동작 분석(STEP 2) · 종합 피드백(STEP 5)

---

## 개발 가이드

- 팀원용 빠른 시작 / 폴더 구조 / 진행 상황 / 컨벤션 → [`docs/개발가이드.md`](./docs/개발가이드.md)
- 상세 컨텍스트 / 결정사항 / 임시 코드 → [`docs/CLAUDE.md`](./docs/CLAUDE.md)
