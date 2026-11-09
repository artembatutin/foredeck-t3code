import * as Schema from "effect/Schema";

/** Safe attachment failures that remain actionable when wrapped by turn startup. */
export class ProviderImageInputError extends Schema.TaggedError<ProviderImageInputError>()(
  "ProviderImageInputError",
  {
    reason: Schema.Literals(["unsupported_session", "unsupported_model", "unreadable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported_session":
        return "This provider session does not support images. Choose an image-capable provider or remove the image and retry.";
      case "unsupported_model":
        return "The selected model does not support images. Choose an image-capable model or remove the image and retry.";
      case "unreadable":
        return "The attached image could not be read from this environment's storage. Remove it, attach it again, and retry.";
    }
  }
}

export const isProviderImageInputError = Schema.is(ProviderImageInputError);
