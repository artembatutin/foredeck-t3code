import * as Schema from "effect/Schema";

// A major version change is incompatible; additive behavior arrives as a new optional field.
const FACTORY_VERSION = 1;

/** The Factory a server advertises. Fields a newer server adds are ignored by this build. */
export const FactoryCapability = Schema.Struct({
  version: Schema.Int,
  /**
   * The plan gate's owner actions (`factory.plan.*`) and the pending plan on delivery snapshots.
   * Absent from servers from before planning, which serve neither.
   */
  planning: Schema.optionalKey(Schema.Boolean),
});
export type FactoryCapability = typeof FactoryCapability.Type;

export interface FactorySupport {
  readonly version: typeof FACTORY_VERSION;
  /** Whether the server serves the plan gate; a client offers no plan action when it does not. */
  readonly planning: boolean;
}

/**
 * The Factory an environment advertises, or undefined when it advertises none or another major
 * version: a client hides Factory on such a server rather than call methods it may not serve.
 */
export function factorySupport(capabilities: {
  readonly factory?: FactoryCapability | undefined;
}): FactorySupport | undefined {
  const { factory } = capabilities;
  return factory?.version === FACTORY_VERSION
    ? { version: FACTORY_VERSION, planning: factory.planning === true }
    : undefined;
}

/**
 * The capability this release's server advertises. It lives here, not in the server feature, so
 * the environment descriptor imports a constant rather than the whole Factory runtime.
 */
export const FACTORY_CAPABILITY: FactoryCapability = { version: FACTORY_VERSION, planning: true };
