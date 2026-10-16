/** Native estimates stay visible independently of the truncated model label. */
export function ModelMetadata({
  model,
}: {
  model: {
    costSummary?: string | undefined;
    contextWindow?: number | undefined;
    maxOutputTokens?: number | undefined;
    supportsImages?: boolean | undefined;
  };
}) {
  if (
    !model.costSummary &&
    !model.contextWindow &&
    !model.maxOutputTokens &&
    model.supportsImages !== false
  )
    return null;
  return (
    <div className="mt-1 whitespace-normal text-2xs leading-snug text-muted-foreground">
      {model.supportsImages === false ? <div>Text only</div> : null}
      {model.costSummary ? <div>Estimate: {model.costSummary}</div> : null}
      {model.contextWindow || model.maxOutputTokens ? (
        <div>
          {[
            model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : "",
            model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString()} max output` : "",
          ]
            .filter(Boolean)
            .join(" · ")}{" "}
          tokens
        </div>
      ) : null}
    </div>
  );
}
