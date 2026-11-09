export const ASSISTANT_THREAD_PREFIX = "fd-assistant-";

export function isAssistantThread(threadId: string): boolean {
  return threadId.startsWith(ASSISTANT_THREAD_PREFIX);
}

export const isAssistantPreviewVersion = (version: string) => /-preview\.\d{8}\.\d+$/.test(version);
export const ASSISTANT_PREVIEW_HOME = ".foredeck-assistant-preview";

/**
 * Local development builds, `<version>-dev.<yyyymmdd>.<n>`, and the earlier
 * `<version>-uxpreview.<yyyymmdd>.<n>` builds, which keep the same home guard. A marker of their
 * own, so the assistant previews' `-preview.` versions keep their identity, home and label.
 */
export const isUxPreviewVersion = (version: string) =>
  /^[^-+]+-(?:dev|uxpreview)\.\d{8}\.\d+$/.test(version);
export const UX_PREVIEW_PRODUCT_NAME = "Foredeck";
/** The build metadata key holding the exact T3 home a UX preview build runs on. */
export const UX_PREVIEW_HOME_METADATA_KEY = "t3codeUxPreviewHome";
