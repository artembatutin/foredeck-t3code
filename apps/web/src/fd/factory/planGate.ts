import { factoryPlanGate, type FactoryPlanGateInput } from "@t3tools/client-runtime/fd/factory";

import { deliveriesWithStarted, type FactoryDeliverInput } from "./deliver";

/**
 * The plan gate of an item's current delivery, counting a delivery a start in this session just
 * returned until the list holds it, as the item's section shows it (see `deliveriesWithStarted`).
 */
export const factoryItemPlanGate = (
  input: Omit<FactoryPlanGateInput, "deliveries"> &
    Pick<FactoryDeliverInput, "deliveries" | "started">,
) => factoryPlanGate({ ...input, deliveries: deliveriesWithStarted(input) });
