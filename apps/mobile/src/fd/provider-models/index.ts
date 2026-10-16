import type { ServerProviderModel } from "@t3tools/contracts";

export function modelMetadataSubtitle(
  model:
    | Pick<
        ServerProviderModel,
        "subProvider" | "costSummary" | "contextWindow" | "maxOutputTokens" | "supportsImages"
      >
    | undefined,
): string {
  return [
    model?.subProvider,
    model?.supportsImages === false ? "Text only" : null,
    model?.costSummary ? `Estimate: ${model.costSummary}` : null,
    model?.contextWindow ? `${model.contextWindow.toLocaleString()} context tokens` : null,
    model?.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString()} max output tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
