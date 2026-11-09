// 영상 돌리기 — 휴대폰을 가로로 들었는데 '화면 방향 고정' 때문에 페이지가 세로로 남으면,
// 휴대폰이 세로 영상을 보내서 사람이 옆으로 누운 채 녹화된다. 웹에서는 휴대폰의 실제 방향을
// 알 수 없으므로, 사용자가 미리보기를 보고 "돌리기"를 눌러 똑바로 세우게 한다.
//
// 들어온 영상을 화면에 안 보이는 캔버스에 90°×quarter 만큼 돌려 그리고, 그 캔버스를 스트림으로 내보낸다.
// 촬영 페이지는 이 스트림을 녹화하므로 서버에 저장·분석되는 영상도 똑바로 선다.
// (배경 흐림을 켰으면 흐림 스트림 → 돌리기 순서로 이어 붙인다)

export interface RotatedStream {
  stream: MediaStream;                    // 돌린 영상 + 원래 소리
  setQuarter: (quarter: number) => void;  // 0~3 (시계 방향 90° 단위)
  setLocked: (locked: boolean) => void;   // 녹화 중에는 캔버스 크기를 고정 (녹화 파일이 깨지지 않게)
  stop: () => void;                       // 그리기만 멈춘다. 들어온 스트림은 끄지 않는다
}

export async function startRotated(input: MediaStream, quarter: number): Promise<RotatedStream> {
  const video = document.createElement("video");
  video.srcObject = new MediaStream(input.getVideoTracks());
  video.muted = true;
  video.playsInline = true;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  let q = ((quarter % 4) + 4) % 4;
  let locked = false;
  let running = true;
  let frameId = 0;

  const fitCanvas = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || locked) return;
    const tw = q % 2 ? vh : vw;
    const th = q % 2 ? vw : vh;
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
  };
  fitCanvas();

  const draw = () => {
    if (!running) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      fitCanvas();
      const W = canvas.width;
      const H = canvas.height;
      // 돌린 그림의 크기. 녹화 중에 캔버스 크기가 고정돼 있으면 비율을 지켜 가운데에 맞춘다 (남는 곳은 검게).
      const rw = q % 2 ? vh : vw;
      const rh = q % 2 ? vw : vh;
      const s = Math.min(W / rw, H / rh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.translate(W / 2, H / 2);
      ctx.rotate((q * Math.PI) / 2);
      ctx.scale(s, s);
      ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    frameId = requestAnimationFrame(draw);
  };
  draw();

  const canvasTrack = canvas.captureStream(30).getVideoTracks()[0];
  const stream = new MediaStream([canvasTrack, ...input.getAudioTracks()]);

  return {
    stream,
    setQuarter: (v) => {
      q = ((v % 4) + 4) % 4;
    },
    setLocked: (v) => {
      locked = v;
    },
    stop: () => {
      running = false;
      cancelAnimationFrame(frameId);
      canvasTrack.stop();
      video.srcObject = null;
    },
  };
}
