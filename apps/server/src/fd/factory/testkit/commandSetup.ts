import * as Effect from "effect/Effect";

import * as FactoryCommandSetup from "../FactoryCommandSetup.ts";

/** For the transport tests of everything else; discovery and validation have their own. */
export const unusedCommandSetup = FactoryCommandSetup.FactoryCommandSetup.of({
  discover: () => Effect.die("not called in this test"),
  validate: () => Effect.die("not called in this test"),
});
