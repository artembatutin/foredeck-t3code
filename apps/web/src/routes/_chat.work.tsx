import { createFileRoute } from "@tanstack/react-router";

import { FactoryItemSection, FactoryStartDialogAction } from "~/fd/factory";
import { validateWorkSearch, WorkRouteView } from "~/fd/work-management";

export const Route = createFileRoute("/_chat/work")({
  validateSearch: validateWorkSearch,
  component: WorkRoute,
});

function WorkRoute() {
  return (
    <WorkRouteView
      search={Route.useSearch()}
      itemSection={FactoryItemSection}
      startAction={FactoryStartDialogAction}
    />
  );
}
