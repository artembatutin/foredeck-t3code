import { expect, it } from "vite-plus/test";
import { searchSettings } from "~/components/settings/settingsSearch";

it.each([
  ["dictation", "voice-mode"],
  ["speaking voice", "voice-speaking-voice"],
])("finds device-local voice settings for %s", (query, id) => {
  const result = searchSettings(query).find((item) => item.id === id);
  expect(result?.to).toBe("/settings/general");
  expect(result?.scope).toBeUndefined();
});
