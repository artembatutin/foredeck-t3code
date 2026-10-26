import { createFileRoute } from "@tanstack/react-router";

import { FactoryRouteView } from "~/fd/factory";

export const Route = createFileRoute("/_chat/factory")({
  component: FactoryRouteView,
});
