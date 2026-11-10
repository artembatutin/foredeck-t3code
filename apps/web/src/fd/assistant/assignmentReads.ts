import { useAtomValue } from "@effect/atom-react";
import {
  factoryDeliveryFamily,
  type FactoryDeliveryFamily,
} from "@t3tools/client-runtime/fd/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import { FactoryDeliveryId } from "@t3tools/contracts/fd/factory";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironmentQuery } from "../../state/query";
import { factoryEnvironment } from "../factory";
import { useWorkReadable, workEnvironment } from "../work-management";
import type { OverviewEpochs } from "./overviewEpochs";

const IDLE = Atom.make(AsyncResult.initial<number, never>()).pipe(
  Atom.withLabel("assistant:overview-epoch-idle"),
);

/**
 * The change epochs the assistant overview is built from, followed while the caller is mounted.
 * The streams are the ones every Factory and Work read already shares, so this opens none of its
 * own where a view already follows them; Work's stays idle where Work cannot be read.
 */
export function useOverviewEpochs(environmentId: EnvironmentId): OverviewEpochs {
  const factory = useAtomValue(factoryEnvironment.changes({ environmentId, input: {} }));
  const workReadable = useWorkReadable(environmentId);
  const work = useAtomValue(
    workReadable ? workEnvironment.refreshes({ environmentId, input: {} }) : IDLE,
  );
  return {
    factory: Option.getOrNull(AsyncResult.value(factory)),
    work: Option.getOrNull(AsyncResult.value(work)),
  };
}

/**
 * What cancelling a Factory assignment's delivery ends, read only while its confirmation is open:
 * null while the delivery is being read, and `single` where it cannot be (a failed read, or a
 * server that no longer serves Factory), as Factory's own confirmation falls back.
 */
export function useFactoryCancelFamily(
  environmentId: EnvironmentId,
  deliveryId: string | null,
): FactoryDeliveryFamily | null {
  const supported = useAtomValue(factoryEnvironment.supported(environmentId));
  const query = useEnvironmentQuery(
    deliveryId === null || !supported
      ? null
      : factoryEnvironment.delivery({
          environmentId,
          input: { deliveryId: FactoryDeliveryId.make(deliveryId) },
        }),
  );
  if (query.data !== null) return factoryDeliveryFamily(query.data);
  return !supported || query.error !== null ? "single" : null;
}
