// 다크 모드 설정을 저장하는 localStorage 키.
// layout.tsx(서버)와 ThemeToggle.tsx(브라우저)가 같이 쓰므로 "use client" 없는 파일에 둔다
// — 클라이언트 파일에서 가져오면 서버에서는 값이 아니라 참조 객체가 된다.
export const THEME_KEY = "podium_theme";
