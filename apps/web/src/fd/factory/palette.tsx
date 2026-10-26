import { FactoryIcon } from "lucide-react";

import type { CommandPaletteActionItem } from "../../components/CommandPalette.logic";
import { ITEM_ICON_CLASS } from "../../components/CommandPalette.logic";
import {
  type FactoryDeliverInput,
  type FactoryDeliverTarget,
  type FactoryDeliveryKind,
  factoryDeliverable,
  factoryParentDeliverable,
} from "./deliver";

/** The item the Work page's detail shows, as its Factory section reports it. */
export interface FactoryOpenItem extends FactoryDeliverTarget {
  readonly key: string;
}

/** Open Factory, offered only while some environment advertises Factory. */
export function factoryOpenPaletteAction(input: {
  readonly supported: boolean;
  readonly open: () => Promise<void>;
}): ReadonlyArray<CommandPaletteActionItem> {
  if (!input.supported) return [];
  return [
    {
      kind: "action",
      value: "action:factory",
      searchTerms: ["factory", "deliveries", "pipeline", "needs you", "blocked", "waiting"],
      title: "Open Factory",
      icon: <FactoryIcon className={ITEM_ICON_CLASS} />,
      run: input.open,
    },
  ];
}

/**
 * The palette's Factory actions: Deliver for the item open in the Work page's detail, when the
 * shared Deliver rule allows it on that item's environment, and Deliver as parent where that
 * environment also plans. Nothing elsewhere, since only the Work page's detail reports an open
 * item.
 */
export function factoryPaletteActions(input: {
  readonly openItem: FactoryOpenItem | null;
  /** What the Deliver rule reads of the open item's environment and project. */
  readonly destination: Omit<FactoryDeliverInput, "environmentId" | "itemRef">;
  readonly deliver: (target: FactoryDeliverTarget, kind: FactoryDeliveryKind) => Promise<void>;
}): ReadonlyArray<CommandPaletteActionItem> {
  const { openItem } = input;
  if (openItem === null) return [];
  const { environmentId, projectId, itemRef, key } = openItem;
  const destination = { ...input.destination, environmentId, itemRef };
  if (!factoryDeliverable(destination)) return [];
  const target = { environmentId, projectId, itemRef };
  return [
    {
      kind: "action",
      value: "action:factory-deliver",
      searchTerms: ["deliver", "factory", "work", "item", "pipeline", key],
      title: "Deliver work item",
      description: key,
      icon: <FactoryIcon className={ITEM_ICON_CLASS} />,
      run: () => input.deliver(target, "single"),
    },
    ...(factoryParentDeliverable(destination)
      ? [
          {
            kind: "action" as const,
            value: "action:factory-deliver-parent",
            searchTerms: ["deliver", "factory", "parent", "plan", "children", "work", "item", key],
            title: "Deliver work item as parent",
            description: key,
            icon: <FactoryIcon className={ITEM_ICON_CLASS} />,
            run: () => input.deliver(target, "parent"),
          },
        ]
      : []),
  ];
}
