import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { FactoryFleetRow } from "@t3tools/client-runtime/fd/factory";
import { useNavigate } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";
import { useMemo } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { SidebarInset } from "../../components/ui/sidebar";
import { Skeleton } from "../../components/ui/skeleton";
import { isElectron } from "../../env";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryFleetNotices, factoryFleetRowTarget } from "./fleetView";
import { useFactoryFleet, useRefreshFactoryFleet } from "./hooks";

/**
 * The Factory page: every active delivery across the connected environments that serve Factory,
 * those that need you first; a Factory server that is not connected is named instead. Each row
 * opens its item in the Work page.
 */
export function FactoryRouteView() {
  const navigate = useNavigate();
  const fleet = useFactoryFleet();
  useLiveRefresh(useRefreshFactoryFleet(), { key: "factory-fleet" });
  const projects = useProjects();
  const { environments } = useEnvironments();
  const projectTitles = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project.title,
        ]),
      ),
    [projects],
  );
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const notices = factoryFleetNotices(fleet, environmentLabels);
  const multipleEnvironments = fleet.environments.length > 1;

  const body = !notices.available ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Factory is not available</EmptyTitle>
        <EmptyDescription>Connect to a server that offers Factory.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : (
    <>
      {notices.failed !== null ? (
        <p className="text-destructive text-sm">{notices.failed}</p>
      ) : null}
      {notices.disconnected !== null ? (
        <p className="text-muted-foreground text-sm">{notices.disconnected}</p>
      ) : null}
      {fleet.rows.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Active deliveries">
          {fleet.rows.map((row) => (
            <FactoryFleetRowItem
              key={row.key}
              row={row}
              project={
                projectTitles.get(
                  scopedProjectKey(scopeProjectRef(row.environmentId, row.projectId)),
                ) ?? row.projectId
              }
              environment={
                multipleEnvironments
                  ? (environmentLabels.get(row.environmentId) ?? row.environmentId)
                  : undefined
              }
              onOpen={() => void navigate(factoryFleetRowTarget(row))}
            />
          ))}
        </ul>
      ) : fleet.loading ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : notices.empty !== null ? (
        <Empty>
          <EmptyMedia variant="icon">
            <FactoryIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{notices.empty}</EmptyTitle>
            <EmptyDescription>
              Deliver an item from Work, or review and start an idea with the assistant, and its
              progress shows here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/work" })}>
              Open Work
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <WorkspaceBreadcrumb ariaLabel="Factory breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Factory</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="gap-4">
            {body}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

function FactoryFleetRowItem({
  row,
  project,
  environment,
  onOpen,
}: {
  row: FactoryFleetRow;
  project: string;
  environment: string | undefined;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-accent/50"
        onClick={onOpen}
      >
        <span className="flex w-full items-center gap-3">
          <span className="w-40 shrink-0 truncate text-muted-foreground text-xs">
            {environment === undefined ? project : `${project} · ${environment}`}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{row.title}</span>
          <Badge variant={row.nextAction.forYou ? "warning" : "outline"}>
            {row.nextAction.title}
          </Badge>
        </span>
        {row.needsYou !== undefined ? (
          <span className="text-sm text-warning-foreground">{row.needsYou}</span>
        ) : null}
        <dl className="flex flex-wrap gap-x-3 text-xs" aria-label="Item facts">
          {row.facts.map((fact) => (
            <div key={fact.key} className="flex gap-1">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {row.capacityNote !== undefined ? (
          <span className="text-muted-foreground text-sm">{row.capacityNote}</span>
        ) : null}
      </button>
    </li>
  );
}
