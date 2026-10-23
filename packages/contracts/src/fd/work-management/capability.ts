import * as Schema from "effect/Schema";

import { ForwardCompatibleArray } from "../../baseSchemas.ts";
import { WorkSourceKind } from "./schemas.ts";

// A major version change is incompatible; additive behavior arrives as a new feature.
const WORK_MANAGEMENT_VERSION = 1;

export const WorkManagementFeature = Schema.Literals([
  "sources",
  "items.write",
  "comments",
  "links",
  "threads.start",
  "people",
]);
export type WorkManagementFeature = typeof WorkManagementFeature.Type;

/** Source kinds and features from a newer server are dropped instead of failing to decode. */
export const WorkManagementCapability = Schema.Struct({
  version: Schema.Int,
  sourceKinds: ForwardCompatibleArray(WorkSourceKind),
  features: ForwardCompatibleArray(WorkManagementFeature),
});
export type WorkManagementCapability = typeof WorkManagementCapability.Type;

export interface WorkManagementSupport {
  readonly sourceKinds: ReadonlySet<WorkSourceKind>;
  readonly features: ReadonlySet<WorkManagementFeature>;
}

/**
 * The Work an environment advertises, or undefined when it advertises none or another major
 * version. Only listed features are supported; nothing is implied by the version alone.
 */
export function workManagementSupport(capabilities: {
  readonly workManagement?: WorkManagementCapability | undefined;
}): WorkManagementSupport | undefined {
  const work = capabilities.workManagement;
  if (work?.version !== WORK_MANAGEMENT_VERSION) return undefined;
  return { sourceKinds: new Set(work.sourceKinds), features: new Set(work.features) };
}

/**
 * What a server advertises: `sourceKinds` lists only the adapters it registered and `features`
 * only what its handlers serve, so a client never shows a control the server refuses.
 */
export const workManagementCapability = (input: {
  readonly sourceKinds: ReadonlyArray<WorkSourceKind>;
  readonly features: ReadonlyArray<WorkManagementFeature>;
}): WorkManagementCapability => ({
  version: WORK_MANAGEMENT_VERSION,
  sourceKinds: input.sourceKinds,
  features: input.features,
});

/**
 * The capability this release's server advertises. It lives here, not in the server feature,
 * so the environment descriptor imports a constant rather than the whole Work runtime; the
 * server's feature test asserts its registered adapters match these kinds.
 */
export const WORK_MANAGEMENT_CAPABILITY: WorkManagementCapability = workManagementCapability({
  sourceKinds: ["markdown"],
  features: ["sources", "items.write", "comments", "links", "threads.start", "people"],
});
