import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  itemInView,
  linksByItem,
  normalizeWorkLabels,
  workFilterSources,
  readWorkListPreferences,
  refreshWork,
  RUN_STATE_LABELS,
  runStateOf,
  shouldAutoLoadWorkPage,
  WORK_VIEWS,
  workEmptyState,
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
import {
  CircleAlertIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Alert, AlertAction, AlertDescription } from "../../components/ui/alert";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { RefreshIcon } from "../../components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset } from "../../components/ui/sidebar";
import { Spinner } from "../../components/ui/spinner";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { isElectron } from "../../env";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { cn } from "../../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { FdListGhost, FdListRow } from "../list-rows";
import { CreateWorkItemDialog } from "./CreateWorkItemDialog";
import { WorkRepairNotice, WorkSourceGlyph, WorkStatusBadge } from "./shared";
import {
  useReadableWorkEnvironments,
  useWorkSupport,
  useWorkWritable,
  workCommands,
  workEnvironment,
} from "./state";
import { WorkLabelFilter } from "./WorkLabelFilter";
import { useWorkSearchInput } from "./useWorkSearchInput";
import type { StartWorkThreadAction } from "./StartWorkThreadDialog";
import { WorkItemDetail, type WorkItemSection } from "./WorkItemDetail";

const PREFERENCES_KEY = "t3code:work-list-preferences";

export interface WorkSearch {
  /** `<environmentId>:<projectId>`, the scoped project key. */
  readonly project?: string;
  readonly source?: string;
  readonly view?: WorkView;
  readonly q?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly assignedToMe?: boolean;
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
    ...(Array.isArray(raw.labels) && raw.labels.every((label) => typeof label === "string")
      ? { labels: normalizeWorkLabels(raw.labels) }
      : {}),
    ...(typeof raw.assignedToMe === "boolean" ? { assignedToMe: raw.assignedToMe } : {}),
    ...(text(raw.item, 300) === undefined ? {} : { item: text(raw.item, 300)! }),
  };
}

/**
 * The project a Work page shows: the one its URL names, in that exact environment, or the first
 * when it names none. A named project this client cannot read selects nothing, so a link never
 * shows another project's list or an item under the wrong project.
 */
export function selectWorkProject<Project extends Pick<EnvironmentProject, "environmentId" | "id">>(
  projects: ReadonlyArray<Project>,
  key: string | undefined,
): { readonly project: Project | undefined; readonly unavailable: boolean } {
  if (key === undefined) return { project: projects[0], unavailable: false };
  const project = projects.find(
    (entry) => scopedProjectKey(scopeProjectRef(entry.environmentId, entry.id)) === key,
  );
  return { project, unavailable: project === undefined };
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
  const { project: selectedProject, unavailable: projectUnavailable } = selectWorkProject(
    projects,
    search.project,
  );
  const environmentId = selectedProject?.environmentId ?? null;
  const view = search.view ?? readStoredPreferences().view;
  const commitQuery = useCallback((q: string | undefined) => setSearch({ q }), [setSearch]);
  const [query, setQuery] = useWorkSearchInput(search, commitQuery);
  const [creating, setCreating] = useState<WorkSource | null>(null);

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
  const selectedSources = useMemo(
    () =>
      sources.filter((source) => search.source === undefined || source.sourceId === search.source),
    [search.source, sources],
  );
  const canFilterAssignee = selectedSources.some((source) => source.capabilities.people);
  const assignedToMe =
    canFilterAssignee &&
    (search.assignedToMe ?? (search.item === undefined && readStoredPreferences().assignedToMe)) ===
      true;
  const shownSources = useMemo(
    () => workFilterSources(selectedSources, assignedToMe),
    [assignedToMe, selectedSources],
  );
  const labels = useMemo(() => [...(search.labels ?? [])], [search.labels]);
  const setAssignedToMe = (next: boolean) => {
    try {
      window.localStorage.setItem(
        PREFERENCES_KEY,
        writeWorkListPreferences({ ...readStoredPreferences(), assignedToMe: next }),
      );
    } catch {
      // The URL still carries the choice when storage is unavailable.
    }
    setSearch({ assignedToMe: next });
  };

  const term = search.q?.trim() || undefined;
  // Pages loaded so far; any change to what the list shows starts again from the first page.
  const listKey = `${environmentId}|${shownSources.map((source) => source.sourceId).join(",")}|${view}|${term ?? ""}|${JSON.stringify(labels)}|${assignedToMe}`;
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
            labels,
            assignee: assignedToMe ? "me" : undefined,
            statuses: workViewStatuses(view),
            pageCount,
          }),
    [assignedToMe, environmentId, labels, pageCount, shownSources, term, view],
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
  const listedItems = useMemo(
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
  const selectedRef = search.item === undefined ? undefined : parseWorkItemRefString(search.item);
  // All leaves nothing out, so an item open beside it that it does not list is further down than
  // this view reads by itself, however far that is. Its own read, the one the detail makes, lists
  // it first until the pages reach it. A search or another source can leave it out on purpose.
  const selectedOffList =
    view === "all" &&
    term === undefined &&
    labels.length === 0 &&
    !assignedToMe &&
    selectedRef !== undefined &&
    (search.source === undefined || search.source === selectedRef.sourceId) &&
    !listedItems.some(({ item }) => workItemRefString(item.ref) === search.item);
  const selectedItem = useEnvironmentQuery(
    environmentId === null || !selectedOffList
      ? null
      : workEnvironment.detail({ environmentId, input: { ref: selectedRef } }),
  ).data;
  const selectedSource =
    selectedItem === null ? undefined : sourceById.get(selectedItem.ref.sourceId);
  const items =
    selectedItem === null ||
    selectedSource === undefined ||
    (pending && listedItems.length === 0) ||
    listedItems.some(
      ({ item }) => workItemRefString(item.ref) === workItemRefString(selectedItem.ref),
    )
      ? listedItems
      : [{ source: selectedSource, item: selectedItem }, ...listedItems];
  // A filtered view that came up short reads further pages by itself, within a small budget.
  // Adjusted during render: each step raises the page count, so it settles within the budget.
  if (
    shouldAutoLoadWorkPage({
      visible: listedItems.length,
      hasMore,
      waiting: pending,
      pageCount,
    })
  ) {
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
  const refreshQueries = useCallback(() => {
    refreshSources();
    refreshLinks();
    refreshList();
  }, [refreshLinks, refreshList, refreshSources]);
  // The button drops the server's caches, and every client refetches through the refresh
  // subscription. Focus and the live interval refresh this view's queries alone.
  const refresh = useCallback(() => {
    if (environmentId === null) return;
    void refreshWork({
      requestServerRefresh: () =>
        requestRefresh({
          environmentId,
          input: projectId === undefined ? {} : { projectId },
        }),
      refreshQueries,
    });
  }, [environmentId, projectId, refreshQueries, requestRefresh]);
  useLiveRefresh(environmentId === null ? null : refreshQueries, {
    key: selectedProject?.id ?? "none",
  });
  const canCreate = useWorkWritable(environmentId, workCommands.createItem, "items.write");

  const supported = support.size > 0;
  const readable = readableEnvironments.length > 0;

  const empty = workEmptyState({ view, term, labels, assignedToMe });
  const clearFilters = () => {
    setQuery("");
    setSearch({ q: undefined, labels: undefined, assignedToMe: false });
  };
  const body = !supported ? (
    <Empty>
      <EmptyMedia variant="icon">
        <ListTodoIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Work is not available</EmptyTitle>
        <EmptyDescription>Connect to a server that offers Work.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : !readable ? (
    <WorkRepairNotice />
  ) : !projectsKnown ? (
    <ListSkeleton />
  ) : projectUnavailable ? (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Project unavailable</EmptyTitle>
        <EmptyDescription>
          This link names a project this client cannot read. Connect to its environment, or open
          Work for another project.
        </EmptyDescription>
      </EmptyHeader>
      {projects.length > 0 ? (
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSearch({
                project: undefined,
                source: undefined,
                view: undefined,
                item: undefined,
              })
            }
          >
            Open another project
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  ) : selectedProject === undefined ? (
    <Empty>
      <EmptyMedia variant="icon">
        <ListTodoIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No projects</EmptyTitle>
        <EmptyDescription>Add a project to track its work.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : sourcesQuery.data !== null && sources.length === 0 ? (
    <Empty>
      <EmptyMedia variant="icon">
        <ListTodoIcon />
      </EmptyMedia>
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
          <PlusIcon />
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
          <Alert key={source.sourceId} variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>
              {source.label}: {source.health.message ?? source.health.status.replaceAll("_", " ")}
            </AlertDescription>
          </Alert>
        ))}
      {failures.length > 0 ? (
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertDescription>Could not read {failures.join(", ")}.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" disabled={pending} onClick={refresh}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {items.length === 0 ? (
        pending ? (
          <ListSkeleton />
        ) : (
          <Empty>
            <EmptyMedia variant="icon">
              {empty.action === "clear-search" ? <SearchIcon /> : <ListTodoIcon />}
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{empty.title}</EmptyTitle>
              <EmptyDescription>{empty.detail}</EmptyDescription>
            </EmptyHeader>
            {empty.action === null ? null : (
              <EmptyContent>
                {empty.action === "show-all" ? (
                  <Button size="sm" variant="outline" onClick={() => setView("all")}>
                    Show all items
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    <XIcon />
                    {empty.action === "clear-search" ? "Clear search" : "Clear filters"}
                  </Button>
                )}
              </EmptyContent>
            )}
          </Empty>
        )
      ) : (
        <div className="space-y-0.5" role="list" aria-label="Work items">
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
              onSelect={() => setSearch({ item: workItemRefString(item.ref), assignedToMe })}
            />
          ))}
        </div>
      )}
      {hasMore ? (
        <div className="flex justify-center py-3 text-xs text-muted-foreground">
          {pending ? (
            <span className="flex items-center gap-2">
              <Spinner aria-hidden size="sm" />
              Loading more
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={loadMore}>
              Load more items
            </Button>
          )}
        </div>
      ) : null}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1">
        {/* On a narrow screen an open item replaces the list; closing it brings the list back. */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col bg-background",
            selectedRef !== undefined && selectedProject !== undefined && "max-md:hidden",
          )}
        >
          <WorkspacePageHeader electron={isElectron} className="bg-background">
            <WorkspaceBreadcrumb ariaLabel="Work breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Work</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
            {/* In the header so it holds its place whatever the filters below it show. */}
            {readable &&
            selectedProject !== undefined &&
            canCreate &&
            sources.some((source) => source.capabilities.create) ? (
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
                  <InputGroup className="min-w-40 basis-full sm:basis-0 sm:flex-1">
                    <InputGroupAddon>
                      <SearchIcon aria-hidden />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label="Search work"
                      placeholder="Search by title, key or label"
                      type="search"
                      size="sm"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </InputGroup>
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
                  <WorkLabelFilter
                    key={JSON.stringify([search.project, search.source, labels])}
                    labels={labels}
                    onApply={(next) => setSearch({ labels: next.length === 0 ? undefined : next })}
                  />
                  {canFilterAssignee ? (
                    <Button
                      size="sm"
                      variant={assignedToMe ? "secondary" : "outline"}
                      aria-pressed={assignedToMe}
                      onClick={() => setAssignedToMe(!assignedToMe)}
                    >
                      Assigned to me
                    </Button>
                  ) : null}
                  {labels.length > 0 || assignedToMe || term !== undefined ? (
                    <Button size="sm" variant="ghost" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {body}
            </WorkspacePageContainer>
          </div>
        </div>
        {selectedRef !== undefined && selectedProject !== undefined ? (
          <div className="w-[min(32rem,45%)] shrink-0 border-l max-md:w-full max-md:border-l-0">
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
  return <FdListGhost label="Loading work items" />;
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
    <div role="listitem">
      <FdListRow
        glyph={<WorkSourceGlyph kind={source.kind} className="size-4" />}
        reference={item.key}
        title={item.title}
        signals={
          <>
            {item.priority === "high" ? (
              <Badge size="sm" variant="warning">
                High
              </Badge>
            ) : null}
            {item.blocked ? (
              <Badge size="sm" variant="warning">
                Blocked
              </Badge>
            ) : null}
            {running ? (
              <Badge size="sm" variant="info">
                {RUN_STATE_LABELS[running]}
              </Badge>
            ) : null}
          </>
        }
        status={
          <WorkStatusBadge
            status={item.status}
            {...(item.nativeStatus ? { label: item.nativeStatus.name } : {})}
          />
        }
        meta={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{source.label}</span>
            {item.labels.length > 0 ? (
              <span className="truncate">· {item.labels.join(", ")}</span>
            ) : null}
            {item.assignee ? <span className="shrink-0">· {item.assignee.label}</span> : null}
          </span>
        }
        updatedAt={item.updatedAt}
        selected={selected}
        onSelect={onSelect}
      />
    </div>
  );
}
