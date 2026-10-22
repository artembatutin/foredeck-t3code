import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

/** Discovery uses the same adapter capability as execution, including instance-specific restrictions. */
export const withRepositoryCapability = (
  instance: {
    readonly orchestrationAdapter: Pick<
      ProviderInstance["orchestrationAdapter"],
      "getCapabilities"
    >;
  },
  snapshot: ServerProvider,
) => {
  const withoutCapability = () => {
    if (snapshot.multiRepository === undefined) return snapshot;
    const result = { ...snapshot };
    delete result.multiRepository;
    return result;
  };
  return instance.orchestrationAdapter.getCapabilities().pipe(
    Effect.map((capabilities) =>
      capabilities.multiRepository
        ? { ...snapshot, multiRepository: capabilities.multiRepository }
        : withoutCapability(),
    ),
    Effect.orElseSucceed(withoutCapability),
  );
};
