import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { WorkItemRef } from "@t3tools/contracts/fd/work-management";
import { FactoryIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { factoryDeliverable } from "./deliver";
import { useFactoryDeliverState, useFactoryStart } from "./hooks";

/**
 * Deliver in the Work start dialog's footer, offered by the shared Deliver rule. The Work route
 * passes it in; the dialog runs it under its pending state, closing on a start and showing the
 * refusal's text otherwise.
 */
export function FactoryStartDialogAction({
  environmentId,
  projectId,
  item,
  disabled,
  run,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly item: { readonly ref: WorkItemRef };
  readonly disabled: boolean;
  readonly run: (action: () => Promise<string | null>) => Promise<void>;
}) {
  const target = { environmentId, projectId, itemRef: item.ref };
  const { destination } = useFactoryDeliverState(target);
  const start = useFactoryStart();
  if (!factoryDeliverable({ ...destination, environmentId, itemRef: item.ref })) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => void run(() => start(target))}
    >
      <FactoryIcon />
      Deliver
    </Button>
  );
}
