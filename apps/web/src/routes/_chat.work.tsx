import { createFileRoute } from "@tanstack/react-router";

import { validateWorkSearch, WorkRouteView } from "~/fd/work-management";

export const Route = createFileRoute("/_chat/work")({
  validateSearch: validateWorkSearch,
  component: WorkRoute,
});

function WorkRoute() {
  return <WorkRouteView search={Route.useSearch()} />;
}
