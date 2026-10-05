// 배경 흐림(블러) — Zoom 의 "배경 흐리게" 같은 기능.
//
// 카메라 영상에서 사람과 배경을 나누고(MediaPipe 셀피 분할 모델), 화면에 안 보이는 캔버스에
// "흐리게 그린 원본(배경) 위에 선명한 사람"을 매 프레임 그린 뒤, 그 캔버스를 영상 스트림으로 내보낸다.
// 촬영 페이지는 이 스트림을 녹화하므로 서버에 저장·분석되는 영상도 배경이 흐리다.

// 모델 실행 파일(wasm)과 모델 파일은 CDN 에서 받는다. 버전은 package.json 의 @mediapipe/tasks-vision 과 맞출 것.
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

const BLUR_PX = 12; // 배경 흐림 정도
// 사람/배경 나누기는 작은 크기(16:9)로 해서 빠르게 하고, 결과(마스크)를 원본 크기로 늘려 쓴다.
// 늘릴 때 경계가 자연스럽게 부드러워지는 효과도 있다.
const MASK_W = 256;
const MASK_H = 144;

export interface BlurredCamera {
  stream: MediaStream; // 배경이 흐린 영상 + 카메라 소리
  stop: () => void;    // 그리기를 멈추고 카메라까지 끈다
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export async function startBackgroundBlur(camera: MediaStream): Promise<BlurredCamera> {
  // 브라우저에서만 쓰는 라이브러리라 필요할 때 불러온다 (Next.js 서버 렌더링 때 안 불리게).
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true, // 픽셀마다 "사람일 확률"(0~1)
  });

  // 카메라 영상을 화면에 안 보이는 video 로 재생한다 (캔버스에 그릴 재료).
  const video = document.createElement("video");
  video.srcObject = new MediaStream(camera.getVideoTracks());
  video.muted = true;
  video.playsInline = true;
  await video.play();
  const w = video.videoWidth;
  const h = video.videoHeight;

  const output = makeCanvas(w, h);          // 최종 화면 (녹화되는 캔버스)
  const person = makeCanvas(w, h);          // 사람만 오려낸 화면
  const small = makeCanvas(MASK_W, MASK_H); // 분할 모델에 넣을 작은 프레임
  const mask = makeCanvas(MASK_W, MASK_H);  // 사람일 확률을 투명도로 담은 마스크
  const ctx = output.getContext("2d")!;
  const personCtx = person.getContext("2d")!;
  const smallCtx = small.getContext("2d", { willReadFrequently: true })!;
  const maskCtx = mask.getContext("2d")!;
  const maskImage = maskCtx.createImageData(MASK_W, MASK_H);

  let running = true;
  let frameId = 0;

  const drawFrame = () => {
    if (!running) return;

    // 1) 작은 프레임으로 사람/배경을 나눠서 마스크를 갱신한다.
    smallCtx.drawImage(video, 0, 0, MASK_W, MASK_H);
    segmenter.segmentForVideo(small, performance.now(), (result) => {
      const confidence = result.confidenceMasks?.[0]?.getAsFloat32Array();
      if (!confidence) return;
      const n = Math.min(confidence.length, MASK_W * MASK_H);
      for (let i = 0; i < n; i++) {
        maskImage.data[i * 4 + 3] = confidence[i] * 255; // 사람일수록 불투명
      }
      maskCtx.putImageData(maskImage, 0, 0);
    });

    // 2) 원본에서 사람만 남긴다 (마스크가 불투명한 곳만 남기는 destination-in).
    personCtx.globalCompositeOperation = "copy";
    personCtx.drawImage(video, 0, 0, w, h);
    personCtx.globalCompositeOperation = "destination-in";
    personCtx.drawImage(mask, 0, 0, w, h);

    // 3) 흐린 원본을 깔고 그 위에 선명한 사람을 올린다.
    //    흐리게 하면 가장자리가 비어 어두워지므로 흐림 정도만큼 조금 크게 그린다.
    ctx.filter = `blur(${BLUR_PX}px)`;
    ctx.drawImage(video, -BLUR_PX, -BLUR_PX, w + BLUR_PX * 2, h + BLUR_PX * 2);
    ctx.filter = "none";
    ctx.drawImage(person, 0, 0);

    frameId = requestAnimationFrame(drawFrame);
  };
  drawFrame();

  // 캔버스 영상(30fps) + 카메라 소리를 합쳐서 녹화용 스트림으로 만든다.
  const canvasTrack = output.captureStream(30).getVideoTracks()[0];
  const stream = new MediaStream([canvasTrack, ...camera.getAudioTracks()]);

  const stop = () => {
    running = false;
    cancelAnimationFrame(frameId);
    canvasTrack.stop();
    camera.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    segmenter.close();
  };

  return { stream, stop };
}
