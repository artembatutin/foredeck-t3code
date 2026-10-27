import * as Schema from "effect/Schema";

export const MAX_PROMPT_OVERRIDE_BYTES = 64 * 1024;

export class FactoryPromptOverrideError extends Schema.TaggedError<FactoryPromptOverrideError>()(
  "FactoryPromptOverrideError",
  {
    prompt: Schema.Literals([
      "plan",
      "author",
      "review",
      "fix-verify",
      "fix-review",
      "fix-commit",
      "integrate",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Factory cannot use the ${this.prompt} prompt override. Fix or remove the override file and resume.`;
  }
}

export type FactoryPromptName = FactoryPromptOverrideError["prompt"];
export const isFactoryPromptOverrideError = Schema.is(FactoryPromptOverrideError);
