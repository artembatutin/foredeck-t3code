import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  itemInView,
  linksByItem,
  readWorkListPreferences,
  refreshWork,
  RUN_STATE_LABELS,
  runStateOf,
  shouldAutoLoadWorkPage,
  WORK_VIEWS,
  type WorkPagedSource,
  type WorkRunState,
  type WorkView,
  workViewStatuses,
  writeWorkListPreferences,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  parseWorkItemRefString,
  type WorkItemSummary,
  type WorkSource,
  workItemRefString,
} from "@t3tools/contracts/fd/work-management";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  EmptyTitle,
} from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { RefreshIcon } from "../../components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset } from "../../components/ui/sidebar";
import { Skeleton } from "../../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { isElectron } from "../../env";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog";
import { SOURCE_KIND_LABELS, WorkRepairNotice, WorkSourceGlyph, WorkStatusBadge } from "./shared";
import {
  useReadableWorkEnvironments,
  useWorkSupport,
  useWorkWritable,
  workCommands,
  workEnvironment,
} from "./state";
import type { StartWorkThreadAction } from "./StartWorkThreadDialog";
import { WorkItemDetail, type WorkItemSection } from "./WorkItemDetail";

const PREFERENCES_KEY = "t3code:work-list-preferences";

export interface WorkSearch {
  /** `<environmentId>:<projectId>`, the scoped project key. */
  readonly project?: string;
  readonly source?: string;
  readonly view?: WorkView;
  readonly q?: string;
  /** `<sourceId>:<itemId>` of the item open in the detail column. */
  readonly item?: string;
}

const readStoredPreferences = () => {
  try {
    return readWorkListPreferences(window.localStorage.getItem(PREFERENCES_KEY));
  } catch {
    return readWorkListPreferences(null);
  }
};

export function validateWorkSearch(raw: Record<string, unknown>): WorkSearch {
  const text = (value: unknown, max = 200) =>
    typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
  const view = WORK_VIEWS.find((entry) => entry.value === raw.view)?.value;
  return {
    ...(text(raw.project, 400) === undefined ? {} : { project: text(raw.project, 400)! }),
    ...(text(raw.source) === undefined ? {} : { source: text(raw.source)! }),
    ...(view === undefined ? {} : { view }),
    ...(text(raw.q) === undefined ? {} : { q: text(raw.q)! }),
    ...(text(raw.item, 300) === undefined ? {} : { item: text(raw.item, 300)! }),
  };
}

/**
 * The Work page: one project's items from all of its sources, with an inline detail. The route
 * may pass `itemSection` for the detail to render beside the item's linked threads, and
 * `startAction` for the item's start dialog to offer.
 */
export function WorkRouteView({
  search,
  itemSection,
  startAction,
}: {
  search: WorkSearch;
  itemSection?: WorkItemSection;
  startAction?: StartWorkThreadAction;
}) {
  const navigate = useNavigate();
  const setSearch = useCallback(
    (patch: { readonly [Key in keyof WorkSearch]?: WorkSearch[Key] | undefined }) => {
      const next: Record<string, unknown> = { ...search, ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      void navigate({ to: "/work", search: next as WorkSearch, replace: true });
    },
    [navigate, search],
  );
  useEscapeToGoBack(search.item === undefined ? undefined : () => setSearch({ item: undefined }));

  const support = useWorkSupport();
  const readableEnvironments = useReadableWorkEnvironments();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter(
          (project) => readableEnvironments.includes(project.environmentId) && !project.isScratch,
        )
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, readableEnvironments],
  );
  const selectedProject =
    projects.find(
      (project) =>
        search.project !== undefined &&
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)) === search.project,
    ) ?? projects[0];
  const environmentId = selectedProject?.environmentId ?? null;
  const view = search.view ?? readStoredPreferences().view;
  const [query, setQuery] = useState(search.q ?? "");
  const [creating, setCreating] = useState<WorkSource | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((search.q ?? "") !== query.trim()) setSearch({ q: query.trim() || undefined });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, search.q, setSearch]);

  const setView = (next: WorkView) => {
    try {
      window.localStorage.setItem(
        PREFERENCES_KEY,
        writeWorkListPreferences({ ...readStoredPreferences(), view: next }),
      );
    } catch {
      // Storage is a convenience; the URL still carries the view.
    }
    setSearch({ view: next });
  };

  const sourcesQuery = useEnvironmentQuery(
    selectedProject === undefined
      ? null
      : workEnvironment.sources({
          environmentId: selectedProject.environmentId,
          input: { projectId: selectedProject.id, includeDisconnected: false },
        }),
  );
  const sources = useMemo(() => sourcesQuery.data?.sources ?? [], [sourcesQuery.data]);
  const shownSources = useMemo(
    () =>
      sources.filter((source) => search.source === undefined || source.sourceId === search.source),
    [search.source, sources],
  );

  const term = search.q?.trim() || undefined;
  // Pages loaded so far; any change to what the list shows starts again from the first page.
  const listKey = `${environmentId}|${shownSources.map((source) => source.sourceId).join(",")}|${view}|${term ?? ""}`;
  const [paging, setPaging] = useState({ key: listKey, pageCount: 1 });
  const pageCount = paging.key === listKey ? paging.pageCount : 1;
  const loadMore = useCallback(
    () => setPaging({ key: listKey, pageCount: pageCount + 1 }),
    [listKey, pageCount],
  );
  const listAtom = useMemo(
    () =>
      environmentId === null || shownSources.length === 0
        ? null
        : workEnvironment.pagedList({
            environmentId,
            sources: shownSources.map((source) => ({
              sourceId: source.sourceId,
              kind: source.kind,
            })),
            search: term,
            statuses: workViewStatuses(view),
            pageCount,
          }),
    [environmentId, pageCount, shownSources, term, view],
  );
  const lists = useAtomValue(listAtom ?? EMPTY_LISTS_ATOM);
  const refreshList = useAtomRefresh(listAtom ?? EMPTY_LISTS_ATOM);
  const linksQuery = useEnvironmentQuery(
    selectedProject === undefined
      ? null
      : workEnvironment.links({
          environmentId: selectedProject.environmentId,
          input: { projectId: selectedProject.id },
        }),
  );
  const shells = useThreadShells();
  const runStates = useMemo(() => {
    const byThread = new Map(
      shells
        .filter((shell) => shell.environmentId === environmentId)
        .map((shell) => [shell.id, shell] as const),
    );
    const states = new Map<string, ReadonlyArray<WorkRunState>>();
    for (const [key, links] of linksByItem(linksQuery.data?.links ?? [])) {
      states.set(
        key,
        links.map((link) => runStateOf(byThread.get(link.threadId))),
      );
    }
    return states;
  }, [environmentId, linksQuery.data, shells]);

  const sourceById = useMemo(
    () => new Map(shownSources.map((source) => [source.sourceId, source] as const)),
    [shownSources],
  );
  const pending = lists.some(({ pages }) => pages.waiting);
  const hasMore = lists.some(({ pages }) => pages.nextCursor !== null);
  const items = useMemo(
    () =>
      lists
        .flatMap(({ sourceId, pages }) => {
          const source = sourceById.get(sourceId);
          return source === undefined ? [] : pages.items.map((item) => ({ source, item }));
        })
        .filter(({ item }) =>
          itemInView(view, item, runStates.get(workItemRefString(item.ref)) ?? []),
        )
        .toSorted((left, right) =>
          (right.item.updatedAt ?? "").localeCompare(left.item.updatedAt ?? ""),
        ),
    [lists, runStates, sourceById, view],
  );
  // A filtered view that came up short reads further pages by itself, within a small budget.
  // Adjusted during render: each step raises the page count, so it settles within the budget.
  if (shouldAutoLoadWorkPage({ visible: items.length, hasMore, waiting: pending, pageCount })) {
    setPaging({ key: listKey, pageCount: pageCount + 1 });
  }
  const failures = lists.flatMap(({ sourceId, pages }) =>
    pages.failed ? [sourceById.get(sourceId)?.label ?? sourceId] : [],
  );
  const lastRefreshed = Math.max(0, ...lists.map(({ pages }) => pages.updatedAt));

  const requestRefresh = useAtomCommand(workCommands.refresh);
  const refreshSources = sourcesQuery.refresh;
  const refreshLinks = linksQuery.refresh;
  const projectId = selectedProject?.id;
  // Drops the server's caches (every client refetches through the refresh subscription) and
  // refreshes this view's own queries, for the button and the live interval alike.
  const refresh = useCallback(() => {
    if (environmentId === null) return;
    void refreshWork({
      requestServerRefresh: () =>
        requestRefresh({
          environmentId,
          input: projectId === undefined ? {} : { projectId },
        }),
      refreshQueries: () => {
        refreshSources();
        refreshLinks();
        refreshList();
      },
    });
  }, [environmentId, projectId, refreshLinks, refreshList, refreshSources, requestRefresh]);
  useLiveRefresh(environmentId === null ? null : refresh, {
    key: selectedProject?.id ?? "none",
  });
  const canCreate = useWorkWritable(environmentId, workCommands.createItem, "items.write");

  const selectedRef = search.item === undefined ? undefined : parseWorkItemRefString(search.item);
  const supported = support.size > 0;
  const readable = readableEnvironments.length > 0;

  const body = !supported ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Work is not available</EmptyTitle>
        <EmptyDescription>Connect to a server that offers Work.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : !readable ? (
    <WorkRepairNotice />
  ) : !projectsKnown ? (
    <ListSkeleton />
  ) : selectedProject === undefined ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No projects</EmptyTitle>
        <EmptyDescription>Add a project to track its work.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : sourcesQuery.data !== null && sources.length === 0 ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No Work sources</EmptyTitle>
        <EmptyDescription>
          Add a folder of Markdown tasks, a GitHub repository or a Jira project to this project.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          size="sm"
          onClick={() =>
            void navigate({
              to: "/settings/projects",
              // Settings key projects by checkout, not by id.
              search: { project: derivePhysicalProjectKey(selectedProject) } as never,
            })
          }
        >
          Add a source
        </Button>
      </EmptyContent>
    </Empty>
  ) : pending && items.length === 0 ? (
    <ListSkeleton />
  ) : (
    <>
      {sources
        .filter((source) => source.health.status !== "ok")
        .map((source) => (
          <p key={source.sourceId} className="text-sm text-warning-foreground">
            {source.label}: {source.health.message ?? source.health.status.replaceAll("_", " ")}
          </p>
        ))}
      {failures.length > 0 ? (
        <p className="text-destructive text-sm">Could not read {failures.join(", ")}.</p>
      ) : null}
      {items.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground text-sm">
          {pending ? "Loading..." : hasMore ? "Nothing here yet." : "Nothing here."}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Work items">
          {items.map(({ source, item }) => (
            <WorkItemRow
              key={workItemRefString(item.ref)}
              source={source}
              item={item}
              states={runStates.get(workItemRefString(item.ref)) ?? []}
              selected={
                selectedRef !== undefined &&
                selectedRef.sourceId === item.ref.sourceId &&
                selectedRef.itemId === item.ref.itemId
              }
              onSelect={() => setSearch({ item: workItemRefString(item.ref) })}
            />
          ))}
        </ul>
      )}
      {hasMore ? (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" disabled={pending} onClick={loadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader electron={isElectron} className="bg-background">
            <WorkspaceBreadcrumb ariaLabel="Work breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Work</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh work"
              title={
                lastRefreshed > 0
                  ? `Refreshed ${new Date(lastRefreshed).toLocaleTimeString()}`
                  : undefined
              }
              disabled={environmentId === null}
              onClick={refresh}
            >
              <RefreshIcon size="md" refreshing={pending} />
            </Button>
          </WorkspacePageHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="gap-4">
              {readable && selectedProject !== undefined ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={scopedProjectKey(
                      scopeProjectRef(selectedProject.environmentId, selectedProject.id),
                    )}
                    onValueChange={(value) =>
                      setSearch({ project: value as string, source: undefined, item: undefined })
                    }
                  >
                    <SelectTrigger aria-label="Project" className="w-48" size="sm">
                      <SelectValue>{selectedProject.title}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((project) => {
                        const key = scopedProjectKey(
                          scopeProjectRef(project.environmentId, project.id),
                        );
                        return (
                          <SelectItem key={key} value={key}>
                            {project.title}
                          </SelectItem>
                        );
                      })}
                    </SelectPopup>
                  </Select>
                  {sources.length > 1 ? (
                    <Select
                      value={search.source ?? "all"}
                      onValueChange={(value) =>
                        setSearch({ source: value === "all" ? undefined : (value as string) })
                      }
                    >
                      <SelectTrigger aria-label="Source" className="w-44" size="sm">
                        <SelectValue>
                          {sources.find((source) => source.sourceId === search.source)?.label ??
                            "All sources"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="all">All sources</SelectItem>
                        {sources.map((source) => (
                          <SelectItem key={source.sourceId} value={source.sourceId}>
                            {source.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  <ToggleGroup
                    aria-label="View"
                    value={[view]}
                    onValueChange={(next) => {
                      const value = WORK_VIEWS.find((entry) => entry.value === next[0]);
                      if (value) setView(value.value);
                    }}
                  >
                    {WORK_VIEWS.map((entry) => (
                      <Toggle key={entry.value} value={entry.value}>
                        {entry.label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                  <div className="min-w-40 flex-1">
                    <Input
                      aria-label="Search work"
                      placeholder="Search"
                      type="search"
                      value={query}
                      size="sm"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  {canCreate && sources.some((source) => source.capabilities.create) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setCreating(
                          shownSources.find((source) => source.capabilities.create) ??
                            sources.find((source) => source.capabilities.create) ??
                            null,
                        )
                      }
                    >
                      <PlusIcon />
                      New item
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {body}
            </WorkspacePageContainer>
          </div>
        </div>
        {selectedRef !== undefined && selectedProject !== undefined ? (
          <div className="w-[min(32rem,45%)] shrink-0 border-l">
            <WorkItemDetail
              key={search.item}
              environmentId={selectedProject.environmentId}
              projectId={selectedProject.id}
              itemRef={selectedRef}
              itemSection={itemSection}
              startAction={startAction}
              onClose={() => setSearch({ item: undefined })}
            />
          </div>
        ) : null}
      </div>
      {environmentId !== null ? (
        <CreateWorkItemDialog
          environmentId={environmentId as EnvironmentId}
          source={creating}
          onOpenChange={(open) => (open ? undefined : setCreating(null))}
          onCreated={(item) => setSearch({ item: workItemRefString(item.ref) })}
        />
      ) : null}
    </SidebarInset>
  );
}

const EMPTY_LISTS_ATOM = Atom.make([] as ReadonlyArray<WorkPagedSource>);

function ListSkeleton() {
  return (
    <div className="space-y-2" aria-busy>
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

function WorkItemRow({
  source,
  item,
  states,
  selected,
  onSelect,
}: {
  source: WorkSource;
  item: WorkItemSummary;
  states: ReadonlyArray<WorkRunState>;
  selected: boolean;
  onSelect: () => void;
}) {
  const running = states.find((state) => state === "working" || state === "needs-input");
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/50 aria-[current=true]:bg-accent"
        onClick={onSelect}
      >
        <WorkSourceGlyph kind={source.kind} className="size-4 shrink-0 text-muted-foreground" />
        <span className="w-20 shrink-0 truncate text-muted-foreground text-xs">{item.key}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
        {item.labels.slice(0, 3).map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
        {item.priority === "high" ? <Badge variant="warning">High</Badge> : null}
        {item.blocked ? <Badge variant="warning">Blocked</Badge> : null}
        {running ? <Badge variant="info">{RUN_STATE_LABELS[running]}</Badge> : null}
        <WorkStatusBadge
          status={item.status}
          {...(item.nativeStatus ? { label: item.nativeStatus.name } : {})}
        />
        <span className="sr-only">{SOURCE_KIND_LABELS[source.kind]}</span>
      </button>
    </li>
  );
}
