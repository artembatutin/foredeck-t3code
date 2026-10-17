/** Packaging identity for locally installed assistant acceptance builds. */
export const isAssistantPreviewVersion = (version: string) => /-preview\.\d{8}\.\d+$/.test(version);
export const ASSISTANT_PREVIEW_APP_ID = "com.foredeck.assistant.preview";
export const ASSISTANT_PREVIEW_PRODUCT_NAME = "Foredeck Assistant Preview";
