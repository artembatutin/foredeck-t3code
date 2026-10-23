import type { FactoryRole, FactoryStageName } from "@t3tools/contracts/fd/factory";

/**
 * A pipeline stage. Agent stages run a role's thread, and so do integrate stages (a fresh
 * reviewer over the whole branch); the other kinds run no thread.
 */
export type FactoryStageDefinition =
  | { readonly name: FactoryStageName; readonly kind: "agent"; readonly role: FactoryRole }
  | { readonly name: FactoryStageName; readonly kind: "integrate"; readonly role: FactoryRole }
  | { readonly name: FactoryStageName; readonly kind: "command" }
  | { readonly name: FactoryStageName; readonly kind: "gate" }
  | { readonly name: FactoryStageName; readonly kind: "pr" };

/** Stages in run order. A parent runs `perChild` once per approved child, in plan order. */
export interface FactoryPipeline {
  readonly id: string;
  readonly single: ReadonlyArray<FactoryStageDefinition>;
  readonly parent: {
    readonly beforeChildren: ReadonlyArray<FactoryStageDefinition>;
    readonly perChild: ReadonlyArray<FactoryStageDefinition>;
    readonly afterChildren: ReadonlyArray<FactoryStageDefinition>;
  };
}

/**
 * The standard pipeline's stages. `record` is a gate the server passes on its own: it admits
 * only the verified, reviewed commit. Plan approval is the one gate that waits for the owner.
 * `repair` has no place in the order; it is a turn on the author thread between verify or
 * review and the next verify.
 */
export const standardStages = {
  plan: { name: "plan", kind: "agent", role: "planner" },
  approve_plan: { name: "approve_plan", kind: "gate" },
  author: { name: "author", kind: "agent", role: "author" },
  verify: { name: "verify", kind: "command" },
  review: { name: "review", kind: "agent", role: "reviewer" },
  record: { name: "record", kind: "gate" },
  integrate: { name: "integrate", kind: "integrate", role: "reviewer" },
  pr: { name: "pr", kind: "pr" },
  follow_through: { name: "follow_through", kind: "pr" },
} as const satisfies Readonly<Record<Exclude<FactoryStageName, "repair">, FactoryStageDefinition>>;

/** The only pipeline the MVP ships; projects select it by `pipelineId`. */
export const standardPipeline: FactoryPipeline = {
  id: "standard",
  single: [
    standardStages.author,
    standardStages.verify,
    standardStages.review,
    standardStages.record,
    standardStages.pr,
    standardStages.follow_through,
  ],
  parent: {
    beforeChildren: [standardStages.plan, standardStages.approve_plan],
    perChild: [
      standardStages.author,
      standardStages.verify,
      standardStages.review,
      standardStages.record,
    ],
    afterChildren: [standardStages.integrate, standardStages.pr, standardStages.follow_through],
  },
};

/** The pipelines this server ships, by id. Project settings may select only these. */
export const pipelines: ReadonlyMap<string, FactoryPipeline> = new Map([
  [standardPipeline.id, standardPipeline],
]);
