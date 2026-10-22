import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  readLegacyVoicePreferences,
  useVoicePreferences,
  VOICE_PREFERENCES_KEY,
} from "./voicePreferences";
afterEach(() => vi.unstubAllGlobals());
it("preserves legacy choices, shares changes between settings and composer, and restores them", async () => {
  const storage = new Map([
    ["fd.voice.mode", "conversation"],
    ["fd.voice.voice", "Samantha"],
  ]);
  const target = new EventTarget();
  vi.stubGlobal(
    "window",
    Object.assign(target, {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    }),
  );
  let update!: ReturnType<typeof useVoicePreferences>[1];
  const values: ReturnType<typeof useVoicePreferences>[0][] = [];
  function Probe({ index }: { index: number }) {
    const [value, setValue] = useVoicePreferences();
    useEffect(() => {
      values[index] = value;
      if (index === 0) update = setValue;
    }, [index, value, setValue]);
    return null;
  }
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <>
        <Probe index={0} />
        <Probe index={1} />
      </>,
    );
  });
  expect(values).toEqual([
    { mode: "conversation", voiceURI: "Samantha" },
    { mode: "conversation", voiceURI: "Samantha" },
  ]);
  await act(async () => {
    update((current) => ({ ...current, mode: "dictation", voiceURI: "Karen" }));
  });
  expect(values).toEqual([
    { mode: "dictation", voiceURI: "Karen" },
    { mode: "dictation", voiceURI: "Karen" },
  ]);
  expect(JSON.parse(storage.get(VOICE_PREFERENCES_KEY)!)).toEqual(values[0]);
  await act(async () => {
    view.unmount();
  });
  await act(async () => {
    view = create(<Probe index={0} />);
  });
  expect(values[0]).toEqual({ mode: "dictation", voiceURI: "Karen" });
  await act(async () => {
    view.unmount();
  });
});
it("defaults safely when legacy storage is unavailable", () => {
  expect(
    readLegacyVoicePreferences(() => {
      throw new Error("blocked");
    }),
  ).toEqual({ mode: "dictation", voiceURI: "" });
});
