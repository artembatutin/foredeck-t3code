import type {
  ModelSelection,
  ProviderOptionDescriptor,
  SelectProviderOptionDescriptor,
} from "@t3tools/contracts";
import type { FactoryTaskRisk } from "@t3tools/contracts/fd/factory";

/**
 * The select options providers name a model's effort with: `effort` (Claude, Cursor),
 * `reasoningEffort` (Codex, Grok, Muse), `reasoning` (Cursor), `variant` (OpenCode's reasoning
 * variants) and `thinking` (Pi's levels). ACP registry agents name theirs freely and their
 * descriptors do not keep the `thought_level` category, so their turns are not escalated.
 */
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set([
  "effort",
  "reasoningEffort",
  "reasoning",
  "variant",
  "thinking",
]);

const isEffortOption = (
  descriptor: ProviderOptionDescriptor,
): descriptor is SelectProviderOptionDescriptor =>
  descriptor.type === "select" && EFFORT_OPTION_IDS.has(descriptor.id);

/**
 * The model selection for one turn (port of Looper's escalation). Turns of a high-risk task and
 * turns of a second or later round raise the model's effort option to `highRiskEffort` when its
 * option descriptors offer that value. The selection is returned unchanged otherwise, and when
 * it already asks for that value or a higher one: descriptors list effort values from lowest to
 * highest, so escalation never lowers an effort the owner chose.
 */
export const escalateEffort = (input: {
  readonly selection: ModelSelection;
  /** The selected model's option descriptors; undefined when its provider lists none. */
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  /** The turn's round, from 1. */
  readonly round: number;
  readonly risk: FactoryTaskRisk;
  readonly highRiskEffort: string;
}): ModelSelection => {
  const { selection, highRiskEffort } = input;
  if (input.round < 2 && input.risk !== "high") return selection;
  const descriptor = input.descriptors?.find(isEffortOption);
  if (descriptor === undefined) return selection;
  const values = descriptor.options.map((option) => option.id);
  const target = values.indexOf(highRiskEffort);
  if (target === -1) return selection;

  const chosen = selection.options?.find((option) => option.id === descriptor.id)?.value;
  const current =
    typeof chosen === "string"
      ? chosen
      : (descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id);
  if (current !== undefined && values.indexOf(current) >= target) return selection;
  return {
    ...selection,
    options: [
      ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
      { id: descriptor.id, value: highRiskEffort },
    ],
  };
};
