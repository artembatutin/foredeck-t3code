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
import { ActivityIndicator, Pressable, RefreshControl, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ListFilterMenu } from "../../features/workspace/ListFilterMenu";
import { relativeTime } from "../../lib/time";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { CreateWorkItemForm } from "./CreateWorkItemForm";
import { STATUS_LABELS, STATUS_SYMBOLS, WorkRepairNotice } from "./shared";
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

  const openItem = useCallback(
    (row: Row) =>
      project !== undefined &&
      navigation.navigate("WorkItem", {
        environmentId: project.environmentId,
        projectId: project.id,
        sourceId: row.item.ref.sourceId,
        itemId: row.item.ref.itemId,
      }),
    [navigation, project],
  );

  if (support.size === 0) {
    return (
      <View className="flex-1 justify-center bg-screen">
        <EmptyState
          variant="plain"
          title="Work isn't available"
          detail="Connect to a server that offers Work to browse its items here."
        />
      </View>
    );
  }
  if (readable.length === 0) return <WorkRepairNotice />;
  if (project === undefined) {
    return (
      <View className="flex-1 justify-center bg-screen">
        <EmptyState
          variant="plain"
          title="No projects"
          detail="Add a project on a server that offers Work to see its items here."
        />
      </View>
    );
  }

  const viewLabel = WORK_VIEWS.find((entry) => entry.value === view)?.label ?? "Ready";
  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row flex-wrap items-center gap-2 px-4 pt-2 pb-3">
        {projects.length > 1 ? (
          <ListFilterMenu
            label={project.title}
            accessibilityLabel="Choose a project"
            actions={projects.map((entry) => ({
              id: `${entry.environmentId}\u0000${entry.id}`,
              title: entry.title,
              state: entry === project ? ("on" as const) : ("off" as const),
            }))}
            onSelect={(event) => {
              const [environmentId, projectId] = event.split("\u0000");
              if (environmentId && projectId) {
                setSelected({
                  environmentId: environmentId as EnvironmentId,
                  projectId: projectId as ProjectId,
                });
              }
            }}
          />
        ) : null}
        <ListFilterMenu
          label={viewLabel}
          accessibilityLabel="Choose a view"
          active={view !== "ready"}
          actions={WORK_VIEWS.map((entry) => ({
            id: entry.value,
            title: entry.label,
            state: entry.value === view ? ("on" as const) : ("off" as const),
          }))}
          onSelect={(event) => {
            const next = WORK_VIEWS.find((entry) => entry.value === event);
            if (next) setView(next.value);
          }}
        />
        {canCreate && creatable.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={creating ? "Close the new item form" : "New item"}
            hitSlop={6}
            className="h-8 flex-row items-center gap-1.5 rounded-full bg-subtle px-3 active:opacity-70"
            onPress={() => setCreating((open) => !open)}
          >
            <SymbolView
              name={creating ? "xmark" : "plus"}
              size={13}
              tintColorClassName="accent-icon-muted"
            />
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {creating ? "Close" : "New item"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View className="px-4 pb-2">
        <AppTextInput
          accessibilityLabel="Search work"
          className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
          placeholder="Search work"
          value={query}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          onChangeText={setQuery}
        />
      </View>
      {creating ? (
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
        <View className="px-4 pb-2">
          <ErrorBanner message={`Couldn't read ${failures.join(", ")}. Pull to try again.`} />
        </View>
      ) : null}
      {sourcesQuery.error !== null && sourcesQuery.data === null ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="Couldn't load Work sources"
            detail={sourcesQuery.error}
            actionLabel="Try again"
            onAction={refreshSources}
          />
        </View>
      ) : sources.length === 0 && sourcesQuery.data !== null ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="No Work sources"
            detail="Add a Markdown folder, GitHub repository or Jira project in this project's settings."
          />
        </View>
      ) : (
        <LegendList
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32 }}
          contentInsetAdjustmentBehavior="automatic"
          data={rows}
          // One title line measures about 66pt, two about 86pt.
          estimatedItemSize={76}
          keyExtractor={(row) => row.key}
          recycleItems
          itemsAreEqual={(left, right) =>
            left.key === right.key &&
            left.item.revision === right.item.revision &&
            left.running === right.running
          }
          ListEmptyComponent={
            pending || sourcesQuery.data === null ? (
              <View className="items-center py-12">
                <ActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading work" />
              </View>
            ) : (
              <EmptyState
                variant="plain"
                title={term.length > 0 ? "No results" : `Nothing ${viewLabel.toLowerCase()}`}
                detail={
                  hasMore
                    ? "Nothing matched in the items loaded so far. Scroll to load more."
                    : term.length > 0
                      ? "No items match your search in this view."
                      : "Choose another view to see more items."
                }
              />
            )
          }
          onEndReached={() => {
            if (hasMore && !pending) loadMore();
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            hasMore && rows.length > 0 ? (
              pending ? (
                <View className="items-center py-5">
                  <ActivityIndicator
                    colorClassName="accent-icon"
                    accessibilityLabel="Loading more work"
                  />
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  className="items-center py-4 active:opacity-70"
                  onPress={loadMore}
                >
                  <Text className="text-sm font-t3-medium text-link">Load more</Text>
                </Pressable>
              )
            ) : null
          }
          refreshControl={
            <RefreshControl refreshing={pending && rows.length > 0} onRefresh={refresh} />
          }
          renderItem={({ item: row }) => <WorkListRow row={row} onPress={openItem} />}
        />
      )}
    </View>
  );
}

/** One item, in the pull request list's row geometry: meta line, title, labels. */
function WorkListRow({ row, onPress }: { row: Row; onPress: (row: Row) => void }) {
  const { item } = row;
  const status = item.nativeStatus?.name ?? STATUS_LABELS[item.status];
  const symbol = STATUS_SYMBOLS[item.status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        item.key,
        item.title,
        status,
        item.blocked ? "blocked" : null,
        row.running ? RUN_STATE_LABELS[row.running] : null,
        row.source.label,
      ]
        .filter(Boolean)
        .join(", ")}
      className="flex-row gap-3 px-4 active:bg-row-hover"
      onPress={() => onPress(row)}
    >
      <View className="pt-2.5">
        <SymbolView name={symbol.icon} size={20} tintColorClassName={symbol.tint} />
      </View>
      <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
        <View className="flex-row items-center gap-1.5">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {item.key} <Text className="text-foreground-tertiary">· {status}</Text>
          </Text>
          {item.blocked ? (
            <Text className="text-2xs font-t3-medium text-warning">Blocked</Text>
          ) : null}
          {row.running ? (
            <Text className="text-2xs font-t3-medium text-primary-text">
              {RUN_STATE_LABELS[row.running]}
            </Text>
          ) : null}
          {item.updatedAt ? (
            <Text className="text-2xs tabular-nums text-foreground-tertiary">
              {relativeTime(item.updatedAt)}
            </Text>
          ) : null}
        </View>
        <Text
          className="text-base leading-5 font-t3-medium text-foreground"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {item.title}
        </Text>
        {item.labels.length > 0 ? (
          <View className="flex-row items-center gap-1">
            {item.labels.slice(0, 3).map((label) => (
              <View
                key={label}
                className="min-w-0 shrink rounded-md bg-subtle px-1.5 py-0.5"
                style={{ maxWidth: 140 }}
              >
                <Text className="text-2xs font-t3-medium text-foreground-muted" numberOfLines={1}>
                  {label}
                </Text>
              </View>
            ))}
            {item.labels.length > 3 ? (
              <Text className="shrink-0 text-2xs text-foreground-tertiary">
                +{item.labels.length - 3}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
