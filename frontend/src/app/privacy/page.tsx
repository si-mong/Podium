// 개인정보 처리방침(/privacy) — 로그인 없이 누구나 볼 수 있어야 한다 (구글 OAuth 동의 화면 게시 요건).
// 수집 항목·외부 전송은 실제 코드 기준이다. 파이프라인·외부 서비스가 바뀌면 이 페이지도 같이 고친다.
//   - 영상 구간 → Google Gemini (step2_video_analysis.py, 분석 후 업로드 파일 삭제)
//   - 음성 → Modal GPU 서버 (voice/stt_remote.py)
//   - 대본 텍스트 → OpenAI (step4_segmentation.py, step5_feedback.py)
//   - 발표 자료 PDF 는 브라우저에서만 보여 주고 서버로 보내지 않는다 (record/page.tsx)

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { PodiumLogo } from "@/components/ServiceGuide";

export const metadata: Metadata = { title: "개인정보 처리방침 · Podium" };

// 운영자·연락처 (privacy/page.tsx 와 terms/page.tsx 가 같은 값을 쓴다)
const OPERATOR = "Podium 팀";
const CONTACT_EMAIL = "ozmii333@gmail.com";
const EFFECTIVE_DATE = "2026년 10월 25일";

const PROCESSORS = [
  { name: "Amazon Web Services", country: "대한민국(서울 리전)", items: "계정 정보, 발표 영상·음성, 분석 결과", purpose: "서비스 서버·데이터 저장" },
  { name: "Google (Gemini API)", country: "미국", items: "발표 영상 구간", purpose: "자세·제스처 등 동작 분석" },
  { name: "Modal", country: "미국", items: "발표 음성", purpose: "음성을 글자로 바꾸기(음성 인식)" },
  { name: "OpenAI", country: "미국", items: "발표 대본 텍스트, 분석 수치", purpose: "구간 나누기, 피드백 작성" },
  { name: "Vercel", country: "미국", items: "접속 기록(IP, 브라우저 정보)", purpose: "웹 화면 제공" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-stone-800">{title}</h2>
      <div className="text-sm text-stone-600 leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-['Pretendard_Variable',Pretendard,sans-serif]">
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <Link href="/" className="inline-flex">
            <PodiumLogo className="h-6 w-auto hover:opacity-70 transition-opacity" />
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <article className="bg-white rounded-2xl border border-stone-200 shadow-sm p-8 md:p-10 space-y-8">
          <div>
            <h1 className="text-2xl font-extrabold text-stone-800 tracking-tight">개인정보 처리방침</h1>
            <p className="text-sm text-stone-500 mt-2">
              {OPERATOR}(이하 &quot;운영자&quot;)은 발표 연습 분석 서비스 Podium(이하 &quot;서비스&quot;)을 운영하며,
              「개인정보 보호법」에 따라 이용자의 개인정보를 다음과 같이 처리합니다.
            </p>
          </div>

          <Section title="1. 수집하는 개인정보">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <b>이메일 회원가입 시</b>: 이메일 주소, 비밀번호(복원할 수 없는 방식으로 암호화해 저장)
              </li>
              <li>
                <b>구글 로그인 시</b>: 이메일 주소, 구글 계정 식별자. 구글 비밀번호는 받지 않습니다.
              </li>
              <li>
                <b>프로필(선택)</b>: 이름, 소속·학과, 발표 목적. 입력하지 않아도 서비스를 모두 이용할 수 있습니다.
              </li>
              <li>
                <b>서비스 이용 시</b>: 직접 촬영하거나 올린 발표 영상(얼굴·모습·목소리 포함), 영상에서 뽑은 음성,
                음성을 글자로 바꾼 대본, 분석 결과와 피드백, 프로젝트 제목, 피드백 평가(좋아요·싫어요)
              </li>
              <li>
                <b>자동 수집</b>: 접속 기록(IP 주소, 브라우저 정보, 접속 시각), 분석 실행 기록(단계별 소요 시간, 오류)
              </li>
            </ul>
            <p>
              발표 자료(PDF)는 촬영 화면에서 이용자의 브라우저에만 표시되며 서버로 전송·저장하지 않습니다.
            </p>
          </Section>

          <Section title="2. 이용 목적">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>회원 식별과 로그인 유지, 프로필 표시</li>
              <li>발표 영상의 음성·동작 분석, 구간별·종합 피드백 제공, 회차별 비교</li>
              <li>오류 확인, 분석 품질 개선, 부정 이용 방지</li>
            </ul>
            <p>수집한 영상·음성을 위 목적 외에 사용하거나 AI 모델 학습용으로 제3자에게 제공하지 않습니다.</p>
          </Section>

          <Section title="3. 보유 기간과 파기">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <b>영상·음성·대본·분석 결과</b>: 이용자가 프로젝트를 삭제한 뒤 휴지통에서 <b>영구 삭제</b>하면 즉시 파기합니다.
                휴지통에 있는 동안은 복구할 수 있도록 보관합니다.
              </li>
              <li>
                <b>계정 정보</b>: 회원 탈퇴 시 파기합니다. 탈퇴는 아래 연락처로 요청하면 처리합니다.
              </li>
              <li>
                <b>분석 실행 기록</b>: 이용자·영상과의 연결을 끊은 상태(단계, 소요 시간, 오류 내용)로 서비스 개선을 위해 남을 수 있습니다.
              </li>
            </ul>
            <p>전자 파일은 복구할 수 없는 방법으로 삭제합니다.</p>
          </Section>

          <Section title="4. 처리 위탁과 국외 이전">
            <p>
              분석을 위해 아래 업체에 개인정보 처리를 맡기며, 일부는 국외로 전송됩니다. 전송은 분석을 실행할 때 암호화된 통신(HTTPS)으로 이루어지고,
              각 업체는 처리가 끝나면 자사 정책에 따라 데이터를 삭제합니다. Gemini에 올린 영상 파일은 분석이 끝나면 운영자가 바로 삭제합니다.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs md:text-sm border border-stone-200 rounded-xl">
                <thead className="bg-stone-50 text-stone-500">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">업체</th>
                    <th className="text-left font-semibold px-3 py-2">국가</th>
                    <th className="text-left font-semibold px-3 py-2">전송 항목</th>
                    <th className="text-left font-semibold px-3 py-2">목적</th>
                  </tr>
                </thead>
                <tbody>
                  {PROCESSORS.map((p) => (
                    <tr key={p.name} className="border-t border-stone-100 align-top">
                      <td className="px-3 py-2 font-semibold text-stone-700 whitespace-nowrap">{p.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{p.country}</td>
                      <td className="px-3 py-2">{p.items}</td>
                      <td className="px-3 py-2">{p.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>국외 이전을 원하지 않으면 서비스 이용(영상 분석)을 하지 않거나 회원 탈퇴를 요청할 수 있습니다.</p>
          </Section>

          <Section title="5. 운영자의 열람">
            <p>운영자는 오류 대응을 위해 분석 결과와 실행 기록을 볼 수 있으며, <b>발표 영상은 볼 수 없습니다</b>.</p>
          </Section>

          <Section title="6. 이용자의 권리">
            <p>
              언제든지 개인정보 열람·정정·삭제를 요청할 수 있고, 영상과 분석 결과는 서비스에서 직접 삭제할 수 있습니다.
              만 14세 미만은 가입할 수 없습니다.
            </p>
          </Section>

          <Section title="7. 쿠키와 보안">
            <p>
              로그인 유지를 위해 브라우저에 로그인 토큰을 저장하며, 광고·추적용 쿠키는 쓰지 않습니다.
              모든 통신은 HTTPS로 암호화하고, 영상과 분석 결과는 본인만 볼 수 있습니다.
            </p>
          </Section>

          <Section title="8. 문의">
            <p>
              {OPERATOR} ·{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-stone-900 font-semibold underline hover:text-stone-600">
                {CONTACT_EMAIL}
              </a>
            </p>
          </Section>

          <Section title="9. 방침 변경">
            <p>방침을 바꾸면 시행 7일 전에 서비스 화면에 알립니다. (시행일: {EFFECTIVE_DATE})</p>
          </Section>
        </article>
      </main>
    </div>
  );
}
