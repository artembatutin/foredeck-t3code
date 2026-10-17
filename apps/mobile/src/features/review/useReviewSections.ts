import { repositoryHistoryGroups } from "@t3tools/client-runtime/fd/multirepo";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { environmentSession } from "../../state/session";
import { useCallback, useEffect, useMemo } from "react";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
  type ReviewSectionItem,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd, repositoryTarget, repositoryWorkspace } = useSelectedThreadWorktree();
  const repositoryId = repositoryWorkspace.isMultiRepository
    ? repositoryWorkspace.selected?.id
    : undefined;
  const history = useMemo(
    () =>
      repositoryWorkspace.isMultiRepository && selectedThread
        ? repositoryHistoryGroups(selectedThread.projection, null)
        : null,
    [repositoryWorkspace.isMultiRepository, selectedThread],
  );
  const diffPreview = useEnvironmentQuery(
    canReadFiles && enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd, repositoryTarget },
        })
      : null,
  );
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.data) {
      setReviewGitSections(reviewCache.threadKey, diffPreview.data.sources);
    }
  }, [diffPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () =>
      getReadyReviewCheckpoints(
        selectedThread === null
          ? []
          : deriveThreadCheckpointSummaries(selectedThread.projection, repositoryId),
      ),
    [selectedThread, repositoryId],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, ThreadCheckpointSummary>,
    [readyCheckpoints],
  );
  const reviewSections = useMemo(() => {
    const sections: ReviewSectionItem[] = [
      ...buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections:
          canReadFiles || fileAccess.isPending
            ? (diffPreview.data?.sources ?? reviewCache.gitSections)
            : [],
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
        loadingGitSections: fileAccess.isPending || diffPreview.isPending,
      }),
    ];
    if (history) {
      sections.unshift({
        id: "thread",
        kind: "thread",
        title: "Conversation",
        subtitle: "Recorded conversation snapshots",
        diff: reviewCache.turnDiffById.thread ?? null,
        isLoading: loadingTurnIds.thread === true,
      });
      const requested = reviewCache.selectedSectionId;
      if (
        requested &&
        /^turn:[1-9]\d*$/.test(requested) &&
        !sections.some((section) => section.id === requested)
      ) {
        sections.unshift({
          id: requested,
          kind: "turn",
          title: `Turn ${requested.slice(5)}`,
          subtitle: "Snapshot unavailable",
          diff: null,
          isLoading: false,
        });
      }
    }
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending
      ? sections.map((section) =>
          section.kind === "turn" || section.kind === "thread"
            ? section
            : { ...section, diff: null, isLoading: true },
        )
      : sections;
  }, [
    canReadFiles,
    diffPreview.data?.sources,
    diffPreview.isPending,
    fileAccess.isPending,
    loadingTurnIds,
    readyCheckpoints,
    history,
    reviewCache.selectedSectionId,
    reviewCache.gitSections,
    reviewCache.turnDiffById,
  ]);
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  const isFullThread = selectedSection?.kind === "thread";
  const isHistorySelection = selectedSection?.kind === "turn" || isFullThread;
  const activeCheckpoint =
    selectedSection?.kind === "turn"
      ? (checkpointBySectionId[selectedSection.id] ?? null)
      : (readyCheckpoints[0] ?? null);
  const activeTurnCount = isFullThread
    ? (history?.toTurnCount ?? null)
    : (activeCheckpoint?.checkpointTurnCount ??
      (selectedSection?.kind === "turn" ? Number(selectedSection.id.slice(5)) : null));
  const activeSectionId = isFullThread
    ? "thread"
    : selectedSection?.kind === "turn"
      ? selectedSection.id
      : activeCheckpoint
        ? getReviewSectionIdForCheckpoint(activeCheckpoint)
        : null;
  const queryEnabled =
    enabled &&
    (!repositoryWorkspace.isMultiRepository || isHistorySelection) &&
    (activeTurnCount ?? 0) > 0;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: queryEnabled ? (environmentId ?? null) : null,
    threadId: queryEnabled ? (threadId ?? null) : null,
    fromTurnCount:
      queryEnabled && activeTurnCount !== null
        ? isFullThread
          ? 0
          : Math.max(0, activeTurnCount - 1)
        : null,
    toTurnCount: queryEnabled ? activeTurnCount : null,
    ignoreWhitespace: false,
    repositoryId,
  });

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    setReviewTurnDiff(reviewCache.threadKey, activeSectionId, activeTurnDiff.data.diff);
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (isHistorySelection) {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  }, [activeTurnDiff, diffPreview, enabled, isHistorySelection]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    historyProjection: selectedThread?.projection ?? null,
    historyRunId: isFullThread
      ? null
      : (activeCheckpoint?.runId ??
        selectedThread?.projection.runs.find((run) => run.ordinal === activeTurnCount)?.id ??
        selectedThread?.projection.checkpoints.find(
          (checkpoint) => checkpoint.appRunOrdinal === activeTurnCount,
        )?.runId ??
        null),
    isHistorySelection,
    error:
      (isHistorySelection ? activeTurnDiff.error : diffPreview.error) ??
      reviewCache.asyncState.error ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? "This connection cannot read local diffs.")
        : null),
    isSelectedSectionPending: isHistorySelection ? activeTurnDiff.isPending : diffPreview.isPending,
    loadingGitDiffs: fileAccess.isPending || diffPreview.isPending,
    diffPreviewRevision: diffPreview.data
      ? DateTime.formatIso(diffPreview.data.generatedAt)
      : undefined,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}
