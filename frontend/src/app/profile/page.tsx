"use client";

// 내 정보(/profile) — 이름·소속·발표 목적. 전부 선택 입력이다.
// 첫 로그인 직후에는 /profile?welcome=1 로 와서 "건너뛰기"가 보인다 (login/page.tsx).
// 저장하든 건너뛰든 PATCH /auth/me 를 불러서 프로필 화면을 거쳤다는 표시를 남긴다 → 다음 로그인부터는 안 뜬다.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PodiumMark } from "@/components/ServiceGuide";
import { apiFetch, errorMessage } from "@/utils/api";
import { isLoggedIn } from "@/utils/auth";

// 백엔드 schemas/auth.py 의 Purpose 와 같은 값
const PURPOSES = [
  { value: "class", label: "수업 발표" },
  { value: "interview", label: "면접" },
  { value: "conference", label: "학회·대회" },
  { value: "work", label: "업무 발표" },
  { value: "other", label: "기타" },
] as const;

const inputClass =
  "w-full px-3 py-2.5 rounded-xl border border-stone-200 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent";

function ProfileForm() {
  const router = useRouter();
  const welcome = useSearchParams().get("welcome") === "1";

  const [loaded, setLoaded] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [purpose, setPurpose] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace("/login");
      return;
    }
    (async () => {
      const res = await apiFetch("/auth/me");
      if (res.ok) {
        const me = await res.json();
        setEmail(me.email);
        setDisplayName(me.display_name ?? "");
        setAffiliation(me.affiliation ?? "");
        setPurpose(me.purpose);
      }
      setLoaded(true);
    })();
  }, [router]);

  // body 가 {} 이면 건너뛰기 — 아무것도 안 바꾸고 표시만 남긴다.
  const submit = async (body: Record<string, string | null>) => {
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      const res = await apiFetch("/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "저장하지 못했어요. 잠시 후 다시 시도해주세요."));
        return;
      }
      if (welcome) router.replace("/dashboard");
      else setSaved(true);
    } catch {
      setError("서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.");
    } finally {
      setSaving(false);
    }
  };

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    submit({ display_name: displayName, affiliation, purpose });
  };

  return (
    <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4 font-['Pretendard_Variable',Pretendard,sans-serif]">
      <div className="w-full max-w-md">
        <Link href={welcome ? "/" : "/home"} className="flex flex-col items-center gap-3 mb-8">
          <div className="w-14 h-14 rounded-2xl bg-stone-100 shadow-[inset_0_-2px_0_rgba(0,0,0,0.06)] flex items-center justify-center">
            <PodiumMark className="w-7 h-7 text-stone-800" />
          </div>
          <h1 className="text-xl font-extrabold text-stone-900 tracking-tight">Podium</h1>
        </Link>

        <div className="bg-white rounded-2xl shadow-sm border border-stone-200 p-8">
          <h2 className="text-lg font-bold text-stone-800">{welcome ? "반가워요! 조금만 알려 주세요" : "내 정보"}</h2>
          <p className="text-sm text-stone-500 mt-1 mb-6">
            {welcome ? "모두 선택 사항이에요. 나중에 내 정보에서 바꿀 수 있어요." : email}
          </p>

          {!loaded ? (
            <div className="flex items-center gap-2 text-stone-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              불러오는 중…
            </div>
          ) : (
            <form onSubmit={onSave} className="space-y-5">
              <div>
                <label className="block text-sm font-semibold text-stone-600 mb-1.5">이름</label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={50}
                  placeholder="홍길동"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-stone-600 mb-1.5">소속·학과</label>
                <input
                  value={affiliation}
                  onChange={(e) => setAffiliation(e.target.value)}
                  maxLength={100}
                  placeholder="예: OO대학교 컴퓨터공학과"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-stone-600 mb-1.5">주로 어떤 발표를 연습하나요?</label>
                <div className="flex flex-wrap gap-2">
                  {PURPOSES.map((p) => {
                    const on = purpose === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setPurpose(on ? null : p.value)}
                        className={`px-3.5 py-2 rounded-full text-sm font-semibold border transition-colors ${
                          on
                            ? "bg-stone-900 border-stone-900 text-white"
                            : "bg-white border-stone-200 text-stone-600 hover:bg-stone-50"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {error && <p className="text-sm text-red-500 font-medium">{error}</p>}
              {saved && <p className="text-sm text-emerald-700 font-medium">저장했어요.</p>}

              <div className="flex gap-2 pt-1">
                {welcome ? (
                  <button
                    type="button"
                    onClick={() => submit({})}
                    disabled={saving}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold text-stone-600 border border-stone-200 hover:bg-stone-50 disabled:opacity-60 transition-colors"
                  >
                    건너뛰기
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => router.push("/home")}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold text-stone-600 border border-stone-200 hover:bg-stone-50 transition-colors"
                  >
                    돌아가기
                  </button>
                )}
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-700 disabled:opacity-60 text-white text-sm font-bold py-2.5 rounded-xl transition-colors"
                >
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {welcome ? "저장하고 시작하기" : "저장"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfileForm />
    </Suspense>
  );
}
