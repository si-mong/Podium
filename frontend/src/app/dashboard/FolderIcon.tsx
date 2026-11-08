// "내 기록" 폴더 카드 아이콘 — 윈도우 탐색기 폴더처럼 생긴 노란 폴더 (직접 그린 SVG).
// 뒤판(탭 달린 진한 노랑) + 안에 든 흰 종이 + 앞판(밝은 노랑) 세 겹.
export default function FolderIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 52" className={className} aria-hidden="true">
      <path d="M4 6a4 4 0 0 1 4-4h14.5a4 4 0 0 1 2.8 1.2L30 8h26a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="#E5A323" />
      <rect x="9" y="12" width="46" height="20" rx="2" fill="#FFFFFF" />
      <path d="M4 20a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="#FFC83D" />
    </svg>
  );
}

// 대시보드의 큰 흰 카드 (내 기록 폴더 목록, 비교할 회차 고르기). 배경 위에 떠 보이게 그림자를 넓게 준다.
export const PANEL = 'bg-white rounded-3xl shadow-[0_8px_40px_-12px_rgba(15,23,42,0.18)] p-6 sm:p-10 lg:p-12';
