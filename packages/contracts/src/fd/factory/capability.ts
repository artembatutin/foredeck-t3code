import * as Schema from "effect/Schema";

// A major version change is incompatible; additive behavior arrives as a new optional field.
const FACTORY_VERSION = 1;

/** The Factory a server advertises. Fields a newer server adds are ignored by this build. */
export const FactoryCapability = Schema.Struct({ version: Schema.Int });
export type FactoryCapability = typeof FactoryCapability.Type;

export interface FactorySupport {
  readonly version: typeof FACTORY_VERSION;
}

/**
 * The Factory an environment advertises, or undefined when it advertises none or another major
 * version: a client hides Factory on such a server rather than call methods it may not serve.
 */
export function factorySupport(capabilities: {
  readonly factory?: FactoryCapability | undefined;
}): FactorySupport | undefined {
  return capabilities.factory?.version === FACTORY_VERSION
    ? { version: FACTORY_VERSION }
    : undefined;
}

/**
 * The capability this release's server advertises. It lives here, not in the server feature, so
 * the environment descriptor imports a constant rather than the whole Factory runtime.
 */
export const FACTORY_CAPABILITY: FactoryCapability = { version: FACTORY_VERSION };
