export const ASSISTANT_THREAD_PREFIX = "fd-assistant-";

export function isAssistantThread(threadId: string): boolean {
  return threadId.startsWith(ASSISTANT_THREAD_PREFIX);
}
