// 세션 추가 창(dashboard)에서 고른 발표자료 PDF 를 촬영 페이지(record)로 넘겨주는 임시 보관함.
//
// 파일(File)은 주소(?project=..)에 담을 수 없어서, 브라우저 메모리에 잠깐 들고 있다가 넘긴다.
// router.push 로 페이지를 옮겨도 이 변수는 살아있지만, 새로고침하면 사라진다
// (그러면 촬영 페이지는 슬라이드 없이 평소 화면으로 열린다). 서버에는 저장하지 않는다.
//
// 꺼낼 때 비우지 않는 이유: 개발 모드(React StrictMode)는 컴포넌트를 두 번 실행해서, 첫 번째에
// 꺼내며 비우면 두 번째엔 빈 값이 나온다. 대신 dashboard 가 촬영/업로드로 이동할 때마다
// 항상 새 값(PDF 또는 null)으로 덮어쓰므로 예전 PDF 가 따라오지 않는다.

let pendingSlide: File | null = null;

export function setPendingSlide(file: File | null) {
  pendingSlide = file;
}

export function getPendingSlide(): File | null {
  return pendingSlide;
}
