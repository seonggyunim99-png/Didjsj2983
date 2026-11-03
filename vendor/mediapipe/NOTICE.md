# MediaPipe Tasks Vision

얼굴 인식(눈·코·입·턱선), 자세 인식(어깨·골반·다리), 사람/배경 나누기에 쓰는 Google MediaPipe 라이브러리와 모델입니다.
사진은 기기 안에서만 처리되며 외부로 전송되지 않습니다. 각 모델은 해당 기능을 처음 쓸 때만 내려받습니다.

- 라이브러리: `@mediapipe/tasks-vision` 0.10.21 (`vision_bundle.mjs`, `wasm/`)
- 모델
  - `face_landmarker.task` (float16, v1) — 인물 탭
  - `pose_landmarker_lite.task` (float16) — 몸매 보정
  - `selfie_multiclass_256x256.tflite` (float32) — 배경 흐림·밝기·흑백
- 라이선스: Apache License 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- 출처: https://github.com/google-ai-edge/mediapipe , https://storage.googleapis.com/mediapipe-models/
