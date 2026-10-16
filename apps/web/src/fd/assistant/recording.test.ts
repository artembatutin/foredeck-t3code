import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { startRecording } from "./recording";

afterEach(() => vi.unstubAllGlobals());

describe("microphone lifetime", () => {
  it("releases a microphone granted after cancellation without starting a recorder", async () => {
    const permission = Promise.withResolvers<MediaStream>();
    const stop = vi.fn();
    const recorder = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission.promise } });
    vi.stubGlobal("MediaRecorder", recorder);
    const abort = new AbortController();
    const pending = startRecording(abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    expect(recorder).not.toHaveBeenCalled();
  });
  it("releases the microphone if the recording format cannot be initialized", async () => {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal("MediaRecorder", function UnsupportedRecorder() {
      throw new Error("Unsupported recording");
    });
    await expect(startRecording(new AbortController().signal)).rejects.toThrow(
      "Unsupported recording",
    );
    expect(stop).toHaveBeenCalledOnce();
  });
  it("stops active recording on cancellation and cannot return a late transcript", async () => {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    class Recorder extends EventTarget {
      state = "inactive";
      mimeType = "audio/webm";
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", Recorder);
    const abort = new AbortController();
    const recording = await startRecording(abort.signal);
    abort.abort();
    await expect(recording.finish()).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalled();
  });
});
