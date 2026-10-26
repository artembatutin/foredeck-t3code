import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect } from "react";

import { toastManager } from "../../components/ui/toast";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type FactoryDeliverTarget,
  type FactoryDeliveryKind,
  factoryErrorText,
  type FactoryStartedDelivery,
  factoryStartRequest,
  recordStarted,
} from "./deliver";
import { type FactoryOpenItem, factoryPaletteActions } from "./palette";
import { factoryEnvironment } from "./state";

/** The deliveries starts in this session returned, shared by every Deliver entry point. */
const startedAtom = Atom.make<ReadonlyArray<FactoryStartedDelivery>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("factory:started"),
);

/** The item the Work page's detail shows; set by its Factory section while mounted. */
const openItemAtom = Atom.make<FactoryOpenItem | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("factory:open-work-item"),
);

const UNSUPPORTED = Atom.make(false).pipe(Atom.withLabel("factory:unsupported"));

/** What the shared Deliver rule reads of a target's destination; idle without a target. */
export function useFactoryDeliverState(target: FactoryDeliverTarget | null) {
  const environmentId = target?.environmentId ?? null;
  const supported = useAtomValue(
    environmentId === null ? UNSUPPORTED : factoryEnvironment.supported(environmentId),
  );
  const planning = useAtomValue(
    environmentId === null ? UNSUPPORTED : factoryEnvironment.planning(environmentId),
  );
  const connected = useConnectedEnvironmentIds().some((id) => id === environmentId);
  const startPermitted = useAtomValue(factoryEnvironment.start.permissionAtom(environmentId));
  const deliveriesQuery = useEnvironmentQuery(
    target === null
      ? null
      : factoryEnvironment.deliveries({
          environmentId: target.environmentId,
          input: { projectId: target.projectId },
        }),
  );
  const started = useAtomValue(startedAtom);
  return {
    destination: {
      supported,
      planning,
      connected,
      startPermitted,
      deliveries: deliveriesQuery.data?.deliveries ?? null,
      started,
    },
    deliveriesQuery,
  };
}

/**
 * The one start path of every Deliver entry point, single or parent. Resolves to null once the
 * delivery started, counted as open until the deliveries list holds it, or to the refusal's fixed
 * text.
 */
export function useFactoryStart(): (
  target: FactoryDeliverTarget,
  kind?: FactoryDeliveryKind,
) => Promise<string | null> {
  const start = useAtomCommand(factoryEnvironment.start);
  const setStarted = useAtomSet(startedAtom);
  return useCallback(
    async (target: FactoryDeliverTarget, kind?: FactoryDeliveryKind) => {
      const result = await start(factoryStartRequest(target, kind));
      if (result._tag === "Failure") return factoryErrorText(result.cause);
      setStarted((started) => recordStarted(started, target.environmentId, result.value));
      return null;
    },
    [setStarted, start],
  );
}

/** Reports the item the Work page's detail shows, for the palette, while the caller is mounted. */
export function useReportOpenWorkItem(item: FactoryOpenItem) {
  const setOpenItem = useAtomSet(openItemAtom);
  const { environmentId, projectId, itemRef, key } = item;
  const { sourceId, itemId } = itemRef;
  useEffect(() => {
    const reported: FactoryOpenItem = {
      environmentId,
      projectId,
      itemRef: { sourceId, itemId },
      key,
    };
    setOpenItem(reported);
    // Another item's detail may have reported itself first; only this report is withdrawn.
    return () => setOpenItem((current) => (current === reported ? null : current));
  }, [environmentId, itemId, key, projectId, setOpenItem, sourceId]);
}

/** The command palette's Factory actions; mounted by the palette. */
export function useFactoryPaletteActions() {
  const openItem = useAtomValue(openItemAtom);
  const { destination } = useFactoryDeliverState(openItem);
  const start = useFactoryStart();
  return factoryPaletteActions({
    openItem,
    destination,
    deliver: async (target, kind) => {
      const failure = await start(target, kind);
      if (failure !== null) {
        toastManager.add({
          type: "error",
          title: `Could not deliver ${openItem?.key ?? "the item"}`,
          description: failure,
        });
      }
    },
  });
}
