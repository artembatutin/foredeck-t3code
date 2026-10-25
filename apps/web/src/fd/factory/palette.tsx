import { FactoryIcon } from "lucide-react";

import type { CommandPaletteActionItem } from "../../components/CommandPalette.logic";
import { ITEM_ICON_CLASS } from "../../components/CommandPalette.logic";
import { type FactoryDeliverInput, type FactoryDeliverTarget, factoryDeliverable } from "./deliver";

/** The item the Work page's detail shows, as its Factory section reports it. */
export interface FactoryOpenItem extends FactoryDeliverTarget {
  readonly key: string;
}

/**
 * The palette's Factory actions: Deliver for the item open in the Work page's detail, when the
 * shared Deliver rule allows it on that item's environment. Nothing elsewhere, since only the
 * Work page's detail reports an open item.
 */
export function factoryPaletteActions(input: {
  readonly openItem: FactoryOpenItem | null;
  /** What the Deliver rule reads of the open item's environment and project. */
  readonly destination: Omit<FactoryDeliverInput, "environmentId" | "itemRef">;
  readonly deliver: (target: FactoryDeliverTarget) => Promise<void>;
}): ReadonlyArray<CommandPaletteActionItem> {
  const { openItem } = input;
  if (openItem === null) return [];
  const { environmentId, projectId, itemRef, key } = openItem;
  if (!factoryDeliverable({ ...input.destination, environmentId, itemRef })) return [];
  return [
    {
      kind: "action",
      value: "action:factory-deliver",
      searchTerms: ["deliver", "factory", "work", "item", "pipeline", key],
      title: "Deliver work item",
      description: key,
      icon: <FactoryIcon className={ITEM_ICON_CLASS} />,
      run: () => input.deliver({ environmentId, projectId, itemRef }),
    },
  ];
}
