import type { FactoryStageKind } from "@t3tools/contracts/fd/factory";

import type { FactoryStageDefinition } from "../definitions.ts";
import type { FactoryAdvance, FactoryDeliveryState } from "../state.ts";
import { agentStage } from "./agent.ts";
import { commandStage } from "./command.ts";

/** One handler per stage kind. Handlers are pure, like the engine that calls them. */
export interface FactoryStageHandler<K extends FactoryStageKind> {
  readonly kind: K;
  /** Enters the stage: records it, what the delivery now awaits, and the effect doing its work. */
  readonly begin: (
    delivery: FactoryDeliveryState,
    stage: Extract<FactoryStageDefinition, { readonly kind: K }>,
  ) => FactoryAdvance;
}

export type FactoryStageLookup<K extends FactoryStageKind> =
  | { readonly type: "supported"; readonly handler: FactoryStageHandler<K> }
  | { readonly type: "unsupported"; readonly kind: K };

const registry: { readonly [K in FactoryStageKind]: FactoryStageLookup<K> } = {
  agent: { type: "supported", handler: agentStage },
  command: { type: "supported", handler: commandStage },
  gate: { type: "unsupported", kind: "gate" },
  integrate: { type: "unsupported", kind: "integrate" },
  pr: { type: "unsupported", kind: "pr" },
};

/** The handler for a stage kind, or `unsupported` for kinds this server cannot run yet. */
export const stageHandler = <K extends FactoryStageKind>(kind: K): FactoryStageLookup<K> =>
  registry[kind];
