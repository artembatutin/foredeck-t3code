import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import factoryUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

env.allowLocalModels = false;
env.useWasmCache = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: factoryUrl };
}
let transcriber: Promise<AutomaticSpeechRecognitionPipeline> | undefined;
let busy = false;

function load() {
  transcriber ??= pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
    revision: "3a6d57ee9c665610614068e8592d8baee0188181",
    dtype: "q8",
    device: "wasm",
    progress_callback: (progress) => {
      if (progress.status === "progress")
        self.postMessage({ type: "progress", progress: progress.progress }, { transfer: [] });
    },
  }).catch((error: unknown) => {
    transcriber = undefined;
    throw error;
  });
  return transcriber;
}

self.addEventListener(
  "message",
  async (event: MessageEvent<{ type: "load" } | { type: "transcribe"; audio: Float32Array }>) => {
    if (busy) return;
    busy = true;
    try {
      const engine = await load();
      if (event.data.type === "load") {
        self.postMessage({ type: "ready" }, { transfer: [] });
      } else {
        const audio = event.data.audio;
        if (!(audio instanceof Float32Array) || audio.length === 0 || audio.length > 16_000 * 65) {
          throw new Error("Please record a message shorter than one minute.");
        }
        const result = await engine(audio, { chunk_length_s: 30, stride_length_s: 5 });
        self.postMessage(
          {
            type: "transcript",
            text: Array.isArray(result) ? result.map((part) => part.text).join(" ") : result.text,
          },
          { transfer: [] },
        );
      }
    } catch (error) {
      self.postMessage(
        {
          type: "error",
          message: error instanceof Error ? error.message : "Local speech recognition failed.",
        },
        { transfer: [] },
      );
    } finally {
      busy = false;
    }
  },
);
