export const ASSISTANT_THREAD_PREFIX = "fd-assistant-";

export function isAssistantThread(threadId: string): boolean {
  return threadId.startsWith(ASSISTANT_THREAD_PREFIX);
}

export const isAssistantPreviewVersion = (version: string) => /-preview\.\d{8}\.\d+$/.test(version);
export const ASSISTANT_PREVIEW_HOME = ".foredeck-assistant-preview";
