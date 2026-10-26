// 이용약관(/terms) — 로그인 없이 누구나 볼 수 있어야 한다 (구글 OAuth 동의 화면 게시 요건).
// 레이아웃은 개인정보 처리방침(/privacy)과 같다. 운영자·연락처도 같은 값을 쓴다.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { PodiumLogo } from "@/components/ServiceGuide";

export const metadata: Metadata = { title: "이용약관 · Podium" };

// 운영자·연락처 (privacy/page.tsx 와 terms/page.tsx 가 같은 값을 쓴다)
const OPERATOR = "Podium 팀";
const CONTACT_EMAIL = "ozmii333@gmail.com";
const EFFECTIVE_DATE = "2026년 10월 26일";

function Article({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-stone-800">{title}</h2>
      <div className="text-sm text-stone-600 leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

export default function TermsPage() {
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
            <h1 className="text-2xl font-extrabold text-stone-800 tracking-tight">이용약관</h1>
            <p className="text-sm text-stone-500 mt-2">
              이 약관은 {OPERATOR}(이하 &quot;운영자&quot;)이 제공하는 발표 연습 분석 서비스 Podium(이하 &quot;서비스&quot;)의
              이용 조건과 절차, 운영자와 이용자의 권리·의무를 정합니다.
            </p>
          </div>

          <Article title="제1조 (서비스 내용)">
            <p>
              서비스는 이용자가 촬영하거나 올린 발표 영상을 분석해 말하기(속도, 필러, 반복, 무음)와 동작(자세, 제스처)에 대한
              수치와 구간별·종합 피드백을 제공합니다. 분석에는 외부 AI 서비스를 사용하며, 자세한 내용은{" "}
              <Link href="/privacy" className="text-stone-900 font-semibold underline hover:text-stone-600">개인정보 처리방침</Link>에 적혀 있습니다.
            </p>
          </Article>

          <Article title="제2조 (가입과 계정)">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>만 14세 이상이면 누구나 가입할 수 있습니다.</li>
              <li>계정은 본인만 사용해야 하며, 다른 사람에게 빌려주거나 다른 사람의 이메일로 가입해서는 안 됩니다.</li>
              <li>계정이 도용된 것을 알게 되면 바로 운영자에게 알려 주세요.</li>
            </ul>
          </Article>

          <Article title="제3조 (이용자가 올리는 영상)">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>이용자가 올린 영상과 분석 결과의 권리는 이용자에게 있습니다. 운영자는 분석과 결과 제공에 필요한 범위에서만 사용합니다.</li>
              <li>
                <b>본인이 아닌 사람이 나오는 영상</b>은 그 사람의 동의를 받은 경우에만 올려야 합니다.
                동의 없이 올려 생긴 문제의 책임은 올린 이용자에게 있습니다.
              </li>
              <li>법령을 어기거나 다른 사람의 권리를 침해하는 영상, 음란·폭력적인 영상은 올릴 수 없습니다.</li>
            </ul>
          </Article>

          <Article title="제4조 (금지 행위)">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>서비스를 비정상적인 방법으로 대량 호출하거나 서버에 부담을 주는 행위</li>
              <li>다른 이용자의 정보·영상에 접근하려 하거나 보안을 우회하는 행위</li>
              <li>분석 결과를 다른 사람의 것으로 속여 사용하는 행위</li>
            </ul>
            <p>이런 행위가 확인되면 운영자는 사전 안내 후(긴급하면 사후 안내) 이용을 제한할 수 있습니다.</p>
          </Article>

          <Article title="제5조 (분석 결과의 한계)">
            <p>
              분석 결과와 피드백은 AI가 자동으로 만든 참고 자료입니다. 음성 인식이나 동작 분석이 틀릴 수 있고,
              실제 발표 평가나 성적을 보장하지 않습니다. 중요한 판단은 결과를 직접 확인한 뒤 내려 주세요.
            </p>
          </Article>

          <Article title="제6조 (서비스 운영)">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>서비스는 무료로 제공되며, 캡스톤디자인 프로젝트로 운영되고 있습니다.</li>
              <li>점검, 장애, 외부 AI 서비스 사정으로 서비스가 일시 중단되거나 분석이 실패할 수 있습니다.</li>
              <li>
                운영자는 서비스 내용을 바꾸거나 종료할 수 있습니다. 서비스를 종료할 때는 최소 30일 전에 알리고,
                이용자가 결과를 확인할 시간을 드린 뒤 저장된 영상과 데이터를 파기합니다.
              </li>
            </ul>
          </Article>

          <Article title="제7조 (탈퇴와 데이터 삭제)">
            <p>
              이용자는 언제든지 프로젝트를 삭제할 수 있고, 휴지통에서 영구 삭제하면 영상과 분석 결과가 바로 지워집니다.
              회원 탈퇴는 아래 연락처로 요청하면 처리합니다.
            </p>
          </Article>

          <Article title="제8조 (책임의 한계)">
            <p>
              운영자는 고의나 중대한 과실이 없는 한, 무료 서비스 이용 중 생긴 손해(분석 결과를 믿고 내린 판단, 일시적인 중단 등)에 대해
              책임지지 않습니다. 다만 관련 법령상 운영자의 책임을 제한할 수 없는 경우에는 그에 따릅니다.
            </p>
          </Article>

          <Article title="제9조 (약관 변경)">
            <p>
              약관을 바꾸면 시행 7일 전(이용자에게 불리한 변경은 30일 전)에 서비스 화면에 알립니다.
              바뀐 약관에 동의하지 않으면 탈퇴할 수 있습니다.
            </p>
          </Article>

          <Article title="제10조 (문의)">
            <p>
              서비스 이용 문의: <b>{OPERATOR}</b> ·{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-stone-900 font-semibold underline hover:text-stone-600">
                {CONTACT_EMAIL}
              </a>
            </p>
            <p className="text-stone-500">시행일: {EFFECTIVE_DATE}</p>
          </Article>
        </article>
      </main>
    </div>
  );
}
