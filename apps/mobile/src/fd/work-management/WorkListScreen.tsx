import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  itemInView,
  linksByItem,
  refreshWork,
  RUN_STATE_LABELS,
  runStateOf,
  shouldAutoLoadWorkPage,
  WORK_VIEWS,
  type WorkPagedSource,
  type WorkRunState,
  type WorkView,
  workViewStatuses,
} from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type WorkItemSummary,
  type WorkSource,
  workItemRefString,
} from "@t3tools/contracts/fd/work-management";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { CreateWorkItemForm } from "./CreateWorkItemForm";
import { STATUS_LABELS, WorkRepairNotice } from "./shared";
import {
  useReadableWorkEnvironments,
  useWorkSupport,
  useWorkWritable,
  workCommands,
  workEnvironment,
} from "./state";

export type WorkListParams = {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
};

interface Row {
  readonly key: string;
  readonly source: WorkSource;
  readonly item: WorkItemSummary;
  readonly running: WorkRunState | undefined;
}

const EMPTY_LISTS = Atom.make([] as ReadonlyArray<WorkPagedSource>);

/** One project's Work items from every source, with a view filter and pull to refresh. */
export function WorkListScreen({ route }: StaticScreenProps<WorkListParams>) {
  const navigation = useNavigation();
  const support = useWorkSupport();
  const readable = useReadableWorkEnvironments();
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      [...allProjects]
        .filter((project) => readable.includes(project.environmentId) && !project.isScratch)
        .sort((left, right) => left.title.localeCompare(right.title)),
    [allProjects, readable],
  );
  const [selected, setSelected] = useState<{
    environmentId: EnvironmentId;
    projectId: ProjectId;
  } | null>(
    route.params?.environmentId !== undefined && route.params.projectId !== undefined
      ? { environmentId: route.params.environmentId, projectId: route.params.projectId }
      : null,
  );
  const project =
    projects.find(
      (candidate) =>
        selected !== null &&
        candidate.environmentId === selected.environmentId &&
        candidate.id === selected.projectId,
    ) ?? projects[0];
  const [view, setView] = useState<WorkView>("ready");
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: project === undefined ? "Work" : `Work · ${project.title}` });
  }, [navigation, project]);

  const sourcesQuery = useEnvironmentQuery(
    project === undefined
      ? null
      : workEnvironment.sources({
          environmentId: project.environmentId,
          input: { projectId: project.id, includeDisconnected: false },
        }),
  );
  const sources = useMemo(() => sourcesQuery.data?.sources ?? [], [sourcesQuery.data]);
  // Pages loaded so far; any change to what the list shows starts again from the first page.
  const listKey = `${project?.environmentId}|${project?.id}|${sources.map((source) => source.sourceId).join(",")}|${view}|${term}`;
  const [paging, setPaging] = useState({ key: listKey, pageCount: 1 });
  const pageCount = paging.key === listKey ? paging.pageCount : 1;
  const loadMore = useCallback(
    () => setPaging({ key: listKey, pageCount: pageCount + 1 }),
    [listKey, pageCount],
  );
  const listsAtom = useMemo(
    () =>
      project === undefined || sources.length === 0
        ? null
        : workEnvironment.pagedList({
            environmentId: project.environmentId,
            sources: sources.map((source) => ({ sourceId: source.sourceId, kind: source.kind })),
            search: term.length === 0 ? undefined : term,
            statuses: workViewStatuses(view),
            pageCount,
          }),
    [pageCount, project, sources, term, view],
  );
  const lists = useAtomValue(listsAtom ?? EMPTY_LISTS);
  const refreshLists = useAtomRefresh(listsAtom ?? EMPTY_LISTS);
  const linksQuery = useEnvironmentQuery(
    project === undefined
      ? null
      : workEnvironment.links({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        }),
  );
  const shells = useThreadShells();

  const rows = useMemo((): ReadonlyArray<Row> => {
    if (project === undefined) return [];
    const byThread = new Map(
      shells
        .filter((shell) => shell.environmentId === project.environmentId)
        .map((shell) => [shell.id, shell] as const),
    );
    const states = new Map<string, ReadonlyArray<WorkRunState>>();
    for (const [key, links] of linksByItem(linksQuery.data?.links ?? [])) {
      states.set(
        key,
        links.map((link) => runStateOf(byThread.get(link.threadId))),
      );
    }
    const sourceById = new Map(sources.map((source) => [source.sourceId, source] as const));
    return lists
      .flatMap(({ sourceId, pages }) => {
        const source = sourceById.get(sourceId);
        return source === undefined ? [] : pages.items.map((item) => ({ source, item }));
      })
      .filter(({ item }) => itemInView(view, item, states.get(workItemRefString(item.ref)) ?? []))
      .sort((left, right) => (right.item.updatedAt ?? "").localeCompare(left.item.updatedAt ?? ""))
      .map(({ source, item }) => {
        const key = workItemRefString(item.ref);
        return {
          key,
          source,
          item,
          running: (states.get(key) ?? []).find(
            (state) => state === "working" || state === "needs-input",
          ),
        };
      });
  }, [linksQuery.data, lists, project, shells, sources, view]);
  const pending = lists.some(({ pages }) => pages.waiting);
  const hasMore = lists.some(({ pages }) => pages.nextCursor !== null);
  const failures = lists.flatMap(({ sourceId, pages }) =>
    pages.failed ? [sources.find((source) => source.sourceId === sourceId)?.label ?? sourceId] : [],
  );
  // A filtered view that came up short reads further pages by itself, within a small budget.
  // Adjusted during render: each step raises the page count, so it settles within the budget.
  if (shouldAutoLoadWorkPage({ visible: rows.length, hasMore, waiting: pending, pageCount })) {
    setPaging({ key: listKey, pageCount: pageCount + 1 });
  }

  const requestRefresh = useAtomCommand(workCommands.refresh);
  const refreshSources = sourcesQuery.refresh;
  const refreshLinks = linksQuery.refresh;
  // Pull to refresh drops the server's caches, then refreshes this list's own queries.
  const refresh = useCallback(() => {
    if (project === undefined) return;
    void refreshWork({
      requestServerRefresh: () =>
        requestRefresh({ environmentId: project.environmentId, input: { projectId: project.id } }),
      refreshQueries: () => {
        refreshSources();
        refreshLinks();
        refreshLists();
      },
    });
  }, [project, refreshLinks, refreshLists, refreshSources, requestRefresh]);
  const canCreate = useWorkWritable(
    project?.environmentId ?? null,
    workCommands.createItem,
    "items.write",
  );
  const creatable = sources.filter((source) => source.capabilities.create);

  if (support.size === 0) {
    return (
      <View className="flex-1 items-center justify-center bg-screen p-6">
        <Text className="text-center text-foreground-muted">
          Connect to a server that offers Work.
        </Text>
      </View>
    );
  }
  if (readable.length === 0) return <WorkRepairNotice />;

  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row flex-wrap items-center gap-2 px-4 py-2">
        {projects.length > 1 ? (
          <ControlPillMenu
            accessibilityLabel="Choose a project"
            actions={projects.map((entry) => ({
              id: `${entry.environmentId}\u0000${entry.id}`,
              title: entry.title,
              state: entry === project ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => {
              const [environmentId, projectId] = nativeEvent.event.split("\u0000");
              if (environmentId && projectId) {
                setSelected({
                  environmentId: environmentId as EnvironmentId,
                  projectId: projectId as ProjectId,
                });
              }
            }}
          >
            <Pill label={project?.title ?? "Project"} />
          </ControlPillMenu>
        ) : null}
        <ControlPillMenu
          accessibilityLabel="Choose a view"
          actions={WORK_VIEWS.map((entry) => ({
            id: entry.value,
            title: entry.label,
            state: entry.value === view ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = WORK_VIEWS.find((entry) => entry.value === nativeEvent.event);
            if (next) setView(next.value);
          }}
        >
          <Pill label={WORK_VIEWS.find((entry) => entry.value === view)?.label ?? "Ready"} />
        </ControlPillMenu>
        {canCreate && creatable.length > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setCreating((open) => !open)}>
            <Pill label={creating ? "Close" : "New item"} />
          </Pressable>
        ) : null}
      </View>
      <View className="px-4 pb-2">
        <AppTextInput
          accessibilityLabel="Search work"
          className="min-h-10 rounded-xl bg-card px-3 text-base text-foreground"
          placeholder="Search"
          value={query}
          autoCapitalize="none"
          returnKeyType="search"
          onChangeText={setQuery}
        />
      </View>
      {creating && project !== undefined ? (
        <CreateWorkItemForm
          environmentId={project.environmentId}
          sources={creatable}
          onCancel={() => setCreating(false)}
          onCreated={(item) => {
            setCreating(false);
            navigation.navigate("WorkItem", {
              environmentId: project.environmentId,
              projectId: project.id,
              sourceId: item.ref.sourceId,
              itemId: item.ref.itemId,
            });
          }}
        />
      ) : null}
      {failures.length > 0 ? (
        <Text className="px-4 text-sm text-destructive">Could not read {failures.join(", ")}.</Text>
      ) : null}
      {sources.length === 0 && sourcesQuery.data !== null ? (
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-center text-foreground-muted">
            This project has no Work sources. Add one in the project's settings.
          </Text>
        </View>
      ) : (
        <LegendList
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16 }}
          contentInsetAdjustmentBehavior="automatic"
          data={rows}
          estimatedItemSize={88}
          keyExtractor={(row) => row.key}
          recycleItems
          itemsAreEqual={(left, right) =>
            left.key === right.key &&
            left.item.revision === right.item.revision &&
            left.running === right.running
          }
          ListEmptyComponent={
            pending ? null : (
              <Text className="py-8 text-center text-foreground-muted">
                {hasMore ? "Nothing here yet. Scroll to load more." : "Nothing here."}
              </Text>
            )
          }
          onEndReached={() => {
            if (hasMore && !pending) loadMore();
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            hasMore ? (
              <Pressable
                accessibilityRole="button"
                disabled={pending}
                className="items-center py-4 active:opacity-70"
                onPress={loadMore}
              >
                <Text className="text-sm text-foreground-muted">
                  {pending ? "Loading…" : "Load more"}
                </Text>
              </Pressable>
            ) : null
          }
          refreshControl={
            <RefreshControl refreshing={pending && rows.length > 0} onRefresh={refresh} />
          }
          renderItem={({ item: row }) => (
            <Pressable
              accessibilityRole="button"
              className="gap-1 border-b border-separator py-3 active:opacity-70"
              onPress={() =>
                project !== undefined &&
                navigation.navigate("WorkItem", {
                  environmentId: project.environmentId,
                  projectId: project.id,
                  sourceId: row.item.ref.sourceId,
                  itemId: row.item.ref.itemId,
                })
              }
            >
              <View className="flex-row items-center gap-2">
                <Text className="text-xs text-foreground-muted">{row.item.key}</Text>
                <Text className="text-xs text-foreground-muted">
                  {row.item.nativeStatus?.name ?? STATUS_LABELS[row.item.status]}
                </Text>
                {row.item.blocked ? <Text className="text-xs text-warning">Blocked</Text> : null}
                {row.running ? (
                  <Text className="text-xs text-primary">{RUN_STATE_LABELS[row.running]}</Text>
                ) : null}
              </View>
              <Text className="text-base text-foreground" numberOfLines={2}>
                {row.item.title}
              </Text>
              {row.item.labels.length > 0 ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {row.item.labels.slice(0, 3).join(" · ")}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <View className="rounded-full bg-subtle-strong px-3 py-1.5">
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </View>
  );
}
