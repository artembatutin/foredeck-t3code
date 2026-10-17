import { silenceDetector } from "./silence";
/** Recording owns the microphone until finish/cancel, including a late permission response. */
export async function startRecording(signal: AbortSignal, onSilence?: () => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  let silenceTimer: ReturnType<typeof setInterval> | undefined;
  let monitor: AudioContext | undefined;
  const release = () => {
    if (silenceTimer !== undefined) clearInterval(silenceTimer);
    if (monitor) {
      void monitor.close().catch(() => {});
      monitor = undefined;
    }
    stream.getTracks().forEach((track) => track.stop());
  };
  if (signal.aborted) {
    release();
    throw new DOMException("Recording cancelled", "AbortError");
  }
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (error) {
    release();
    throw error;
  }
  const chunks: Blob[] = [];
  const recorded = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener(
      "error",
      () => {
        release();
        signal.removeEventListener("abort", cancel);
        reject(new Error("The microphone recording failed."));
      },
      { once: true },
    );
    recorder.addEventListener(
      "stop",
      () => {
        release();
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) reject(new DOMException("Recording cancelled", "AbortError"));
        else resolve(new Blob(chunks, { type: recorder.mimeType }));
      },
      { once: true },
    );
  });
  // Cancellation can happen before the caller awaits finish().
  void recorded.catch(() => {});
  const cancel = () => {
    if (recorder.state !== "inactive") recorder.stop();
    release();
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    recorder.start();
    if (onSilence && typeof AudioContext !== "undefined") {
      monitor = new AudioContext();
      const source = monitor.createMediaStreamSource(stream);
      const analyser = monitor.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const ended = silenceDetector(performance.now());
      silenceTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
        );
        if (ended(rms, performance.now())) {
          clearInterval(silenceTimer);
          onSilence();
        }
      }, 100);
    }
  } catch (error) {
    signal.removeEventListener("abort", cancel);
    cancel();
    throw error;
  }
  return {
    finish: async () => {
      if (recorder.state !== "inactive") recorder.stop();
      const blob = await recorded;
      if (signal.aborted) throw new DOMException("Recording cancelled", "AbortError");
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        const length = Math.min(Math.ceil(decoded.duration * 16_000), 16_000 * 65);
        const offline = new OfflineAudioContext(1, length, 16_000);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        const result = await offline.startRendering();
        if (signal.aborted) throw new DOMException("Recording cancelled", "AbortError");
        return result.getChannelData(0);
      } finally {
        await context.close();
      }
    },
  };
}
